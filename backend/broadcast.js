import { listCitizenRecipients, normalizePhone, recordAlert } from './db.js';
import { getTwilioConfigStatus, sendLiveAlert } from './twilioService.js';

function assertChannelsReady(channels) {
  const twilio = getTwilioConfigStatus();
  if (!twilio.accountReady) {
    const error = new Error('Twilio is not configured. Paste accountSid and authToken into backend/secrets/twilio.json. Nothing was sent.');
    error.status = 400;
    error.twilio = twilio;
    throw error;
  }
  const missing = [];
  if (channels.includes('sms') && !twilio.smsReady) missing.push('smsFromNumber');
  if (channels.includes('whatsapp') && !twilio.whatsappReady) missing.push('whatsappFromNumber');
  if (missing.length) {
    const error = new Error(`Twilio is missing ${missing.join(' and ')} in backend/secrets/twilio.json. Nothing was sent.`);
    error.status = 400;
    error.twilio = twilio;
    throw error;
  }
  return twilio;
}

function cleanChannels(channels) {
  const list = Array.isArray(channels) ? channels : ['sms', 'whatsapp'];
  const picked = [...new Set(list.filter((item) => item === 'sms' || item === 'whatsapp'))];
  if (picked.length === 0) {
    const error = new Error('Choose SMS, WhatsApp, or both.');
    error.status = 400;
    throw error;
  }
  return picked;
}

function cleanMessage(message) {
  const text = String(message || '').trim();
  if (!text) {
    const error = new Error('Alert message is required.');
    error.status = 400;
    throw error;
  }
  if (text.length > 1000) {
    const error = new Error('Message is too long. Keep it under 1000 characters.');
    error.status = 400;
    throw error;
  }
  if (text.toLowerCase().startsWith('floatchat')) return text;
  return `FloatChat AI: ${text}`;
}

async function deliver(recipients, message, channels) {
  const results = [];
  for (const person of recipients) {
    for (const channel of channels) {
      const result = await sendLiveAlert({
        to: person.phone,
        message,
        channel,
        recipientName: person.fullName
      });
      recordAlert({
        message,
        channel,
        recipientPhone: person.phone,
        recipientName: person.fullName,
        status: result.status,
        providerSid: result.sid,
        errorMessage: result.error,
        mode: result.mode
      });
      results.push({
        name: person.fullName,
        phone: person.phone,
        channel,
        success: result.success,
        status: result.status,
        sid: result.sid,
        error: result.error,
        mode: result.mode
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const delivered = results.filter((item) => item.success).length;
  return {
    success: delivered === results.length && results.length > 0,
    delivered,
    failed: results.length - delivered,
    results
  };
}

export async function sendBroadcast({ message, channels, testPhone }) {
  const picked = cleanChannels(channels);
  const body = cleanMessage(message);
  assertChannelsReady(picked);

  let recipients;
  if (testPhone) {
    recipients = [{ fullName: 'Test number', phone: normalizePhone(testPhone), role: 'user' }];
  } else {
    recipients = listCitizenRecipients();
    if (recipients.length === 0) {
      const error = new Error('No citizens are registered yet. Alerts go to the mobile numbers saved at registration.');
      error.status = 400;
      throw error;
    }
  }

  return deliver(recipients, body, picked);
}
