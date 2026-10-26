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
app.set('trust proxy', 1);

const SESSION_COOKIE = 'gps_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const newToken = () => crypto.randomBytes(24).toString('hex');
app.use(express.json({ limit: '32kb' }));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'smartphone',
    status TEXT NOT NULL DEFAULT 'offline',
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    tracking_token TEXT UNIQUE,
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
const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!deviceColumns.includes('owner_user_id')) db.exec('ALTER TABLE devices ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!deviceColumns.includes('tracking_token')) db.exec('ALTER TABLE devices ADD COLUMN tracking_token TEXT');
db.prepare("SELECT id FROM devices WHERE tracking_token IS NULL OR tracking_token = ''").all().forEach(({ id }) => db.prepare('UPDATE devices SET tracking_token = ? WHERE id = ?').run(newToken(), id));
const deviceCount = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
if (deviceCount === 0) {
  const seed = db.prepare('INSERT INTO devices (name, device_type, status, tracking_token) VALUES (?, ?, ?, ?)').run('Demo tracker', 'smartphone', 'offline', newToken());
  const now = new Date();
  const demoPoints = [[6.5244, 3.3792], [6.5250, 3.3801], [6.5261, 3.3810], [6.5272, 3.3825]];
  const addLocation = db.prepare('INSERT INTO locations (device_id, latitude, longitude, speed, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
  demoPoints.forEach(([latitude, longitude], index) => addLocation.run(seed.lastInsertRowid, latitude, longitude, 18 + index * 4, 12, new Date(now.getTime() - (demoPoints.length - index) * 60000).toISOString()));
}

function hashPassword(password) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password, stored) { const [scheme, saltHex, hashHex] = String(stored).split('$'); if (scheme !== 'scrypt' || !saltHex || !hashHex) return false; const expected = Buffer.from(hashHex, 'hex'); const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length); return expected.length === actual.length && crypto.timingSafeEqual(expected, actual); }
function sessionSecret() { if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET; const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get(); if (row) return row.value; const secret = newToken() + newToken(); db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret); return secret; }
const SESSION_SECRET = sessionSecret();
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function createSessionToken(user) { const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE })).toString('base64url'); return `${payload}.${sign(payload)}`; }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => { const index = part.indexOf('='); return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]; })); }
function currentUser(req) { const token = parseCookies(req)[SESSION_COOKIE]; if (!token) return null; const [payload, signature] = token.split('.'); if (!payload || !signature) return null; const expected = Buffer.from(sign(payload)); const actual = Buffer.from(signature); if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null; try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); if (!data.uid || data.exp < Math.floor(Date.now() / 1000)) return null; return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(data.uid) || null; } catch (_) { return null; } }
function cookieHeader(req, value, maxAge = SESSION_MAX_AGE) { const secure = req.secure ? '; Secure' : ''; return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`; }
function hasUsers() { return db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0; }
function requireAuth(req, res, next) { const user = currentUser(req); if (!user) { if (req.method === 'GET' && ['/','/index.html','/admin','/dashboard','/tracker.html'].includes(req.path)) return res.redirect('/login'); return res.status(401).json({ error: 'Authentication required.' }); } req.user = user; next(); }
function requireAdmin(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' }); next(); }
function validateAccount({ name, email, password }) { if (!name || name.length > 80) return 'Please enter your name.'; if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Please enter a valid email address.'; if (password.length < 8) return 'Password must be at least 8 characters.'; return null; }
function canAccessDevice(user, device) { return user.role === 'admin' || Number(device.owner_user_id) === Number(user.id); }
function getDeviceForRequest(req, tokenOrId) { const value = String(tokenOrId || ''); const device = value ? db.prepare('SELECT * FROM devices WHERE tracking_token = ? OR id = ?').get(value, Number(value) || -1) : null; return device && canAccessDevice(req.user, device) ? device : null; }
function normalizeDevice(row, includeToken = false) { const latest = db.prepare('SELECT latitude, longitude, speed, accuracy, recorded_at FROM locations WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1').get(row.id); const status = latest && Date.now() - new Date(latest.recorded_at).getTime() < 120000 ? 'online' : 'offline'; if (status !== row.status) db.prepare('UPDATE devices SET status = ? WHERE id = ?').run(status, row.id); const result = { id: row.id, name: row.name, device_type: row.device_type, status, owner_user_id: row.owner_user_id, created_at: row.created_at, latestLocation: latest || null }; if (includeToken) { result.trackingToken = row.tracking_token; result.trackerUrl = `/tracker.html?token=${encodeURIComponent(row.tracking_token)}`; } return result; }

app.get('/api/auth/status', (req, res) => res.json({ setupRequired: !hasUsers(), authenticated: Boolean(currentUser(req)) }));
app.post('/api/auth/setup', (req, res) => { if (hasUsers()) return res.status(403).json({ error: 'Setup is already complete. Please sign in.' }); const account = { name: String(req.body?.name || '').trim(), email: String(req.body?.email || '').trim().toLowerCase(), password: String(req.body?.password || '') }; const problem = validateAccount(account); if (problem) return res.status(400).json({ error: problem }); const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(account.name, account.email, hashPassword(account.password)); res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken({ id: result.lastInsertRowid }))); res.status(201).json({ ok: true }); });
app.post('/api/auth/register', (req, res) => { if (!hasUsers()) return res.status(403).json({ error: 'Complete first-time administrator setup first.' }); const account = { name: String(req.body?.name || '').trim(), email: String(req.body?.email || '').trim().toLowerCase(), password: String(req.body?.password || '') }; const problem = validateAccount(account); if (problem) return res.status(400).json({ error: problem }); if (db.prepare('SELECT id FROM users WHERE email = ?').get(account.email)) return res.status(409).json({ error: 'An account with this email already exists.' }); const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'viewer')").run(account.name, account.email, hashPassword(account.password)); res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken({ id: result.lastInsertRowid }))); res.status(201).json({ ok: true }); });
app.post('/api/auth/login', (req, res) => { const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || ''); const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email); if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' }); res.setHeader('Set-Cookie', cookieHeader(req, createSessionToken(user))); res.json({ ok: true }); });
function logout(req, res) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); }
app.post('/api/auth/logout', (req, res) => { logout(req, res); res.json({ ok: true }); });
app.get('/auth/logout', (req, res) => { logout(req, res); res.redirect('/login'); });
app.get('/auth/login', (_req, res) => res.redirect('/login'));
app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/api/session', requireAuth, (req, res) => res.json({ authenticated: true, user: req.user }));
app.get('/', requireAuth, (req, res) => res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard'));
app.get('/index.html', requireAuth, (req, res) => res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard'));
app.get('/admin', requireAuth, requireAdmin, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/dashboard', requireAuth, (_req, res) => res.sendFile(path.join(publicDir, 'user-dashboard.html')));
app.get('/tracker.html', requireAuth, (_req, res) => res.sendFile(path.join(publicDir, 'tracker.html')));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'gps-system', time: new Date().toISOString() }));

app.get('/api/users', requireAuth, requireAdmin, (_req, res) => res.json(db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all()));
app.get('/api/devices', requireAuth, (req, res) => { const rows = req.user.role === 'admin' ? db.prepare('SELECT * FROM devices ORDER BY id ASC').all() : db.prepare('SELECT * FROM devices WHERE owner_user_id = ? ORDER BY id ASC').all(req.user.id); res.json(rows.map((row) => normalizeDevice(row, req.user.role === 'admin'))); });
app.post('/api/devices', requireAuth, requireAdmin, (req, res) => { const name = String(req.body?.name || '').trim(); const deviceType = String(req.body?.deviceType || 'smartphone').trim(); const ownerUserId = Number(req.body?.ownerUserId) || null; if (!name) return res.status(400).json({ error: 'Device name is required.' }); if (ownerUserId && !db.prepare("SELECT id FROM users WHERE id = ? AND role = 'viewer'").get(ownerUserId)) return res.status(400).json({ error: 'Choose a valid viewer account.' }); const result = db.prepare('INSERT INTO devices (name, device_type, owner_user_id, tracking_token) VALUES (?, ?, ?, ?)').run(name, deviceType, ownerUserId, newToken()); const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid); res.status(201).json(normalizeDevice(row, true)); });
app.get('/api/devices/:id/locations', requireAuth, (req, res) => { const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(req.params.id)); if (!device || !canAccessDevice(req.user, device)) return res.status(404).json({ error: 'Tracker not found.' }); const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500); res.json(db.prepare('SELECT * FROM locations WHERE device_id = ? ORDER BY recorded_at ASC LIMIT ?').all(device.id, limit)); });
app.get('/api/tracker/context', requireAuth, (req, res) => { const token = String(req.query.token || ''); let device = token ? db.prepare('SELECT * FROM devices WHERE tracking_token = ?').get(token) : null; if (!device && req.user.role === 'viewer') device = db.prepare('SELECT * FROM devices WHERE owner_user_id = ? ORDER BY id LIMIT 1').get(req.user.id); if (!device || !canAccessDevice(req.user, device)) return res.status(404).json({ error: 'No tracker is assigned to this account or the tracker link is invalid.' }); res.json({ device: { id: device.id, name: device.name, device_type: device.device_type }, trackingToken: device.tracking_token }); });
function trackerFromBody(req) { return getDeviceForRequest(req, req.body?.trackingToken || req.body?.deviceId); }
app.post('/api/locations', requireAuth, (req, res) => { const device = trackerFromBody(req); const latitude = Number(req.body?.latitude); const longitude = Number(req.body?.longitude); const speed = Number.isFinite(Number(req.body?.speed)) ? Number(req.body.speed) : 0; const accuracy = Number.isFinite(Number(req.body?.accuracy)) ? Number(req.body?.accuracy) : null; if (!device || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return res.status(400).json({ error: 'Valid tracker and coordinates are required.' }); const recordedAt = new Date().toISOString(); const result = db.prepare('INSERT INTO locations (device_id, latitude, longitude, speed, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(device.id, latitude, longitude, speed, accuracy, recordedAt); db.prepare('UPDATE devices SET status = ? WHERE id = ?').run('online', device.id); res.status(201).json({ id: result.lastInsertRowid, deviceId: device.id, latitude, longitude, speed, accuracy, recordedAt }); });
app.post('/api/trips/start', requireAuth, (req, res) => { const device = trackerFromBody(req); if (!device) return res.status(404).json({ error: 'Tracker not found or not assigned to this account.' }); const now = new Date().toISOString(); db.prepare("UPDATE trips SET status = 'completed', ended_at = ? WHERE device_id = ? AND status = 'active'").run(now, device.id); const result = db.prepare('INSERT INTO trips (device_id, started_at) VALUES (?, ?)').run(device.id, now); res.status(201).json({ id: result.lastInsertRowid, deviceId: device.id, status: 'active' }); });
app.post('/api/trips/end', requireAuth, (req, res) => { const device = trackerFromBody(req); if (!device) return res.status(404).json({ error: 'Tracker not found or not assigned to this account.' }); const result = db.prepare("UPDATE trips SET status = 'completed', ended_at = ? WHERE device_id = ? AND status = 'active'").run(new Date().toISOString(), device.id); if (!result.changes) return res.status(404).json({ error: 'No active trip found.' }); res.json({ ok: true }); });
function haversineKm(a, b) { const rad = Math.PI / 180; const dLat = (b.latitude - a.latitude) * rad; const dLon = (b.longitude - a.longitude) * rad; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))); }
app.get('/api/trips', requireAuth, (req, res) => { const trips = req.user.role === 'admin' ? db.prepare('SELECT trips.*, devices.name AS device_name FROM trips JOIN devices ON devices.id = trips.device_id ORDER BY trips.started_at DESC LIMIT 50').all() : db.prepare('SELECT trips.*, devices.name AS device_name FROM trips JOIN devices ON devices.id = trips.device_id WHERE devices.owner_user_id = ? ORDER BY trips.started_at DESC LIMIT 50').all(req.user.id); const points = db.prepare('SELECT latitude, longitude FROM locations WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at ASC'); res.json(trips.map((trip) => { const rows = points.all(trip.device_id, trip.started_at, trip.ended_at || new Date().toISOString()); let distance = 0; for (let i = 1; i < rows.length; i += 1) distance += haversineKm(rows[i - 1], rows[i]); return { ...trip, points: rows.length, distance_km: Math.round(distance * 100) / 100 }; })); });

app.use(express.static(publicDir));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error.' }); });
app.listen(port, '0.0.0.0', () => console.log(`GPS System running at http://0.0.0.0:${port}`));
