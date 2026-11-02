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

export const db = new DatabaseSync(DB_PATH);

// Initialize SQLite Schema
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- User authentication & RBAC
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

  -- Alert dispatches (Twilio audit logs)
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
    mode TEXT,
    anomaly_id TEXT,
    incident_id TEXT,
    is_simulated INTEGER DEFAULT 0
  );

  -- ML detected anomalies with provenance
  CREATE TABLE IF NOT EXISTS ml_anomalies (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    platform_id TEXT,
    profile_id TEXT,
    cycle_number INTEGER,
    observation_timestamp TEXT NOT NULL,
    detection_timestamp TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    depth REAL,
    pressure REAL,
    temperature REAL,
    salinity REAL,
    oxygen_content REAL,
    ph REAL,
    battery_level REAL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    anomaly_score REAL NOT NULL,
    isolation_forest_score REAL,
    standardized_euclidean_dist REAL,
    explanation TEXT,
    qc_status TEXT,
    is_simulated INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Telemetry observations (Argovis and local buoy sensor records)
  CREATE TABLE IF NOT EXISTS telemetry_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'local', -- 'argovis', 'local', 'uploaded'
    timestamp TEXT NOT NULL,
    buoy_id TEXT NOT NULL,
    buoy_name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    depth REAL NOT NULL,
    temperature REAL,
    pressure REAL,
    salinity REAL,
    oxygen_content REAL,
    ph REAL,
    battery_level REAL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_buoy ON telemetry_observations(buoy_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_observations(timestamp);

  -- Persistent Incidents & Sensor Alerts
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    buoy_id TEXT,
    buoy_name TEXT,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    timestamp TEXT NOT NULL,
    detected_value TEXT,
    threshold TEXT,
    ml_risk_score REAL,
    remediation_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_incident_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_incident_timestamp ON incidents(timestamp);

  -- Disaster Management: Scenarios
  CREATE TABLE IF NOT EXISTS disaster_scenarios (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    agency TEXT,
    instructions TEXT,
    details_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  );

  -- Verified Safe Shelters
  CREATE TABLE IF NOT EXISTS shelters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_meters REAL NOT NULL,
    total_capacity INTEGER NOT NULL,
    current_occupancy INTEGER NOT NULL,
    status TEXT NOT NULL,
    structure_rating TEXT,
    contact_phone TEXT,
    facilities_json TEXT NOT NULL,
    supplies_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Relief Warehouses & Fleets
  CREATE TABLE IF NOT EXISTS warehouses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_meters REAL NOT NULL,
    accessible_by_road INTEGER NOT NULL DEFAULT 1,
    inventory_json TEXT NOT NULL,
    transport_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Emergency SOS Records
  CREATE TABLE IF NOT EXISTS sos_records (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    user_name TEXT NOT NULL,
    phone TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_meters REAL,
    emergency_type TEXT NOT NULL,
    people_count_json TEXT NOT NULL,
    medical_notes TEXT,
    triage_score TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_unit_json TEXT,
    network_origin TEXT,
    hop_count INTEGER DEFAULT 0,
    gateway_ack INTEGER DEFAULT 1,
    gateway_receipt_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_records(status);
  CREATE INDEX IF NOT EXISTS idx_sos_timestamp ON sos_records(timestamp);

  -- Family Safety Check-In Registry
  CREATE TABLE IF NOT EXISTS family_checkins (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    phone TEXT NOT NULL,
    full_name TEXT NOT NULL,
    status TEXT NOT NULL,
    current_location_name TEXT,
    shelter_id TEXT,
    latitude REAL,
    longitude REAL,
    battery_percent REAL,
    message TEXT,
    via_mesh INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checkin_phone ON family_checkins(phone);
  CREATE INDEX IF NOT EXISTS idx_checkin_name ON family_checkins(full_name);

  -- Dispatched Relief Convoys
  CREATE TABLE IF NOT EXISTS convoys (
    id TEXT PRIMARY KEY,
    dispatched_at TEXT NOT NULL,
    eta_minutes INTEGER NOT NULL,
    source_warehouse_name TEXT NOT NULL,
    target_shelter_id TEXT NOT NULL,
    target_shelter_name TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    cargo_json TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL
  );

  -- First Responder SAR Fleet
  CREATE TABLE IF NOT EXISTS responder_units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    callsign TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    crew_count INTEGER NOT NULL,
    equipment TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    current_assignment TEXT
  );

  -- Disaster Management Audit Events
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ==========================================
// User Authentication & Roles
// ==========================================

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

// ==========================================
// Twilio Alert Dispatches Log
// ==========================================

export function recordAlert(entry) {
  try {
    db.prepare(`
      INSERT INTO alert_dispatches (
        created_at, message, channel, recipient_phone, recipient_name, status, provider_sid, error_message, mode, anomaly_id, incident_id, is_simulated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      entry.message,
      entry.channel,
      entry.recipientPhone,
      entry.recipientName,
      entry.status,
      entry.providerSid || null,
      entry.errorMessage || null,
      entry.mode || null,
      entry.anomalyId || null,
      entry.incidentId || null,
      entry.isSimulated ? 1 : 0
    );
  } catch {
    // Fallback for earlier schema if columns missing
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

// ==========================================
// Telemetry Observations (Argovis & Local Buoys)
// ==========================================

function rowToTelemetry(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    timestamp: row.timestamp,
    buoyId: row.buoy_id,
    buoyName: row.buoy_name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    depth: Number(row.depth),
    temperature: row.temperature !== null ? Number(row.temperature) : null,
    pressure: row.pressure !== null ? Number(row.pressure) : null,
    salinity: row.salinity !== null ? Number(row.salinity) : null,
    oxygenContent: row.oxygen_content !== null ? Number(row.oxygen_content) : null,
    ph: row.ph !== null ? Number(row.ph) : null,
    batteryLevel: row.battery_level !== null ? Number(row.battery_level) : null
  };
}

export function saveTelemetryRecords(records, source = 'local', replace = false) {
  if (!Array.isArray(records) || records.length === 0) return 0;

  if (replace) {
    db.prepare('DELETE FROM telemetry_observations').run();
  }

  const insert = db.prepare(`
    INSERT INTO telemetry_observations (
      source, timestamp, buoy_id, buoy_name, latitude, longitude, depth,
      temperature, pressure, salinity, oxygen_content, ph, battery_level, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const r of records) {
      insert.run(
        r.source || source,
        r.timestamp || now,
        r.buoyId || 'UNKNOWN',
        r.buoyName || 'Unknown Station',
        Number(r.latitude) || 0,
        Number(r.longitude) || 0,
        Number(r.depth) || 0,
        r.temperature !== undefined && r.temperature !== null ? Number(r.temperature) : null,
        r.pressure !== undefined && r.pressure !== null ? Number(r.pressure) : null,
        r.salinity !== undefined && r.salinity !== null ? Number(r.salinity) : null,
        r.oxygenContent !== undefined && r.oxygenContent !== null ? Number(r.oxygenContent) : null,
        r.ph !== undefined && r.ph !== null ? Number(r.ph) : null,
        r.batteryLevel !== undefined && r.batteryLevel !== null ? Number(r.batteryLevel) : null,
        now
      );
      count++;
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return count;
}

export function listTelemetryRecords(limit = 1000) {
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  return db.prepare(`
    SELECT * FROM telemetry_observations
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(safeLimit).map(rowToTelemetry);
}

export function countTelemetryRecords() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM telemetry_observations').get().n);
}

export function clearTelemetryRecords() {
  db.prepare('DELETE FROM telemetry_observations').run();
}

// ==========================================
// Incidents Persistence
// ==========================================

export function recordIncident(entry) {
  const id = entry.id || `INC-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO incidents (
      id, title, buoy_id, buoy_name, severity, status, timestamp, detected_value, threshold, ml_risk_score, remediation_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.title || 'Ocean Telemetry Incident',
    entry.buoyId || null,
    entry.buoyName || null,
    entry.severity || 'WARNING',
    entry.status || 'OPEN',
    entry.timestamp || now,
    entry.detectedValue || null,
    entry.threshold || null,
    entry.mlRiskScore !== undefined ? Number(entry.mlRiskScore) : null,
    JSON.stringify(entry.remediationSteps || []),
    now
  );
  return getIncidentById(id);
}

export function getIncidentById(id) {
  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    buoyId: row.buoy_id,
    buoyName: row.buoy_name,
    severity: row.severity,
    status: row.status,
    timestamp: row.timestamp,
    detectedValue: row.detected_value,
    threshold: row.threshold,
    mlRiskScore: row.ml_risk_score,
    remediationSteps: JSON.parse(row.remediation_json || '[]')
  };
}

export function listIncidents(limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT * FROM incidents ORDER BY timestamp DESC LIMIT ?
  `).all(safeLimit).map(row => ({
    id: row.id,
    title: row.title,
    buoyId: row.buoy_id,
    buoyName: row.buoy_name,
    severity: row.severity,
    status: row.status,
    timestamp: row.timestamp,
    detectedValue: row.detected_value,
    threshold: row.threshold,
    mlRiskScore: row.ml_risk_score,
    remediationSteps: JSON.parse(row.remediation_json || '[]')
  }));
}

export function updateIncidentStatus(id, status) {
  db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(status, id);
  return getIncidentById(id);
}

export function getOpenIncidentsCount() {
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'OPEN'").get()?.n || 0);
  } catch {
    return 0;
  }
}

export function getActiveIncident() {
  try {
    const row = db.prepare("SELECT * FROM incidents WHERE status = 'OPEN' ORDER BY timestamp DESC LIMIT 1").get();
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      buoyId: row.buoy_id,
      buoyName: row.buoy_name,
      severity: row.severity,
      status: row.status,
      timestamp: row.timestamp,
      detectedValue: row.detected_value,
      threshold: row.threshold,
      mlRiskScore: row.ml_risk_score,
      remediationSteps: JSON.parse(row.remediation_json || '[]')
    };
  } catch {
    return null;
  }
}

// ==========================================
// ML Anomalies Persistence & Provenance
// ==========================================

export function saveMLAnomalies(anomalies = []) {
  if (!Array.isArray(anomalies) || anomalies.length === 0) return 0;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO ml_anomalies (
      id, source, platform_id, profile_id, cycle_number, observation_timestamp,
      detection_timestamp, latitude, longitude, depth, pressure, temperature,
      salinity, oxygen_content, ph, battery_level, anomaly_type, severity,
      anomaly_score, isolation_forest_score, standardized_euclidean_dist,
      explanation, qc_status, is_simulated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let count = 0;
  db.exec('BEGIN TRANSACTION;');
  try {
    for (const a of anomalies) {
      insert.run(
        a.id || `ANOM-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        a.source || 'LIVE ARGOVIS',
        a.platformId || a.buoyId || null,
        a.profileId || null,
        a.cycleNumber !== undefined ? Number(a.cycleNumber) : null,
        a.observationTimestamp || a.timestamp || now,
        a.detectionTimestamp || now,
        a.latitude !== undefined && a.latitude !== null ? Number(a.latitude) : null,
        a.longitude !== undefined && a.longitude !== null ? Number(a.longitude) : null,
        a.depth !== undefined && a.depth !== null ? Number(a.depth) : null,
        a.pressure !== undefined && a.pressure !== null ? Number(a.pressure) : null,
        a.temperature !== undefined && a.temperature !== null ? Number(a.temperature) : null,
        a.salinity !== undefined && a.salinity !== null ? Number(a.salinity) : null,
        a.oxygenContent !== undefined && a.oxygenContent !== null ? Number(a.oxygenContent) : null,
        a.ph !== undefined && a.ph !== null ? Number(a.ph) : null,
        a.batteryLevel !== undefined && a.batteryLevel !== null ? Number(a.batteryLevel) : null,
        Array.isArray(a.anomalyTypes) ? a.anomalyTypes.join(', ') : (a.anomalyType || 'STATISTICAL_DISTRIBUTION_DRIFT'),
        a.severity || 'WARNING',
        Number(a.anomalyScore || a.ensembleAnomalyScore || 0),
        a.isolationForestScore !== undefined && a.isolationForestScore !== null ? Number(a.isolationForestScore) : null,
        a.standardizedEuclideanDist !== undefined && a.standardizedEuclideanDist !== null ? Number(a.standardizedEuclideanDist) : null,
        a.explanation || (a.anomalyTypes ? a.anomalyTypes.join('; ') : 'Sensor observation anomalous deviation'),
        a.qcStatus || 'QC_PASSED',
        a.isSimulated ? 1 : 0,
        now
      );
      count++;
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

export function listMLAnomalies(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.prepare(`
    SELECT * FROM ml_anomalies
    ORDER BY observation_timestamp DESC
    LIMIT ?
  `).all(safeLimit).map(row => ({
    id: row.id,
    source: row.source,
    platformId: row.platform_id,
    buoyId: row.platform_id ? `ARGO-${row.platform_id}` : 'Observation Station',
    buoyName: row.platform_id ? `Argo Float ${row.platform_id}${row.cycle_number ? ` (Cycle ${row.cycle_number})` : ''}` : 'Ocean Sensor Station',
    profileId: row.profile_id,
    cycleNumber: row.cycle_number,
    observationTimestamp: row.observation_timestamp,
    timestamp: row.observation_timestamp,
    detectionTimestamp: row.detection_timestamp,
    latitude: row.latitude,
    longitude: row.longitude,
    depth: row.depth,
    pressure: row.pressure,
    temperature: row.temperature,
    salinity: row.salinity,
    oxygenContent: row.oxygen_content,
    ph: row.ph,
    batteryLevel: row.battery_level,
    anomalyType: row.anomaly_type,
    anomalyTypes: row.anomaly_type ? row.anomaly_type.split(', ') : [],
    severity: row.severity,
    anomalyScore: row.anomaly_score,
    ensembleAnomalyScore: row.anomaly_score,
    riskPercentage: Math.round(row.anomaly_score * 100),
    isolationForestScore: row.isolation_forest_score,
    standardizedEuclideanDist: row.standardized_euclidean_dist,
    explanation: row.explanation,
    qcStatus: row.qc_status,
    isSimulated: Boolean(row.is_simulated)
  }));
}

export function countMLAnomalies() {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM ml_anomalies').get()?.n || 0);
  } catch {
    return 0;
  }
}

export function clearMLAnomalies() {
  try {
    db.prepare('DELETE FROM ml_anomalies').run();
  } catch {}
}

// ==========================================
// Disaster Scenarios, Shelters, Warehouses
// ==========================================

export function getActiveScenario() {
  const row = db.prepare('SELECT * FROM disaster_scenarios WHERE is_active = 1').get();
  if (!row) {
    // Return first scenario or fallback
    const first = db.prepare('SELECT * FROM disaster_scenarios LIMIT 1').get();
    return first ? JSON.parse(first.details_json) : null;
  }
  return JSON.parse(row.details_json);
}

export function setActiveScenario(key) {
  const scenarioRow = db.prepare('SELECT * FROM disaster_scenarios WHERE key = ?').get(key);
  if (!scenarioRow) throw new Error(`Scenario ${key} not recognized.`);

  db.prepare('UPDATE disaster_scenarios SET is_active = 0').run();
  db.prepare('UPDATE disaster_scenarios SET is_active = 1 WHERE key = ?').run(key);

  const scenario = JSON.parse(scenarioRow.details_json);
  scenario.timestamp = new Date().toISOString();
  return scenario;
}

export function listScenarios() {
  return db.prepare('SELECT key, name, type, severity FROM disaster_scenarios').all();
}

export function listShelters() {
  return db.prepare('SELECT * FROM shelters ORDER BY id ASC').all().map(row => ({
    id: row.id,
    name: row.name,
    address: row.address,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    totalCapacity: Number(row.total_capacity),
    currentOccupancy: Number(row.current_occupancy),
    status: row.status,
    structureRating: row.structure_rating,
    contactPhone: row.contact_phone,
    facilities: JSON.parse(row.facilities_json || '{}'),
    supplies: JSON.parse(row.supplies_json || '{}')
  }));
}

export function getShelterById(id) {
  const row = db.prepare('SELECT * FROM shelters WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    totalCapacity: Number(row.total_capacity),
    currentOccupancy: Number(row.current_occupancy),
    status: row.status,
    structureRating: row.structure_rating,
    contactPhone: row.contact_phone,
    facilities: JSON.parse(row.facilities_json || '{}'),
    supplies: JSON.parse(row.supplies_json || '{}')
  };
}

export function updateShelter(shelter) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE shelters SET
      name = ?, address = ?, latitude = ?, longitude = ?, elevation_meters = ?,
      total_capacity = ?, current_occupancy = ?, status = ?, structure_rating = ?,
      contact_phone = ?, facilities_json = ?, supplies_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    shelter.name,
    shelter.address,
    Number(shelter.lat),
    Number(shelter.lng),
    Number(shelter.elevationMeters),
    Number(shelter.totalCapacity),
    Number(shelter.currentOccupancy),
    shelter.status,
    shelter.structureRating || null,
    shelter.contactPhone || null,
    JSON.stringify(shelter.facilities || {}),
    JSON.stringify(shelter.supplies || {}),
    now,
    shelter.id
  );
  return getShelterById(shelter.id);
}

export function listWarehouses() {
  return db.prepare('SELECT * FROM warehouses ORDER BY id ASC').all().map(row => ({
    id: row.id,
    name: row.name,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    accessibleByRoad: Boolean(row.accessible_by_road),
    inventory: JSON.parse(row.inventory_json || '{}'),
    availableTransport: JSON.parse(row.transport_json || '[]')
  }));
}

export function getWarehouseById(id) {
  const row = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    accessibleByRoad: Boolean(row.accessible_by_road),
    inventory: JSON.parse(row.inventory_json || '{}'),
    availableTransport: JSON.parse(row.transport_json || '[]')
  };
}

export function updateWarehouse(warehouse) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE warehouses SET
      name = ?, latitude = ?, longitude = ?, elevation_meters = ?,
      accessible_by_road = ?, inventory_json = ?, transport_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    warehouse.name,
    Number(warehouse.lat),
    Number(warehouse.lng),
    Number(warehouse.elevationMeters),
    warehouse.accessibleByRoad ? 1 : 0,
    JSON.stringify(warehouse.inventory || {}),
    JSON.stringify(warehouse.availableTransport || []),
    now,
    warehouse.id
  );
  return getWarehouseById(warehouse.id);
}

