import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  getGeminiApiKey, 
  getTwilioConfig, 
  getSessionSecret as getSecretFromConfig 
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SECRETS_DIR = path.join(__dirname, 'secrets');
const TWILIO_FILE = path.join(SECRETS_DIR, 'twilio.json');

export function loadGeminiApiKey() {
  return getGeminiApiKey();
}

export function loadTwilioConfig() {
  return getTwilioConfig();
}

export function saveTwilioConfig(partial = {}) {
  const current = getTwilioConfig();
  const next = { ...current };

  const mapping = {
    accountSid: partial.accountSid,
    authToken: partial.authToken,
    smsFromNumber: partial.smsFromNumber ?? partial.fromNumber,
    whatsappFromNumber: partial.whatsappFromNumber
  };

  for (const [key, value] of Object.entries(mapping)) {
    if (value && String(value).trim()) {
      next[key] = String(value).trim();
    }
  }

  try {
    if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.writeFileSync(TWILIO_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('Could not persist updated twilio.json:', err.message);
  }
  return next;
}

export function getSessionSecret() {
  return getSecretFromConfig();
}
