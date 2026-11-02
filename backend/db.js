import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'floatchat.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'admin', 'warehouse_manager')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    message TEXT NOT NULL,
    channel TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_sid TEXT,
    error_message TEXT,
    mode TEXT
  );
`);

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Login id must be 3–32 characters: letters, numbers, dots, or underscores.');
  }
  return username;
}

export function normalizePhone(value) {
  let cleaned = String(value || '').trim().replace(/[^\d+]/g, '');
  if (!cleaned) throw new Error('Mobile number is required.');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
  if (!cleaned.startsWith('+')) {
    if (cleaned.length === 10) cleaned = `+91${cleaned}`;
    else if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = `+${cleaned}`;
    else cleaned = `+${cleaned}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    throw new Error('Enter a valid mobile number. A 10-digit Indian number is saved as +91.');
  }
  return cleaned;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== check.length) return false;
  return crypto.timingSafeEqual(stored, check);
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    createdAt: row.created_at
  };
}

function getRowById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

export function getPublicUserById(id) {
  return toPublicUser(getRowById(id));
}

export function countAdmins() {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n);
}

export function createUser({ username, fullName, phone, password, role }) {
  if (!['user', 'admin', 'warehouse_manager'].includes(role)) {
    throw new Error('That account type is not allowed.');
  }
  if (role === 'admin' && countAdmins() > 0) {
    throw new Error('An admin account already exists. Only one admin is allowed.');
  }

  const usernameNorm = normalizeUsername(username);
  const phoneNorm = normalizePhone(phone);
  const name = String(fullName || '').trim();
  if (name.length < 2) throw new Error('Full name is required.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');

  const { hash, salt } = hashPassword(password);
  try {
    const info = db.prepare(`
      INSERT INTO users (username, full_name, phone, password_hash, password_salt, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(usernameNorm, name, phoneNorm, hash, salt, role, new Date().toISOString());
    return getPublicUserById(info.lastInsertRowid);
  } catch (err) {
    const message = String(err.message || '');
    if (message.includes('users.username')) throw new Error('That login id is already taken.');
    if (message.includes('users.phone')) throw new Error('That mobile number is already registered.');
    throw new Error('Could not create the account.');
  }
}

export function authenticate(username, password) {
  let usernameNorm;
  try {
    usernameNorm = normalizeUsername(username);
  } catch {
    return null;
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(usernameNorm);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash, row.password_salt)) return null;
  return toPublicUser(row);
}

export function changePassword(userId, currentPassword, newPassword) {
  const row = getRowById(userId);
  if (!row) throw new Error('Account not found.');
  if (!verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
    throw new Error('Current password is incorrect.');
  }
  if (String(newPassword || '').length < 8) throw new Error('New password must be at least 8 characters.');
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, Number(userId));
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(toPublicUser);
}

export function listCitizenRecipients() {
  return db.prepare(`SELECT * FROM users WHERE role = 'user' ORDER BY full_name ASC`).all().map(toPublicUser);
}

export function recordAlert(entry) {
  db.prepare(`
    INSERT INTO alert_dispatches (
      created_at, message, channel, recipient_phone, recipient_name, status, provider_sid, error_message, mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    entry.message,
    entry.channel,
    entry.recipientPhone,
    entry.recipientName,
    entry.status,
    entry.providerSid || null,
    entry.errorMessage || null,
    entry.mode || null
  );
}

export function listAlerts(limit = 40) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 40));
  return db.prepare(`
    SELECT id, created_at AS createdAt, message, channel, recipient_phone AS recipientPhone,
           recipient_name AS recipientName, status, provider_sid AS providerSid,
           error_message AS errorMessage, mode
    FROM alert_dispatches
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit);
}

function seedAccounts() {
  if (countAdmins() === 0) {
    createUser({
      username: 'admin',
      fullName: 'FloatChat Administrator',
      phone: '+919000000001',
      password: 'FloatChatAdmin@2026',
      role: 'admin'
    });
    console.log('Seeded the single admin account (login id: admin).');
  }

  const warehouse = db.prepare(`SELECT id FROM users WHERE username = 'warehouse'`).get();
  if (!warehouse) {
    createUser({
      username: 'warehouse',
      fullName: 'Warehouse Manager',
      phone: '+919000000002',
      password: 'FloatChatWarehouse@2026',
      role: 'warehouse_manager'
    });
    console.log('Seeded the warehouse manager account (login id: warehouse).');
  }
}

seedAccounts();