// ==========================================
// SOS Records
// ==========================================

export function createSOSRecord(entry) {
  const id = entry.id || `SOS-2026-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sos_records (
      id, timestamp, user_name, phone, latitude, longitude, elevation_meters,
      emergency_type, people_count_json, medical_notes, triage_score, status,
      assigned_unit_json, network_origin, hop_count, gateway_ack, gateway_receipt_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.timestamp || now,
    entry.userName || 'Emergency Citizen',
    entry.phone || null,
    Number(entry.lat || 0),
    Number(entry.lng || 0),
    Number(entry.elevationMeters || 0),
    entry.emergencyType || 'GENERAL_EMERGENCY',
    JSON.stringify(entry.peopleCount || { adults: 1, children: 0, elderly: 0, disabled: 0, total: 1 }),
    entry.medicalNotes || null,
    entry.triageScore || 'MEDIUM_P3',
    entry.status || 'DISPATCHED',
    JSON.stringify(entry.assignedUnit || null),
    entry.networkOrigin || 'ONLINE',
    Number(entry.hopCount || 0),
    entry.acknowledgedByGateway ? 1 : 0,
    entry.gatewayReceiptId || null,
    now
  );
  return getSOSRecordById(id);
}

export function getSOSRecordById(id) {
  const row = db.prepare('SELECT * FROM sos_records WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    userName: row.user_name,
    phone: row.phone,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    emergencyType: row.emergency_type,
    peopleCount: JSON.parse(row.people_count_json || '{}'),
    medicalNotes: row.medical_notes,
    triageScore: row.triage_score,
    status: row.status,
    assignedUnit: JSON.parse(row.assigned_unit_json || 'null'),
    networkOrigin: row.network_origin,
    hopCount: Number(row.hop_count),
    acknowledgedByGateway: Boolean(row.gateway_ack),
    gatewayReceiptId: row.gateway_receipt_id
  };
}

export function listSOSRecords(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.prepare(`
    SELECT * FROM sos_records ORDER BY timestamp DESC LIMIT ?
  `).all(safeLimit).map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    userName: row.user_name,
    phone: row.phone,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    elevationMeters: Number(row.elevation_meters),
    emergencyType: row.emergency_type,
    peopleCount: JSON.parse(row.people_count_json || '{}'),
    medicalNotes: row.medical_notes,
    triageScore: row.triage_score,
    status: row.status,
    assignedUnit: JSON.parse(row.assigned_unit_json || 'null'),
    networkOrigin: row.network_origin,
    hopCount: Number(row.hop_count),
    acknowledgedByGateway: Boolean(row.gateway_ack),
    gatewayReceiptId: row.gateway_receipt_id
  }));
}

export function updateSOSRecord(id, status, assignedUnitData) {
  const existing = getSOSRecordById(id);
  if (!existing) return null;

  const unitJson = assignedUnitData !== undefined
    ? JSON.stringify(assignedUnitData)
    : JSON.stringify(existing.assignedUnit);

  db.prepare(`
    UPDATE sos_records SET status = ?, assigned_unit_json = ? WHERE id = ?
  `).run(status, unitJson, id);

  return getSOSRecordById(id);
}

// ==========================================
// Family Safety Check-Ins
// ==========================================

export function createFamilyCheckin(entry) {
  const id = entry.id || `CHK-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO family_checkins (
      id, timestamp, phone, full_name, status, current_location_name, shelter_id,
      latitude, longitude, battery_percent, message, via_mesh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.timestamp || now,
    entry.phone,
    entry.fullName,
    entry.status || 'SAFE',
    entry.currentLocationName || null,
    entry.shelterId || null,
    Number(entry.lat || 0),
    Number(entry.lng || 0),
    Number(entry.batteryPercent || 100),
    entry.message || "I'm safe and accounted for.",
    entry.viaMesh ? 1 : 0,
    now
  );
  return getFamilyCheckinById(id);
}

