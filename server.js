require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'gps.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SESSION_COOKIE = 'gps_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

app.set('trust proxy', 1);

// ---------- Local account system (no third-party login needed) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Session secret: use SESSION_SECRET from .env, otherwise generate one once and keep it in the database.
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(48).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
  return secret;
}
const SESSION_SECRET = getSessionSecret();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSessionToken(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || data.exp < Math.floor(Date.now() / 1000)) return null;
    return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(data.uid) || null;
  } catch (_error) {
    return null;
  }
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function cookieHeader(req, value, maxAge = SESSION_MAX_AGE) {
  const secure = req.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function hasUsers() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

// Basic brute-force protection: 8 failed attempts per IP per 10 minutes.
const failedLogins = new Map();
function tooManyAttempts(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > 600000) return false;
  return entry.count >= 8;
}
function recordFailure(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > 600000) failedLogins.set(ip, { count: 1, first: Date.now() });
  else entry.count += 1;
}

function validateAccount({ name, email, password }) {
  if (!name || name.length > 80) return 'Please enter your name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Please enter a valid email address.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'smartphone',
    status TEXT NOT NULL DEFAULT 'offline',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed REAL DEFAULT 0,
    accuracy REAL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_locations_device_time ON locations(device_id, recorded_at DESC);
  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );
