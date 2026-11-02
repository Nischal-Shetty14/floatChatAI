import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend folder if exists, or root
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const SECRETS_DIR = path.join(__dirname, 'secrets');
const GEMINI_FILE = path.join(SECRETS_DIR, 'gemini-api-key.txt');
const TWILIO_FILE = path.join(SECRETS_DIR, 'twilio.json');
const SESSION_FILE = path.join(SECRETS_DIR, 'session-secret.txt');

function isPlaceholder(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  return (
    lower.startsWith('#') ||
    lower.includes('paste_your') ||
    lower.includes('your_') ||
    lower.includes('change_me') ||
    lower === 'changeme'
  );
}

/**
 * Returns Argovis API key from environment variable
 */
export function getArgovisApiKey() {
  const fromEnv = String(process.env.ARGOVIS_API_KEY || '').trim();
  return isPlaceholder(fromEnv) ? '' : fromEnv;
}

/**
 * Returns Gemini API key, preferring environment variable with legacy file fallback
 */
export function getGeminiApiKey() {
  const fromEnv = String(process.env.GEMINI_API_KEY || '').trim();
  if (!isPlaceholder(fromEnv)) return fromEnv;

  // Backward compatibility with legacy secrets file
  try {
    if (fs.existsSync(GEMINI_FILE)) {
      const lines = fs.readFileSync(GEMINI_FILE, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (!isPlaceholder(trimmed)) return trimmed;
      }
    }
  } catch (err) {
    // Non-blocking fallback error
  }
  return '';
}

/**
 * Returns Twilio configuration, preferring environment variables with legacy file fallback
 */
export function getTwilioConfig() {
  let accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  let authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  let smsFromNumber = String(process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_SMS_NUMBER || '').trim();
  let whatsappFromNumber = String(process.env.TWILIO_WHATSAPP_NUMBER || '').trim();
  let recipientPhone = String(process.env.ALERT_RECIPIENT_PHONE || '').trim();

  // Backward compatibility: load missing pieces from secrets/twilio.json
  if (isPlaceholder(accountSid) || isPlaceholder(authToken) || isPlaceholder(smsFromNumber)) {
    try {
      if (fs.existsSync(TWILIO_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(TWILIO_FILE, 'utf8'));
        if (isPlaceholder(accountSid) && !isPlaceholder(parsed.accountSid)) accountSid = String(parsed.accountSid).trim();
        if (isPlaceholder(authToken) && !isPlaceholder(parsed.authToken)) authToken = String(parsed.authToken).trim();
        if (isPlaceholder(smsFromNumber) && !isPlaceholder(parsed.smsFromNumber)) smsFromNumber = String(parsed.smsFromNumber).trim();
        if (isPlaceholder(whatsappFromNumber) && !isPlaceholder(parsed.whatsappFromNumber)) whatsappFromNumber = String(parsed.whatsappFromNumber).trim();
      }
    } catch {
      // Non-blocking fallback
    }
  }

  return {
    accountSid: isPlaceholder(accountSid) ? '' : accountSid,
    authToken: isPlaceholder(authToken) ? '' : authToken,
    smsFromNumber: isPlaceholder(smsFromNumber) ? '' : smsFromNumber,
    whatsappFromNumber: isPlaceholder(whatsappFromNumber) ? '' : whatsappFromNumber,
    recipientPhone: isPlaceholder(recipientPhone) ? '' : recipientPhone
  };
}

/**
 * Returns session secret for HMAC-SHA256 tokens
 */
export function getSessionSecret() {
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (!isPlaceholder(fromEnv) && fromEnv.length >= 32) return fromEnv;

  try {
    if (fs.existsSync(SESSION_FILE)) {
      const existing = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch {
    // Fallback below
  }

  const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-floatchat-session`;
  try {
    if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, generated);
  } catch {
    // Return memory-only generated key if cannot write
  }
  return generated;
}

/**
 * Validates startup configuration and logs non-sensitive diagnostics
 */
export function validateStartupConfig() {
  const port = process.env.PORT || 5001;
  const hasArgovis = Boolean(getArgovisApiKey());
  const hasGemini = Boolean(getGeminiApiKey());
  const twilio = getTwilioConfig();
  const hasTwilio = Boolean(twilio.accountSid && twilio.authToken && twilio.smsFromNumber);
  const hasTwilioWhatsapp = Boolean(twilio.accountSid && twilio.authToken && twilio.whatsappFromNumber);

  console.log('----------------------------------------------------');
  console.log('🌊 FloatChat AI Service Configuration Summary');
  console.log(`📡 Port                    : ${port}`);
  console.log(`🌊 Argovis Ocean API      : ${hasArgovis ? '✅ Configured (Live API Mode)' : '⚠️ Not Set (Fallback Telemetry Mode)'}`);
  console.log(`🤖 Google Gemini AI        : ${hasGemini ? '✅ Configured (Active)' : '⚠️ Not Set (Grounded Simulation Mode)'}`);
  console.log(`📱 Twilio SMS Alert Engine : ${hasTwilio ? '✅ Configured' : '⚠️ Not Configured'}`);
  console.log(`💬 Twilio WhatsApp Alerts  : ${hasTwilioWhatsapp ? '✅ Configured' : '⚠️ Not Configured'}`);
  console.log(`🗄️ Primary Storage         : SQLite (node:sqlite) + JSON Disaster Store`);
  console.log('----------------------------------------------------');

  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
    console.warn('⚠️ WARNING: SESSION_SECRET is shorter than 32 characters. Consider using a 64-character random string.');
  }
}

export default {
  getArgovisApiKey,
  getGeminiApiKey,
  getTwilioConfig,
  getSessionSecret,
  validateStartupConfig
};