export function getFamilyCheckinById(id) {
  const row = db.prepare('SELECT * FROM family_checkins WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    phone: row.phone,
    fullName: row.full_name,
    status: row.status,
    currentLocationName: row.current_location_name,
    shelterId: row.shelter_id,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    batteryPercent: Number(row.battery_percent),
    message: row.message,
    viaMesh: Boolean(row.via_mesh)
  };
}

export function searchFamilyCheckins(query = '') {
  const q = String(query || '').trim().toLowerCase();
  let rows;
  if (!q) {
    rows = db.prepare('SELECT * FROM family_checkins ORDER BY timestamp DESC LIMIT 100').all();
  } else {
    rows = db.prepare(`
      SELECT * FROM family_checkins
      WHERE LOWER(phone) LIKE ? OR LOWER(full_name) LIKE ? OR LOWER(current_location_name) LIKE ?
      ORDER BY timestamp DESC LIMIT 100
    `).all(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  return rows.map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    phone: row.phone,
    fullName: row.full_name,
    status: row.status,
    currentLocationName: row.current_location_name,
    shelterId: row.shelter_id,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    batteryPercent: Number(row.battery_percent),
    message: row.message,
    viaMesh: Boolean(row.via_mesh)
  }));
}

// ==========================================
// Convoys
// ==========================================

