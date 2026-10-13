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

const SESSION_COOKIE = 'webdev_app_session';
const STATE_COOKIE = 'gps_oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlJson(value) {
  return base64Url(JSON.stringify(value));
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64').toString('utf8');
}

function signSession(payload) {
  const secret = process.env.MANUS_JWT_SECRET;
  if (!secret || !process.env.MANUS_PROJECT_ID) throw new Error('Manus authentication environment is not configured.');
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifySession(token) {
  const secret = process.env.MANUS_JWT_SECRET;
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parts[2]);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) return null;
  try {
    const header = JSON.parse(decodeBase64Url(parts[0]));
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    if (header.alg !== 'HS256' || payload.appId !== process.env.MANUS_PROJECT_ID) return null;
    if (!payload.openId || (payload.exp && payload.exp < Math.floor(Date.now() / 1000))) return null;
    return payload;
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

function cookieHeader(name, value, maxAge = SESSION_MAX_AGE) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=None`;
}

function clearCookieHeader(name) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`;
}

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${protocol}://${req.get('host')}`;
}

function currentUser(req) {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.path === '/' || req.path === '/index.html') return res.redirect('/auth/login');
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

async function exchangeCode(code, redirectUri) {
  const apiUrl = process.env.MANUS_OAUTH_API_URL;
  const clientId = process.env.MANUS_PROJECT_ID;
  if (!apiUrl || !clientId) throw new Error('Manus OAuth is not configured for this deployment.');
  const tokenResponse = await fetch(`${apiUrl}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, grantType: 'authorization_code', code, redirectUri })
  });
  if (!tokenResponse.ok) throw new Error('The account sign-in code could not be exchanged.');
  const token = await tokenResponse.json();
  const userResponse = await fetch(`${apiUrl}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token.accessToken })
  });
  if (!userResponse.ok) throw new Error('The signed-in account could not be loaded.');
  return userResponse.json();
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

app.get('/auth/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  if (!process.env.MANUS_OAUTH_PORTAL_URL || !process.env.MANUS_PROJECT_ID || !process.env.MANUS_JWT_SECRET) {
    return res.status(503).send('Account sign-in is not configured for this deployment yet.');
  }
  const redirectUri = `${requestOrigin(req)}/manus-oauth/callback`;
  const nonce = crypto.randomBytes(24).toString('hex');
  const state = base64UrlJson({ redirectUri, nonce });
  res.setHeader('Set-Cookie', cookieHeader(STATE_COOKIE, nonce, 600));
  const url = new URL('/app-auth', process.env.MANUS_OAUTH_PORTAL_URL);
  url.searchParams.set('appId', process.env.MANUS_PROJECT_ID);
  url.searchParams.set('redirectUri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('responseType', 'code');
  res.redirect(url.toString());
});

app.get('/manus-oauth/callback', async (req, res) => {
  try {
    const state = JSON.parse(decodeBase64Url(String(req.query.state || '')));
    const cookies = parseCookies(req);
    if (!state.redirectUri || !state.nonce || cookies[STATE_COOKIE] !== state.nonce || !req.query.code) throw new Error('The sign-in state is invalid or expired.');
    const user = await exchangeCode(String(req.query.code), state.redirectUri);
    const now = Math.floor(Date.now() / 1000);
    const session = signSession({ appId: process.env.MANUS_PROJECT_ID, openId: user.openId, name: user.name || user.email || 'Account user', email: user.email || '', iat: now, exp: now + SESSION_MAX_AGE });
    res.setHeader('Set-Cookie', [cookieHeader(SESSION_COOKIE, session), clearCookieHeader(STATE_COOKIE)]);
    res.redirect('/');
  } catch (error) {
    res.status(401).send(`<h1>Sign-in failed</h1><p>${String(error.message || 'Please try again.')}</p><p><a href="/auth/login">Return to sign in</a></p>`);
  }
});

app.get('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearCookieHeader(SESSION_COOKIE));
  res.redirect('/auth/login');
});

app.get('/api/session', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: { openId: user.openId, name: user.name, email: user.email } });
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
app.post('/api/devices', requireAuth, (req, res) => {
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