`);

const deviceCount = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
if (deviceCount === 0) {
  const seed = db.prepare('INSERT INTO devices (name, device_type, status) VALUES (?, ?, ?)').run('Demo tracker', 'smartphone', 'offline');
  const now = new Date();
  const demoPoints = [[6.5244, 3.3792], [6.5250, 3.3801], [6.5261, 3.3810], [6.5272, 3.3825]];
  const addLocation = db.prepare('INSERT INTO locations (device_id, latitude, longitude, speed, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
  demoPoints.forEach(([latitude, longitude], index) => addLocation.run(seed.lastInsertRowid, latitude, longitude, 18 + index * 4, 12, new Date(now.getTime() - (demoPoints.length - index) * 60000).toISOString()));
}

app.use(express.json({ limit: '32kb' }));

app.get('/api/auth/status', (req, res) => {
  res.json({ setupRequired: !hasUsers(), authenticated: Boolean(currentUser(req)) });
});

// First-run setup: only works while no account exists, and creates the first admin.
app.post('/api/auth/setup', (req, res) => {
  if (hasUsers()) return res.status(403).json({ error: 'Setup is already complete. Please sign in.' });
  const account = { name: String(req.body?.name || '').trim(), email: String(req.body?.email || '').trim().toLowerCase(), password: String(req.body?.password || '') };
  const problem = validateAccount(account);
  if (problem) return res.status(400).json({ error: problem });
  const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(account.name, account.email, hashPassword(account.password));
  res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken({ id: result.lastInsertRowid })));
  res.status(201).json({ ok: true });
});

// Public self-registration: creates a read-only 'viewer' account (only after the first admin exists).
const registrations = new Map();
app.post('/api/auth/register', (req, res) => {
  if (!hasUsers()) return res.status(403).json({ error: 'No administrator exists yet. Complete first-time setup first.' });
  const entry = registrations.get(req.ip);
  if (entry && Date.now() - entry.first < 3600000 && entry.count >= 5) return res.status(429).json({ error: 'Too many sign-ups from this network. Please try again later.' });
  const account = { name: String(req.body?.name || '').trim(), email: String(req.body?.email || '').trim().toLowerCase(), password: String(req.body?.password || '') };
  const problem = validateAccount(account);
  if (problem) return res.status(400).json({ error: problem });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(account.email)) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'viewer')").run(account.name, account.email, hashPassword(account.password));
  if (!entry || Date.now() - entry.first >= 3600000) registrations.set(req.ip, { count: 1, first: Date.now() }); else entry.count += 1;
  res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken({ id: result.lastInsertRowid })));
  res.status(201).json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Too many failed attempts. Please wait a few minutes and try again.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  failedLogins.delete(req.ip);
  res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken(user)));
  res.json({ ok: true });
});

function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}
app.post('/api/auth/logout', (req, res) => { logout(req, res); res.json({ ok: true }); });
app.get('/auth/logout', (req, res) => { logout(req, res); res.redirect('/login'); });

// Keep old URLs working so nothing ends in "Cannot GET".
app.get('/auth/login', (_req, res) => res.redirect('/login'));
app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));

app.get('/api/session', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get(['/', '/index.html'], requireAuth, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use(express.static(publicDir));

function normalizeDevice(row) {
  if (!row) return null;
  const latest = db.prepare('SELECT latitude, longitude, speed, accuracy, recorded_at FROM locations WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1').get(row.id);
  const status = latest && Date.now() - new Date(latest.recorded_at).getTime() < 120000 ? 'online' : 'offline';
  if (status !== row.status) db.prepare('UPDATE devices SET status = ? WHERE id = ?').run(status, row.id);
  return { ...row, status, latestLocation: latest || null };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'gps-system', time: new Date().toISOString() }));
app.get('/api/devices', requireAuth, (_req, res) => res.json(db.prepare('SELECT * FROM devices ORDER BY id ASC').all().map(normalizeDevice)));
app.post('/api/devices', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const deviceType = String(req.body?.deviceType || 'smartphone').trim();
  if (!name) return res.status(400).json({ error: 'Device name is required.' });
  const result = db.prepare('INSERT INTO devices (name, device_type) VALUES (?, ?)').run(name, deviceType);
  res.status(201).json(normalizeDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid)));
});
app.get('/api/devices/:id/locations', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(db.prepare('SELECT * FROM locations WHERE device_id = ? ORDER BY recorded_at ASC LIMIT ?').all(Number(req.params.id), limit));
});

// The phone tracker submits location updates without opening the admin dashboard.
app.post('/api/locations', (req, res) => {
  const deviceId = Number(req.body?.deviceId);
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  const speed = Number.isFinite(Number(req.body?.speed)) ? Number(req.body.speed) : 0;
  const accuracy = Number.isFinite(Number(req.body?.accuracy)) ? Number(req.body.accuracy) : null;
  if (!Number.isInteger(deviceId) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return res.status(400).json({ error: 'Valid deviceId, latitude, and longitude are required.' });
  if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)) return res.status(404).json({ error: 'Tracker not found.' });
  const recordedAt = new Date().toISOString();
  const result = db.prepare('INSERT INTO locations (device_id, latitude, longitude, speed, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(deviceId, latitude, longitude, speed, accuracy, recordedAt);
  db.prepare('UPDATE devices SET status = ? WHERE id = ?').run('online', deviceId);
  res.status(201).json({ id: result.lastInsertRowid, deviceId, latitude, longitude, speed, accuracy, recordedAt });
});

app.post('/api/trips/start', (req, res) => {
  const deviceId = Number(req.body?.deviceId);
  if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)) return res.status(404).json({ error: 'Tracker not found.' });
  db.prepare("UPDATE trips SET status = 'completed', ended_at = ? WHERE device_id = ? AND status = 'active'").run(new Date().toISOString(), deviceId);
  const result = db.prepare('INSERT INTO trips (device_id, started_at) VALUES (?, ?)').run(deviceId, new Date().toISOString());
  res.status(201).json({ id: result.lastInsertRowid, deviceId, status: 'active' });
});

app.post('/api/trips/end', (req, res) => {
  const deviceId = Number(req.body?.deviceId);
  const result = db.prepare("UPDATE trips SET status = 'completed', ended_at = ? WHERE device_id = ? AND status = 'active'").run(new Date().toISOString(), deviceId);
  if (!result.changes) return res.status(404).json({ error: 'No active trip found.' });
  res.json({ ok: true });
});
app.get('/api/trips', requireAuth, (_req, res) => res.json(db.prepare('SELECT trips.*, devices.name AS device_name FROM trips JOIN devices ON devices.id = trips.device_id ORDER BY trips.started_at DESC LIMIT 50').all()));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, '0.0.0.0', () => console.log(`GPS System running at http://0.0.0.0:${port}`));
