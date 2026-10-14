// Create an admin or reset a password from the command line:
//   node scripts/create-admin.js "Full Name" you@example.com "NewPassword123"
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const [name, emailRaw, password] = process.argv.slice(2);
if (!name || !emailRaw || !password) {
  console.error('Usage: node scripts/create-admin.js "Full Name" email password');
  process.exit(1);
}
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

const db = new Database(process.env.DB_FILE || path.join(__dirname, '..', 'gps.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

const salt = crypto.randomBytes(16);
const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const email = emailRaw.trim().toLowerCase();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?').run(name, hash, existing.id);
  console.log(`Password updated for ${email}`);
} else {
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(name, email, hash);
  console.log(`Admin created: ${email}`);
}
