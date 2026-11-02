import dotenv from 'dotenv';
import { loadTwilioConfig, saveTwilioConfig } from './secrets.js';
import { recordAlert, listAlerts } from './db.js';

dotenv.config();

const smsDispatchLogs = [];

function reloadConfig() {
  const fileConfig = loadTwilioConfig();
  return {
    accountSid: fileConfig.accountSid || process.env.TWILIO_ACCOUNT_SID || '',
    authToken: fileConfig.authToken || process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: fileConfig.smsFromNumber || process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_SMS_FROM || '',
    whatsappFromNumber: fileConfig.whatsappFromNumber || process.env.TWILIO_WHATSAPP_FROM || '',
    recipientPhone: process.env.ALERT_RECIPIENT_PHONE || ''
  };
}

function credentialsLookReal(accountSid, authToken) {
  return Boolean(
    accountSid &&
    authToken &&
    !accountSid.includes('YOUR_') &&
    !authToken.includes('YOUR_') &&
    !accountSid.toLowerCase().includes('paste')
  );
}

function asWhatsAppAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('whatsapp:')) return raw;
  const number = raw.startsWith('+') ? raw : `+${raw.replace(/[^\d]/g, '')}`;
  return `whatsapp:${number}`;
}

function asSmsAddress(value) {
  const raw = String(value || '').trim().replace(/^whatsapp:/, '');
  if (!raw) return '';
  return raw.startsWith('+') ? raw : `+${raw.replace(/[^\d]/g, '')}`;
}

export function updateTwilioConfig(newConfig = {}) {
  saveTwilioConfig({
    accountSid: newConfig.accountSid,
    authToken: newConfig.authToken,
    smsFromNumber: newConfig.fromNumber || newConfig.smsFromNumber,
    whatsappFromNumber: newConfig.whatsappFromNumber
  });
  return getTwilioConfigStatus();
}

export function getTwilioConfigStatus() {
  const config = reloadConfig();
  const accountReady = credentialsLookReal(config.accountSid, config.authToken);
  const smsReady = accountReady && Boolean(asSmsAddress(config.fromNumber));
  const whatsappReady = accountReady && Boolean(config.whatsappFromNumber);
  return {
    isConfigured: smsReady,
    accountReady,
    smsReady,
    whatsappReady,
    accountSidMasked: config.accountSid
      ? `${config.accountSid.slice(0, 6)}...${config.accountSid.slice(-4)}`
      : 'NOT_SET',
    fromNumber: config.fromNumber || 'NOT_SET',
    whatsappFromNumber: config.whatsappFromNumber || 'NOT_SET',
    recipientPhone: config.recipientPhone || 'NOT_SET'
  };
}

function remember(entry) {
  smsDispatchLogs.unshift(entry);
  if (smsDispatchLogs.length > 50) smsDispatchLogs.pop();
  try {
    recordAlert({
      message: entry.message || '',
      channel: entry.mode?.includes('WHATSAPP') ? 'whatsapp' : 'sms',
      recipientPhone: entry.recipient || 'NOT_SET',
      recipientName: entry.buoyName || 'Alert Recipient',
      status: entry.status || 'UNKNOWN',
      providerSid: entry.sid || null,
      errorMessage: entry.errorMessage || null,
      mode: entry.mode || null,
      anomalyId: entry.anomalyId || null,
      incidentId: entry.incidentId || null,
      isSimulated: entry.isSimulated ? 1 : 0
    });
  } catch (err) {
    console.error('Failed to persist alert log to SQLite:', err.message);
  }
  return entry;
}

