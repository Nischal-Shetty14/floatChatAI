import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SECRETS_DIR = path.join(__dirname, 'secrets');

const GEMINI_FILE = path.join(SECRETS_DIR, 'gemini-api-key.txt');
const TWILIO_FILE = path.join(SECRETS_DIR, 'twilio.json');
const SESSION_FILE = path.join(SECRETS_DIR, 'session-secret.txt');

const EMPTY_TWILIO = {
  accountSid: '',
  authToken: '',
  smsFromNumber: '',
  whatsappFromNumber: ''
};

function ensureSecretFiles() {
  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
  }

  const copies = [
    ['gemini-api-key.example.txt', GEMINI_FILE],
    ['twilio.example.json', TWILIO_FILE]
  ];

  for (const [exampleName, destination] of copies) {
    const examplePath = path.join(SECRETS_DIR, exampleName);
    if (!fs.existsSync(destination) && fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, destination);
    }
  }
}

function isPlaceholder(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  return (
    lower.startsWith('#') ||
    lower.includes('paste_your') ||
    lower.includes('your_gemini_api_key') ||
    lower.includes('your_twilio') ||
    lower === 'changeme'
  );
}

export function loadGeminiApiKey() {
  ensureSecretFiles();
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
    console.error('Could not read Gemini key file:', err.message);
  }

  const fromEnv = String(process.env.GEMINI_API_KEY || '').trim();
  if (!isPlaceholder(fromEnv)) return fromEnv;
  return '';
}

export function loadTwilioConfig() {
  ensureSecretFiles();
  let fromFile = { ...EMPTY_TWILIO };
  try {
    if (fs.existsSync(TWILIO_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TWILIO_FILE, 'utf8'));
      fromFile = {
        accountSid: String(parsed.accountSid || '').trim(),
        authToken: String(parsed.authToken || '').trim(),
        smsFromNumber: String(parsed.smsFromNumber || '').trim(),
        whatsappFromNumber: String(parsed.whatsappFromNumber || '').trim()
      };
    }
  } catch (err) {
    console.error('Could not read twilio.json:', err.message);
  }

  return {
    accountSid: isPlaceholder(fromFile.accountSid) ? String(process.env.TWILIO_ACCOUNT_SID || '').trim() : fromFile.accountSid,
    authToken: isPlaceholder(fromFile.authToken) ? String(process.env.TWILIO_AUTH_TOKEN || '').trim() : fromFile.authToken,
    smsFromNumber: isPlaceholder(fromFile.smsFromNumber) ? String(process.env.TWILIO_PHONE_NUMBER || '').trim() : fromFile.smsFromNumber,
    whatsappFromNumber: isPlaceholder(fromFile.whatsappFromNumber) ? String(process.env.TWILIO_WHATSAPP_NUMBER || '').trim() : fromFile.whatsappFromNumber
  };
}

export function saveTwilioConfig(partial = {}) {
  ensureSecretFiles();
  const current = loadTwilioConfig();
  const next = { ...current };

  const mapping = {
    accountSid: partial.accountSid,
    authToken: partial.authToken,
    smsFromNumber: partial.smsFromNumber ?? partial.fromNumber,
    whatsappFromNumber: partial.whatsappFromNumber
  };

  for (const [key, value] of Object.entries(mapping)) {
    if (value && String(value).trim() && !isPlaceholder(value)) {
      next[key] = String(value).trim();
    }
  }

  fs.writeFileSync(TWILIO_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function getSessionSecret() {
  ensureSecretFiles();
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const existing = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch (err) {
    console.error('Could not read session secret:', err.message);
  }

  const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-floatchat-session`;
  fs.writeFileSync(SESSION_FILE, generated);
  return generated;
}

ensureSecretFiles();