export function createConvoy(convoy) {
  const id = convoy.convoyId || `CONVOY-${Math.floor(1000 + Math.random() * 9000)}`;
  db.prepare(`
    INSERT INTO convoys (
      id, dispatched_at, eta_minutes, source_warehouse_name, target_shelter_id,
      target_shelter_name, vehicle, cargo_json, route, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    convoy.dispatchedAt || new Date().toISOString(),
    Number(convoy.etaMinutes || 20),
    convoy.sourceWarehouseName,
    convoy.targetShelterId,
    convoy.targetShelterName,
    convoy.vehicle,
    JSON.stringify(convoy.cargo || {}),
    convoy.route,
    convoy.status || 'IN_TRANSIT'
  );
  return { ...convoy, convoyId: id };
}

export function listConvoys(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  return db.prepare('SELECT * FROM convoys ORDER BY dispatched_at DESC LIMIT ?').all(safeLimit).map(row => ({
    convoyId: row.id,
    dispatchedAt: row.dispatched_at,
    etaMinutes: Number(row.eta_minutes),
    sourceWarehouseName: row.source_warehouse_name,
    targetShelterId: row.target_shelter_id,
    targetShelterName: row.target_shelter_name,
    vehicle: row.vehicle,
    cargo: JSON.parse(row.cargo_json || '{}'),
    route: row.route,
    status: row.status
  }));
}

// ==========================================
// Responder Fleet & Audit Events
// ==========================================

export function listResponderFleet() {
  return db.prepare('SELECT * FROM responder_units ORDER BY id ASC').all().map(row => ({
    id: row.id,
    name: row.name,
    callsign: row.callsign,
    type: row.type,
    status: row.status,
    crewCount: Number(row.crew_count),
    equipment: row.equipment,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    currentAssignment: row.current_assignment
  }));
}

export function updateResponderUnit(id, status, assignment) {
  db.prepare(`
    UPDATE responder_units SET status = ?, current_assignment = ? WHERE id = ?
  `).run(status, assignment || null, id);
  return db.prepare('SELECT * FROM responder_units WHERE id = ?').get(id);
}

export function recordAuditEvent(entry) {
  const id = entry.id || `EVT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_events (id, timestamp, event_type, event_text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    entry.timestamp || entry.time || new Date().toLocaleTimeString('en-GB'),
    entry.type || 'SYSTEM_EVENT',
    entry.text || '',
    now
  );
  return { id, time: entry.timestamp || entry.time, type: entry.type, text: entry.text };
}

export function listAuditEvents(limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(safeLimit).map(row => ({
    id: row.id,
    time: row.timestamp,
    type: row.event_type,
    text: row.event_text
  }));
}

// ==========================================
// Data Migration & Seeding from JSON files
// ==========================================

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

function migrateExistingData() {
  // 1. Migrate Telemetry from telemetry.json if observations table is empty
  const telemetryCount = countTelemetryRecords();
  const telemetryFile = path.join(DATA_DIR, 'telemetry.json');
  if (telemetryCount === 0 && fs.existsSync(telemetryFile)) {
    try {
      const records = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
      if (Array.isArray(records) && records.length > 0) {
        saveTelemetryRecords(records, 'local', false);
        console.log(`✅ Migrated ${records.length} ocean observations from telemetry.json into SQLite.`);
      }
    } catch (err) {
      console.warn('Could not migrate telemetry.json:', err.message);
    }
  }

  // 2. Migrate Disaster State from disaster_state.json if tables are empty
  const disasterFile = path.join(DATA_DIR, 'disaster_state.json');
  const scenarioCount = Number(db.prepare('SELECT COUNT(*) AS n FROM disaster_scenarios').get().n);

  if (scenarioCount === 0) {
    let sourceData = null;
    if (fs.existsSync(disasterFile)) {
      try {
        sourceData = JSON.parse(fs.readFileSync(disasterFile, 'utf8'));
      } catch (err) {
        console.warn('Could not parse disaster_state.json for migration:', err.message);
      }
    }

    // Default scenarios definition
    const INITIAL_SCENARIOS = {
      tsunami: {
        id: 'SCENARIO-TSUNAMI-01',
        type: 'TSUNAMI',
        name: 'Bay of Bengal Subduction Tsunami Warning',
        severity: 'CRITICAL',
        agency: 'Indian National Centre for Ocean Information Services (INCOIS) / PTWC',
        timestamp: new Date().toISOString(),
        epicenter: { lat: 12.85, lng: 88.42, depthKm: 18, magnitude: 8.4 },
        affectedRadiusKm: 320,
        waveVelocityKph: 740,
        estimatedWaveHeightMeters: 4.8,
        coastalEtaMinutes: 28,
        affectedSectors: ['Sector A - Coastal Fishery Zone', 'Sector B - Marina Port Harbour', 'Sector C - Lowland Delta'],
        elevationHazardLimitMeters: 25,
        evacuationPriority: 'IMMEDIATE_VERTICAL_EVACUATION',
        instructions: 'Evacuate immediately to designated high-elevation safe citadels (+30m elevation) or inland beyond 3 kilometers. Do not approach shorelines to observe receding water.'
      },
      cyclone: {
        id: 'SCENARIO-CYCLONE-02',
        type: 'CYCLONE',
        name: 'Category-4 Supercyclone "Vardah II"',
        severity: 'CRITICAL',
        agency: 'Regional Specialized Meteorological Centre (RSMC) / IMD',
        timestamp: new Date().toISOString(),
        epicenter: { lat: 13.10, lng: 84.20 },
        windSpeedKph: 195,
        gustSpeedKph: 220,
        centralPressureHpa: 938,
        stormSurgeMeters: 3.8,
        coastalEtaMinutes: 140,
        affectedSectors: ['Coastal Highway Strip', 'River Delta Estuary', 'North Beach Residential'],
        elevationHazardLimitMeters: 18,
        evacuationPriority: 'REINFORCED_SHELTER_LOCKDOWN',
        instructions: 'Seek shelter in Cat-5 engineered concrete shelters. Fasten storm shutters, turn off gas/electrical mains, and stay in interior rooms away from glass windows.'
      },
      flood: {
        id: 'SCENARIO-FLOOD-03',
        type: 'FLOOD',
        name: 'Monsoonal Cloudburst & River Breach',
        severity: 'HIGH',
        agency: 'State Disaster Management Authority (SDMA) Flood Hydrograph',
        timestamp: new Date().toISOString(),
        epicenter: { lat: 13.04, lng: 80.24 },
        waterLevelRiseMeters: 2.1,
        flowRateCusecs: 48000,
        submergedRoads: ['Coastal Express Bypass', 'Old River Bridge Causeway', 'Canal Cross Arterial'],
        coastalEtaMinutes: 45,
        affectedSectors: ['Riverside Lowlands', 'Urban Canal Basin', 'East Coast Ring Road'],
        elevationHazardLimitMeters: 14,
        evacuationPriority: 'HORIZONTAL_INLAND_EVACUATION',
        instructions: 'Move to higher elevations immediately. Never walk or drive through moving water—15 cm of moving flood water can sweep away adults, and 30 cm can float vehicles.'
      },
      earthquake: {
        id: 'SCENARIO-QUAKE-04',
        type: 'EARTHQUAKE',
        name: 'Coastal Subduction 7.6M Seismological Rupture',
        severity: 'CRITICAL',
        agency: 'National Seismological Network / USGS',
        timestamp: new Date().toISOString(),
        epicenter: { lat: 12.92, lng: 81.15, depthKm: 14, magnitude: 7.6 },
        mmiIntensity: 'VIII - SEVERE',
        peakGroundAccelerationG: 0.44,
        aftershockProbabilityPercent: 88,
        affectedSectors: ['Old Town Masonry District', 'Harbour Port Docks', 'Industrial Petrochemical Corridor'],
        elevationHazardLimitMeters: 20,
        evacuationPriority: 'OPEN_AIR_DROP_COVER_HOLD',
        instructions: 'Drop, Cover, and Hold On during active shaking. Once shaking stops, evacuate compromised structures. Beware fallen electrical cables, gas ruptures, and secondary tsunami risks.'
      },
      normal: {
        id: 'SCENARIO-NORMAL-00',
        type: 'NORMAL',
        name: 'All Clear - Routine Oceanographic Monitoring',
        severity: 'LOW',
        agency: 'FloatChat AI Early Warning Automated Sentinel',
        timestamp: new Date().toISOString(),
        instructions: 'No active disaster triggers detected across ocean buoy sensor networks. Normal maritime advisory in effect.'
      }
    };

    const activeKey = sourceData?.activeScenarioKey || 'tsunami';
    const insertScenario = db.prepare(`
      INSERT OR REPLACE INTO disaster_scenarios (key, name, type, severity, agency, instructions, details_json, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, sc] of Object.entries(INITIAL_SCENARIOS)) {
      insertScenario.run(
        key,
        sc.name,
        sc.type,
        sc.severity,
        sc.agency || '',
        sc.instructions || '',
        JSON.stringify(sc),
        key === activeKey ? 1 : 0
      );
    }

    // Shelters
    const shelters = sourceData?.shelters || [
      {
        id: 'SHELTER-01',
        name: 'St. Jude High-Elevation Safe Citadel',
        address: '44 Summit Ridge Road, North Sector',
        lat: 13.085,
        lng: 80.195,
        elevationMeters: 44,
        totalCapacity: 850,
        currentOccupancy: 540,
        structureRating: 'Tsunami & Earthquake Grade 9 Citadel',
        contactPhone: '+1-800-555-0101',
        status: 'OPEN',
        facilities: { medicalClinic: true, potableWater: true, solarMicrogrid: true, dieselBackup: true, babyCare: true, wheelchairAccess: true, petFriendly: true, starlinkMeshUplink: true },
        supplies: { waterLiters: 8500, foodMeals: 3400, medicalKits: 140, blankets: 650 }
      },
      {
        id: 'SHELTER-02',
        name: 'Naval Station Fort Coastal Bunker',
        address: 'Pier 12, Naval Defense Perimeter',
        lat: 13.065,
        lng: 80.225,
        elevationMeters: 28,
        totalCapacity: 1400,
        currentOccupancy: 1260,
        structureRating: 'Cat-5 Supercyclone Bunker & Helipad',
        contactPhone: '+1-800-555-0102',
        status: 'NEAR_CAPACITY',
        facilities: { medicalClinic: true, potableWater: true, solarMicrogrid: true, dieselBackup: true, babyCare: false, wheelchairAccess: true, petFriendly: false, starlinkMeshUplink: true },
        supplies: { waterLiters: 1950, foodMeals: 1100, medicalKits: 28, blankets: 320 }
      },
      {
        id: 'SHELTER-03',
        name: 'Hilltop Community Center & Polytech',
        address: '88 Highland Avenue, West Ward',
        lat: 13.098,
        lng: 80.175,
        elevationMeters: 58,
        totalCapacity: 650,
        currentOccupancy: 310,
        structureRating: 'Flood-Immune Reinforced Concrete Complex',
        contactPhone: '+1-800-555-0103',
        status: 'OPEN',
        facilities: { medicalClinic: true, potableWater: true, solarMicrogrid: true, dieselBackup: true, babyCare: true, wheelchairAccess: true, petFriendly: true, starlinkMeshUplink: true },
        supplies: { waterLiters: 7800, foodMeals: 4200, medicalKits: 95, blankets: 700 }
      },
      {
        id: 'SHELTER-04',
        name: 'Govt Model Higher Secondary Safe Haven',
        address: '12 Central Boulevard, Sector 4',
        lat: 13.045,
        lng: 80.210,
        elevationMeters: 34,
        totalCapacity: 900,
        currentOccupancy: 710,
        structureRating: 'State Engineered Emergency Evac Facility',
        contactPhone: '+1-800-555-0104',
        status: 'OPEN',
        facilities: { medicalClinic: true, potableWater: true, solarMicrogrid: false, dieselBackup: true, babyCare: true, wheelchairAccess: true, petFriendly: false, starlinkMeshUplink: false },
        supplies: { waterLiters: 4100, foodMeals: 2200, medicalKits: 62, blankets: 480 }
      }
    ];

    const insertShelter = db.prepare(`
      INSERT OR REPLACE INTO shelters (
        id, name, address, latitude, longitude, elevation_meters, total_capacity,
        current_occupancy, status, structure_rating, contact_phone, facilities_json, supplies_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const sh of shelters) {
      insertShelter.run(
        sh.id,
        sh.name,
        sh.address,
        Number(sh.lat),
        Number(sh.lng),
        Number(sh.elevationMeters),
        Number(sh.totalCapacity),
        Number(sh.currentOccupancy),
        sh.status,
        sh.structureRating || '',
        sh.contactPhone || '',
        JSON.stringify(sh.facilities || {}),
        JSON.stringify(sh.supplies || {}),
        now
      );
    }

    // Warehouses
    const warehouses = sourceData?.warehouses || [
      {
        id: 'WH-CENTRAL-01',
        name: 'Central Disaster Logistics Depot (Ridge North)',
        lat: 13.120,
        lng: 80.160,
        elevationMeters: 62,
        accessibleByRoad: true,
        inventory: { waterLiters: 65000, foodMeals: 28000, medicalKits: 650, antibioticsUnits: 1200, blankets: 4800, waterPurificationTabs: 50000, satelliteRadios: 120 },
        availableTransport: [
          { id: 'TRK-01', type: 'Heavy Amphibious 6x6 Cargo Truck', capacityKg: 8000, status: 'AVAILABLE' },
          { id: 'TRK-02', type: 'All-Terrain High-Clearance 4x4', capacityKg: 4000, status: 'AVAILABLE' }
        ]
      },
      {
        id: 'WH-PORT-02',
        name: 'Port Sector Staging Warehouse Beta',
        lat: 13.055,
        lng: 80.245,
        elevationMeters: 16,
        accessibleByRoad: false,
        inventory: { waterLiters: 14000, foodMeals: 6200, medicalKits: 140, antibioticsUnits: 300, blankets: 1100, waterPurificationTabs: 12000, satelliteRadios: 25 },
        availableTransport: [
          { id: 'BOAT-01', type: 'Twin-Hull Flood Rescue Cargo Vessel', capacityKg: 3500, status: 'AVAILABLE' }
        ]
      },
      {
        id: 'WH-WEST-03',
        name: 'West Ward Airfield Strategic Hub',
        lat: 13.078,
        lng: 80.140,
        elevationMeters: 52,
        accessibleByRoad: true,
        inventory: { waterLiters: 42000, foodMeals: 19500, medicalKits: 420, antibioticsUnits: 850, blankets: 3200, waterPurificationTabs: 35000, satelliteRadios: 90 },
        availableTransport: [
          { id: 'TRK-03', type: 'All-Terrain Tactical Transporter', capacityKg: 6000, status: 'AVAILABLE' }
        ]
      }
    ];

    const insertWarehouse = db.prepare(`
      INSERT OR REPLACE INTO warehouses (
        id, name, latitude, longitude, elevation_meters, accessible_by_road, inventory_json, transport_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const wh of warehouses) {
      insertWarehouse.run(
        wh.id,
        wh.name,
        Number(wh.lat),
        Number(wh.lng),
        Number(wh.elevationMeters),
        wh.accessibleByRoad ? 1 : 0,
        JSON.stringify(wh.inventory || {}),
        JSON.stringify(wh.availableTransport || []),
        now
      );
    }

    // SOS records migration
    if (Array.isArray(sourceData?.sosRecords)) {
      for (const sos of sourceData.sosRecords) {
        createSOSRecord(sos);
      }
    }

    // Family check-ins migration
    if (Array.isArray(sourceData?.familyCheckins)) {
      for (const chk of sourceData.familyCheckins) {
        createFamilyCheckin(chk);
      }
    }

    // Convoys migration
    if (Array.isArray(sourceData?.activeConvoys)) {
      for (const cv of sourceData.activeConvoys) {
        createConvoy(cv);
      }
    }

    console.log('✅ Migrated disaster scenarios, shelters, warehouses, and SOS records into SQLite.');
  }

  // 3. Seed baseline initial incidents if empty
  const incidentCount = Number(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n);
  if (incidentCount === 0) {
    const defaultIncidents = [
      {
        id: 'INC-2026-TSUNAMI-01',
        title: 'Tsunami Early Warning: Submarine Pressure Surge',
        buoyId: 'FC-ATL-02',
        buoyName: 'Atlantic Trench-Link',
        severity: 'CRITICAL',
        status: 'OPEN',
        timestamp: new Date().toISOString(),
        detectedValue: '+145 dbar Abyssal Hydrostatic Pressure Delta',
        threshold: 'Pressure Δ > 3.0 σ',
        mlRiskScore: 96,
        remediationSteps: [
          'Automated Twilio Tsunami Emergency SMS Alert dispatched to Coastal Disaster Management Authority.',
          'Issue immediate Coastal Evacuation Sirens for Sector 4 (Estimated Wave Arrival: 35 mins).',
          'Trigger Deep-Sea Bottom Pressure Recorder high-frequency sampling (1 Hz).'
        ]
      },
      {
        id: 'INC-2026-0891',
        title: 'Deep-Sea Hypoxia Critical Event',
        buoyId: 'FC-PAC-01',
        buoyName: 'Pacific Deep-Shift',
        severity: 'CRITICAL',
        status: 'OPEN',
        timestamp: new Date(Date.now() - 1800000).toISOString(),
        detectedValue: '2.4 mg/L Dissolved O2',
        threshold: '< 2.8 mg/L',
        mlRiskScore: 84,
        remediationSteps: [
          'Dispatch automated SMS notification to Pacific Marine Station chief.',
          'Trigger Autonomous Underwater Vehicle (AUV-4) for localized CTD profiling.',
          'Recalibrate optical oxygen fluorescence transducer baseline.'
        ]
      },
      {
        id: 'INC-2026-0892',
        title: 'Polar Beacon Solar Power Degradation',
        buoyId: 'FC-ARC-04',
        buoyName: 'Arctic Drift-Beacon',
        severity: 'WARNING',
        status: 'INVESTIGATING',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        detectedValue: '14.5% Battery Level',
        threshold: '< 20.0%',
        mlRiskScore: 68,
        remediationSteps: [
          'Switch internal microcontroller to ultra-low power telemetry ping profile (12h -> 24h).',
          'Schedule icebreaker support vessel battery exchange during Q3 arctic patrol.',
          'Verify solar charging sub-array cell output.'
        ]
      }
    ];

    for (const inc of defaultIncidents) {
      recordIncident(inc);
    }
    console.log('✅ Initialized persistent baseline incidents table in SQLite.');
  }

  // 4. Seed baseline responder fleet if empty
  const responderCount = Number(db.prepare('SELECT COUNT(*) AS n FROM responder_units').get().n);
  if (responderCount === 0) {
    const defaultUnits = [
      {
        id: 'SAR-BOAT-03',
        name: 'NDRF Swift-Water Rescue Vessel Alpha',
        callsign: 'RESCUE-EAGLE-3',
        type: 'RAPID_SURFACE_VESSEL',
        status: 'MISSION_ACTIVE',
        crewCount: 4,
        equipment: '4x Paramedic Divers, Defibrillator, Inflatable Extraction Rafts',
        lat: 13.048,
        lng: 80.226,
        currentAssignment: 'SOS-2026-9011 (Marina Colony)'
      },
      {
        id: 'SAR-MEDIC-01',
        name: 'Urban Search & Extrication Squad Delta',
        callsign: 'LIFE-SAVER-1',
        type: 'ALL_TERRAIN_AMBULANCE',
        status: 'MISSION_ACTIVE',
        crewCount: 6,
        equipment: 'Hydraulic Jaws of Life, Trauma Surgical Suite, Oxygen Tanks',
        lat: 13.082,
        lng: 80.205,
        currentAssignment: 'SOS-2026-9012 (Collapsed Masonry)'
      },
      {
        id: 'SAR-HELO-02',
        name: 'Coast Guard Air Rescue Pelican-2',
        callsign: 'PELICAN-2',
        type: 'SAR_HEAVY_HELICOPTER',
        status: 'STANDBY_PATROL',
        crewCount: 5,
        equipment: 'Night FLIR Infrared Sensor, Heavy Hoist Winch, 12 Stretcher Capacity',
        lat: 13.095,
        lng: 80.185,
        currentAssignment: 'AERIAL_SURVEILLANCE'
      },
      {
        id: 'SAR-DRONE-01',
        name: 'Tactical Thermal Recon Drone Swarm Alpha',
        callsign: 'SKY-RECON-1',
        type: 'AUTONOMOUS_UAV_MESH',
        status: 'RELAY_AIRBORNE',
        crewCount: 1,
        equipment: 'Thermal Heat Signature Locator, 4K Optical, BLE Mesh Transponder',
        lat: 13.064,
        lng: 80.222,
        currentAssignment: 'MESH_P2P_PACKET_RELAY'
      }
    ];

    const insertUnit = db.prepare(`
      INSERT INTO responder_units (id, name, callsign, type, status, crew_count, equipment, latitude, longitude, current_assignment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const u of defaultUnits) {
      insertUnit.run(u.id, u.name, u.callsign, u.type, u.status, u.crewCount, u.equipment, u.lat, u.lng, u.currentAssignment);
    }
  }

  // 5. Seed baseline audit events if empty
  const auditCount = Number(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n);
  if (auditCount === 0) {
    const defaultAudit = [
      { id: 'EVT-01', time: '14:42:10', type: 'TSUNAMI_SURGE', text: 'INCOIS bottom pressure surge anomaly (+145 dbar) confirmed on Buoy FC-ATL-02.' },
      { id: 'EVT-02', time: '14:44:25', type: 'SOS_DISPATCH', text: 'Critical SOS-2026-9011 triaged. Assigned NDRF Vessel Alpha (RESCUE-EAGLE-3).' },
      { id: 'EVT-03', time: '14:46:00', type: 'MESH_SYNC', text: 'Offline BLE Mesh packet PKT-9921 relayed across 3 hops & signed by Starlink Gateway.' },
      { id: 'EVT-04', time: '14:47:15', type: 'CONVOY_DISPATCH', text: 'AI Convoy CONVOY-8120 carrying 4,000L Water & 1,200 MREs en route to Shelter 2.' }
    ];
    for (const a of defaultAudit) {
      recordAuditEvent(a);
    }
  }
}

// Seed on startup
seedAccounts();
migrateExistingData();
