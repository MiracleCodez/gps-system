require('dotenv').config();
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'gps.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  const demoPoints = [
    [6.5244, 3.3792], [6.5250, 3.3801], [6.5261, 3.3810], [6.5272, 3.3825]
  ];
  const addLocation = db.prepare('INSERT INTO locations (device_id, latitude, longitude, speed, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
  demoPoints.forEach(([latitude, longitude], index) => {
    addLocation.run(seed.lastInsertRowid, latitude, longitude, 18 + index * 4, 12, new Date(now.getTime() - (demoPoints.length - index) * 60000).toISOString());
  });
}

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeDevice(row) {
  if (!row) return null;
  const latest = db.prepare('SELECT latitude, longitude, speed, accuracy, recorded_at FROM locations WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1').get(row.id);
  const status = latest && Date.now() - new Date(latest.recorded_at).getTime() < 120000 ? 'online' : 'offline';
  if (status !== row.status) db.prepare('UPDATE devices SET status = ? WHERE id = ?').run(status, row.id);
  return { ...row, status, latestLocation: latest || null };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'gps-system', time: new Date().toISOString() }));

app.get('/api/devices', (_req, res) => {
  const rows = db.prepare('SELECT * FROM devices ORDER BY id ASC').all();
  res.json(rows.map(normalizeDevice));
});

app.post('/api/devices', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const deviceType = String(req.body?.deviceType || 'smartphone').trim();
  if (!name) return res.status(400).json({ error: 'Device name is required.' });
  const result = db.prepare('INSERT INTO devices (name, device_type) VALUES (?, ?)').run(name, deviceType);
  res.status(201).json(normalizeDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid)));
});

app.get('/api/devices/:id/locations', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const locations = db.prepare('SELECT * FROM locations WHERE device_id = ? ORDER BY recorded_at ASC LIMIT ?').all(Number(req.params.id), limit);
  res.json(locations);
});

app.post('/api/locations', (req, res) => {
  const deviceId = Number(req.body?.deviceId);
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  const speed = Number.isFinite(Number(req.body?.speed)) ? Number(req.body.speed) : 0;
  const accuracy = Number.isFinite(Number(req.body?.accuracy)) ? Number(req.body.accuracy) : null;
  if (!Number.isInteger(deviceId) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Valid deviceId, latitude, and longitude are required.' });
  }
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return res.status(404).json({ error: 'Tracker not found.' });
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

app.get('/api/trips', (_req, res) => {
  res.json(db.prepare(`SELECT trips.*, devices.name AS device_name FROM trips JOIN devices ON devices.id = trips.device_id ORDER BY trips.started_at DESC LIMIT 50`).all());
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, '0.0.0.0', () => console.log(`GPS System running at http://0.0.0.0:${port}`));