async function postToTwilio({ to, from, body }) {
  const config = reloadConfig();
  const authHeader = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
  const bodyParams = new URLSearchParams();
  bodyParams.append('To', to);
  bodyParams.append('From', from);
  bodyParams.append('Body', body);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: bodyParams.toString()
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

/**
 * Real Twilio send. Never reports success unless Twilio accepts the message.
 * channel: 'sms' | 'whatsapp'
 */
export async function sendLiveAlert({ to, message, channel, recipientName, anomalyId = null, incidentId = null, isSimulated = false }) {
  const config = reloadConfig();
  const status = getTwilioConfigStatus();
  const isWhatsApp = channel === 'whatsapp';
  const recipient = isWhatsApp ? asWhatsAppAddress(to) : asSmsAddress(to);
  const from = isWhatsApp ? asWhatsAppAddress(config.whatsappFromNumber) : asSmsAddress(config.fromNumber);
  const mode = isWhatsApp ? 'TWILIO_WHATSAPP' : 'TWILIO_SMS';

  if (!status.accountReady || !from || !recipient) {
    const error = !status.accountReady
      ? 'Twilio accountSid or authToken is missing in backend/.env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).'
      : `Twilio ${isWhatsApp ? 'whatsappFromNumber' : 'smsFromNumber'} is missing in backend/.env (TWILIO_PHONE_NUMBER).`;
    const log = remember({
      id: `SMS-${Date.now()}`,
      timestamp: new Date().toISOString(),
      recipient,
      fromNumber: from || 'NOT_SET',
      message,
      status: 'FAILED',
      mode: 'NOT_CONFIGURED',
      errorMessage: error,
      buoyName: recipientName || 'Alert',
      anomalyId,
      incidentId,
      isSimulated
    });
    return { success: false, channel, status: 'FAILED', mode: 'NOT_CONFIGURED', sid: null, error, log };
  }

  try {
    const result = await postToTwilio({ to: recipient, from, body: message });
    if (result.ok) {
      const log = remember({
        id: `SMS-${Date.now()}`,
        timestamp: new Date().toISOString(),
        recipient,
        fromNumber: from,
        message,
        status: result.data.status || 'queued',
        mode,
        sid: result.data.sid,
        buoyName: recipientName || 'Alert',
        anomalyId,
        incidentId,
        isSimulated
      });
      return {
        success: true,
        channel,
        status: result.data.status || 'queued',
        mode,
        sid: result.data.sid || null,
        error: null,
        log
      };
    }

    const error = result.data.message || result.data.detail || 'Twilio rejected the message.';
    const log = remember({
      id: `SMS-${Date.now()}`,
      timestamp: new Date().toISOString(),
      recipient,
      fromNumber: from,
      message,
      status: 'FAILED',
      mode: 'TWILIO_API_ERROR',
      errorMessage: error,
      sid: result.data.sid || null,
      buoyName: recipientName || 'Alert',
      anomalyId,
      incidentId,
      isSimulated
    });
    return { success: false, channel, status: 'FAILED', mode: 'TWILIO_API_ERROR', sid: result.data.sid || null, error, log };
  } catch (err) {
    const log = remember({
      id: `SMS-${Date.now()}`,
      timestamp: new Date().toISOString(),
      recipient,
      fromNumber: from,
      message,
      status: 'FAILED',
      mode: 'TWILIO_API_ERROR',
      errorMessage: err.message,
      buoyName: recipientName || 'Alert',
      anomalyId,
      incidentId,
      isSimulated
    });
    return { success: false, channel, status: 'FAILED', mode: 'TWILIO_API_ERROR', sid: null, error: err.message, log };
  }
}

/**
 * Existing single-message helper used by the ocean alert screens.
 * Falls back to a clearly labeled simulation only when Twilio is not configured,
 * so older demo buttons still respond. Admin citizen alerts do not use this path.
 */
export async function sendSMS({ to, message, buoyName, severity, liveOnly = false, channel = 'sms', anomalyId = null, incidentId = null, isSimulated = false }) {
  const config = reloadConfig();
  const recipient = to || config.recipientPhone || '';
  let formattedMessage = message;
  if (formattedMessage && !formattedMessage.includes('FloatChat AI')) {
    formattedMessage = `FloatChat AI Alert [${severity || 'CRITICAL'}]: ${buoyName ? `Buoy ${buoyName}` : 'Ocean Sensor Network'} - ${message}`;
  }

  if (liveOnly || channel === 'whatsapp') {
    return sendLiveAlert({
      to: recipient,
      message: formattedMessage,
      channel,
      recipientName: buoyName,
      anomalyId,
      incidentId,
      isSimulated
    });
  }

  const status = getTwilioConfigStatus();
  if (status.accountReady && status.smsReady && recipient) {
    return sendLiveAlert({
      to: recipient,
      message: formattedMessage,
      channel: 'sms',
      recipientName: buoyName,
      anomalyId,
      incidentId,
      isSimulated
    });
  }

  const log = remember({
    id: `SMS-${Date.now()}`,
    timestamp: new Date().toISOString(),
    recipient: recipient || 'NOT_SET',
    fromNumber: config.fromNumber || '+18005550199 (not configured)',
    message: formattedMessage,
    status: 'NOT_SENT',
    mode: 'NOT_CONFIGURED',
    sid: null,
    buoyName: buoyName || 'System',
    errorMessage: 'Twilio is not configured. Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in backend/.env.',
    anomalyId,
    incidentId,
    isSimulated
  });

  return {
    success: false,
    mode: 'NOT_CONFIGURED',
    sid: null,
    log,
    error: 'Twilio is not configured, so this message was not sent. Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in backend/.env.'
  };
}

export function getSMSLogs() {
  return smsDispatchLogs;
}

export function clearSMSLogs() {
  smsDispatchLogs.length = 0;
  return { success: true };
}
