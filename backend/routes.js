import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
import { fileURLToPath } from 'url';

import { analyzeTelemetryML, getReportContent } from './mlEngine.js';
import { sendSMS, getSMSLogs, getTwilioConfigStatus, updateTwilioConfig } from './twilioService.js';
import { disasterStore } from './disasterService.js';
import { loadGeminiApiKey } from './secrets.js';
import { requireAuth, requireRole, signToken, authenticate, changePassword } from './auth.js';
import { createUser, listUsers, listAlerts } from './db.js';
import { sendBroadcast } from './broadcast.js';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data', 'telemetry.json');
const REPORT_FILE = path.join(__dirname, 'data', 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt');

// Mongoose Schema
const telemetrySchema = new mongoose.Schema({
  timestamp: { type: Date, required: true },
  buoyId: { type: String, required: true },
  buoyName: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  depth: { type: Number, required: true },
  temperature: { type: Number, required: true },
  pressure: { type: Number, required: true },
  salinity: { type: Number, required: true },
  oxygenContent: { type: Number, required: true },
  ph: { type: Number, required: true },
  batteryLevel: { type: Number, required: true }
});

const Telemetry = mongoose.models.Telemetry || mongoose.model('Telemetry', telemetrySchema);

// Helper: Get local JSON telemetry data
function getLocalData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Error reading local telemetry JSON:', error);
  }
  return [];
}

// Helper: Save local JSON telemetry data
function saveLocalData(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing local telemetry JSON:', error);
    return false;
  }
}

// Helper: Generate summary stats of telemetry data for Gemini context
function generateTelemetrySummary(data) {
  if (!data || data.length === 0) {
    return 'No telemetry data is currently uploaded or available.';
  }

  const buoyGroups = {};
  let totalTemp = 0;
  let totalSalinity = 0;
  let totalOxygen = 0;
  let totalPH = 0;
  let maxDepth = 0;
  const anomalies = [];

  data.forEach(item => {
    const id = item.buoyId;
    if (!buoyGroups[id]) {
      buoyGroups[id] = {
        name: item.buoyName,
        count: 0,
        tempSum: 0,
        oxygenSum: 0,
        salinitySum: 0,
        maxDepth: 0
      };
    }
    buoyGroups[id].count++;
    buoyGroups[id].tempSum += item.temperature;
    buoyGroups[id].oxygenSum += item.oxygenContent;
    buoyGroups[id].salinitySum += item.salinity;
    if (item.depth > buoyGroups[id].maxDepth) {
      buoyGroups[id].maxDepth = item.depth;
    }

    totalTemp += item.temperature;
    totalSalinity += item.salinity;
    totalOxygen += item.oxygenContent;
    totalPH += item.ph;
    if (item.depth > maxDepth) maxDepth = item.depth;

    if (item.oxygenContent < 4.0) {
      anomalies.push(`Low Oxygen: ${item.oxygenContent} mg/L on ${item.buoyName} (${item.buoyId}) at depth ${item.depth}m on ${item.timestamp}`);
    }
    if (item.temperature > 26.0 && item.depth > 100) {
      anomalies.push(`Warm Depth Water: ${item.temperature}°C at depth ${item.depth}m on ${item.buoyName}`);
    }
    if (item.batteryLevel < 20) {
      anomalies.push(`Low Buoy Battery: ${item.batteryLevel}% on ${item.buoyName}`);
    }
  });

  const avgTemp = (totalTemp / data.length).toFixed(2);
  const avgSalinity = (totalSalinity / data.length).toFixed(2);
  const avgOxygen = (totalOxygen / data.length).toFixed(2);
  const avgPH = (totalPH / data.length).toFixed(2);

  let summary = `Telemetry Summary:\n`;
  summary += `- Total Measurements: ${data.length} records\n`;
  summary += `- Average Temperature: ${avgTemp}°C\n`;
  summary += `- Average Salinity: ${avgSalinity} PSU\n`;
  summary += `- Average Dissolved Oxygen: ${avgOxygen} mg/L\n`;
  summary += `- Average pH: ${avgPH}\n`;
  summary += `- Maximum Depth Measured: ${maxDepth} meters\n`;

  summary += `\nBuoys Active in Network:\n`;
  Object.keys(buoyGroups).forEach(id => {
    const bg = buoyGroups[id];
    summary += `- Buoy ${id} (${bg.name}): ${bg.count} readings, Avg Temp: ${(bg.tempSum / bg.count).toFixed(1)}°C, Max Depth: ${bg.maxDepth}m\n`;
  });

  if (anomalies.length > 0) {
    summary += `\nRecent Critical Telemetry Alerts/Anomalies (Subset):\n`;
    anomalies.slice(0, 5).forEach(a => {
      summary += `- Alert: ${a}\n`;
    });
  }

  return summary;
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 0. Server Status Check
router.get('/status', (req, res) => {
  const twilio = getTwilioConfigStatus();
  return res.json({
    status: 'online',
    isMongoConnected: req.isMongoConnected || false,
    twilioConfigured: twilio.smsReady,
    geminiConfigured: Boolean(loadGeminiApiKey()),
    twilioAccountReady: twilio.accountReady,
    twilioSmsReady: twilio.smsReady,
    twilioWhatsappReady: twilio.whatsappReady
  });
});

router.post('/auth/register', (req, res) => {
  try {
    const { username, fullName, phone, password } = req.body || {};
    const user = createUser({ username, fullName, phone, password, role: 'user' });
    const token = signToken(user);
    return res.json({ token, user });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not create the account.' });
  }
});

router.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Login id or password is incorrect.' });
    return res.json({ token: signToken(user), user });
  } catch (err) {
    return res.status(400).json({ error: 'Login id or password is incorrect.' });
  }
});

router.get('/auth/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

router.post('/auth/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    changePassword(req.user.id, currentPassword, newPassword);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not change the password.' });
  }
});

router.get('/admin/users', requireRole('admin'), (req, res) => {
  return res.json({ users: listUsers() });
});

router.post('/admin/warehouse-managers', requireRole('admin'), (req, res) => {
  try {
    const { username, fullName, phone, password } = req.body || {};
    const user = createUser({ username, fullName, phone, password, role: 'warehouse_manager' });
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not add the warehouse manager.' });
  }
});

router.get('/admin/broadcasts', requireRole('admin'), (req, res) => {
  return res.json({ broadcasts: listAlerts(50) });
});

router.post('/admin/broadcast', requireRole('admin'), async (req, res) => {
  try {
    const { message, channels, testPhone } = req.body || {};
    const report = await sendBroadcast({ message, channels, testPhone });
    return res.json(report);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Alert dispatch failed.' });
  }
});

// 1. Get Telemetry Data
router.get('/telemetry', async (req, res) => {
  try {
    let data = [];
    if (req.isMongoConnected) {
      data = await Telemetry.find().sort({ timestamp: 1 });
    } else {
      data = getLocalData();
      data.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
    return res.json(data);
  } catch (error) {
    console.error('Error fetching telemetry data:', error);
    return res.status(500).json({ error: 'Failed to retrieve telemetry data' });
  }
});

// 2. Upload Telemetry (Supports JSON and CSV)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      if (req.body && Array.isArray(req.body.telemetry)) {
        const records = req.body.telemetry;
        if (req.isMongoConnected) {
          await Telemetry.deleteMany({});
          await Telemetry.insertMany(records);
        } else {
          saveLocalData(records);
        }
        return res.json({ success: true, count: records.length, message: 'JSON telemetry data imported successfully' });
      }
      return res.status(400).json({ error: 'Please upload a telemetry file (CSV or JSON)' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let records = [];

    if (fileExt === '.json') {
      const fileData = fs.readFileSync(filePath, 'utf8');
      records = JSON.parse(fileData);
    } else if (fileExt === '.csv') {
      records = await new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on('data', (data) => {
            results.push({
              timestamp: data.timestamp || new Date().toISOString(),
              buoyId: data.buoyId || 'UNKNOWN',
              buoyName: data.buoyName || 'Unknown Buoy',
              latitude: parseFloat(data.latitude || 0),
              longitude: parseFloat(data.longitude || 0),
              depth: parseFloat(data.depth || 0),
              temperature: parseFloat(data.temperature || 0),
              pressure: parseFloat(data.pressure || 0),
              salinity: parseFloat(data.salinity || 0),
              oxygenContent: parseFloat(data.oxygenContent || 0),
              ph: parseFloat(data.ph || 8.1),
              batteryLevel: parseFloat(data.batteryLevel || 100)
            });
          })
          .on('end', () => resolve(results))
          .on('error', (err) => reject(err));
      });
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Unsupported file format. Please upload CSV or JSON.' });
    }

    fs.unlinkSync(filePath);

    if (records.length === 0) {
      return res.status(400).json({ error: 'The uploaded file contains no readable telemetry data.' });
    }

    if (req.isMongoConnected) {
      await Telemetry.deleteMany({});
      await Telemetry.insertMany(records);
    } else {
      saveLocalData(records);
    }

    return res.json({
      success: true,
      count: records.length,
      message: `Uploaded ${records.length} records successfully.`
    });

  } catch (error) {
    console.error('Error uploading telemetry:', error);
    return res.status(500).json({ error: 'Failed to upload/parse telemetry file', details: error.message });
  }
});

// 3. Reset to sample dataset
router.post('/reset', async (req, res) => {
  try {
    const sampleFilePath = path.join(__dirname, 'data', 'telemetry.json');
    if (!fs.existsSync(sampleFilePath)) {
      return res.status(404).json({ error: 'No baseline sample data available on the server. Try generating it first.' });
    }
    const sampleData = JSON.parse(fs.readFileSync(sampleFilePath, 'utf8'));

    if (req.isMongoConnected) {
      await Telemetry.deleteMany({});
      await Telemetry.insertMany(sampleData);
    } else {
      saveLocalData(sampleData);
    }

    return res.json({ success: true, count: sampleData.length, message: 'Reset database to baseline 30-day ocean telemetry.' });
  } catch (err) {
    console.error('Error resetting database:', err);
    return res.status(500).json({ error: 'Failed to reset database' });
  }
});

// ----------------------------------------------------
// ADVANCED MACHINE LEARNING ANOMALY PREDICTION ROUTES
// ----------------------------------------------------

// 5. Run ML Anomaly Detection & Predictive Forecasting
router.post('/ml/predict', async (req, res) => {
  try {
    let dataset = [];
    if (req.body && Array.isArray(req.body.dataset) && req.body.dataset.length > 0) {
      dataset = req.body.dataset;
    } else if (req.isMongoConnected) {
      dataset = await Telemetry.find().sort({ timestamp: 1 });
    } else {
      dataset = getLocalData();
    }

    if (!dataset || dataset.length === 0) {
      return res.status(400).json({ error: 'No telemetry data available for ML evaluation.' });
    }

    const mlResults = analyzeTelemetryML(dataset);
    return res.json(mlResults);
  } catch (error) {
    console.error('Error executing ML anomaly model:', error);
    return res.status(500).json({ error: 'ML Anomaly Engine failure', details: error.message });
  }
});

// 6. Retrieve Generated ML Technical & Accuracy Report Text
router.get('/ml/report', (req, res) => {
  try {
    const content = getReportContent();
    return res.json({
      success: true,
      reportText: content,
      filename: 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load ML accuracy report text' });
  }
});

// 7. Download Generated ML Accuracy Report File
router.get('/ml/report/download', (req, res) => {
  try {
    if (!fs.existsSync(REPORT_FILE)) {
      // Trigger evaluation on local data if file doesn't exist yet
      const dataset = getLocalData();
      if (dataset.length > 0) {
        analyzeTelemetryML(dataset);
      }
    }

    if (fs.existsSync(REPORT_FILE)) {
      return res.download(REPORT_FILE, 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt');
    } else {
      return res.status(404).send('Report file has not been generated yet. Please run ML prediction first.');
    }
  } catch (error) {
    console.error('Error serving report download:', error);
    return res.status(500).send('Error downloading ML report file');
  }
});

// ----------------------------------------------------
// TWILIO SMS ALERT SYSTEM ROUTES
// ----------------------------------------------------

// 8. Send SMS Alert via Twilio
router.post('/sms/send', requireRole('admin', 'warehouse_manager'), async (req, res) => {
  try {
    const { to, message, buoyName, severity, liveOnly, channel } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message body is required for SMS dispatch.' });
    }

    const result = await sendSMS({ to, message, buoyName, severity, liveOnly: Boolean(liveOnly), channel });
    return res.json(result);
  } catch (error) {
    console.error('Error dispatching SMS alert:', error);
    return res.status(500).json({ error: 'SMS dispatch failed', details: error.message });
  }
});

// 9. Get Twilio Configuration Status
router.get('/sms/config', requireRole('admin'), (req, res) => {
  return res.json(getTwilioConfigStatus());
});

// 10. Update Twilio Configuration Credentials
router.post('/sms/config', requireRole('admin'), (req, res) => {
  try {
    const { accountSid, authToken, fromNumber, recipientPhone } = req.body;
    const updatedStatus = updateTwilioConfig({ accountSid, authToken, fromNumber, recipientPhone });
    return res.json({ success: true, status: updatedStatus });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update Twilio configuration' });
  }
});

// 11. Get SMS Audit Logs
router.get('/sms/logs', requireRole('admin', 'warehouse_manager'), (req, res) => {
  return res.json({
    logs: getSMSLogs()
  });
});

// ----------------------------------------------------
// REAL-TIME STREAMING TELEMETRY SIMULATOR ROUTE
// ----------------------------------------------------

// 12. Simulate incoming live sensor feed tick
router.post('/stream/tick', async (req, res) => {
  try {
    const { buoyId = 'FC-PAC-01', injectAnomaly = false, injectTsunami = false, injectFlood = false } = req.body;
    let dataset = getLocalData();

    const buoyRef = dataset.find(d => d.buoyId === buoyId) || {
      buoyId: 'FC-PAC-01',
      buoyName: 'Pacific Deep-Shift',
      latitude: 14.599,
      longitude: -140.211,
      depth: 1200
    };

    const lastReading = dataset[dataset.length - 1] || {};
    const timestamp = new Date().toISOString();

    let newTemp = 4.5 + (Math.random() * 0.4 - 0.2);
    let newO2 = 6.2 + (Math.random() * 0.4 - 0.2);
    let newSalinity = 34.6 + (Math.random() * 0.1 - 0.05);
    let newPH = 8.1 + (Math.random() * 0.04 - 0.02);
    let newBattery = Math.max(10, (lastReading.batteryLevel || 95) - 0.1);
    let basePressure = (buoyRef.depth || 1200) * 1.005 + (Math.random() * 2 - 1);

    if (injectTsunami) {
      basePressure += 145.0; // Tsunami Hydrostatic Sea-Floor Pressure Surge
    } else if (injectFlood) {
      basePressure += 48.0; // Coastal Storm Surge Low-Pressure Elevation
    } else if (injectAnomaly) {
      const anomalyChoice = Math.floor(Math.random() * 3);
      if (anomalyChoice === 0) newO2 = 2.4;
      else if (anomalyChoice === 1) newTemp = 24.5;
      else newBattery = 14.2;
    }

    const newRecord = {
      timestamp,
      buoyId: buoyRef.buoyId,
      buoyName: buoyRef.buoyName,
      latitude: buoyRef.latitude,
      longitude: buoyRef.longitude,
      depth: buoyRef.depth || 1200,
      temperature: parseFloat(newTemp.toFixed(2)),
      pressure: parseFloat(basePressure.toFixed(1)),
      salinity: parseFloat(newSalinity.toFixed(2)),
      oxygenContent: parseFloat(newO2.toFixed(2)),
      ph: parseFloat(newPH.toFixed(2)),
      batteryLevel: parseFloat(newBattery.toFixed(1))
    };

    dataset.push(newRecord);
    if (dataset.length > 500) dataset.shift();

    saveLocalData(dataset);

    const mlEvaluation = analyzeTelemetryML(dataset);
    const latestEvaluatedRecord = mlEvaluation.records[mlEvaluation.records.length - 1];
    const disasterInfo = mlEvaluation.disasterForecasts?.find(d => d.buoyId === buoyRef.buoyId);

    let smsDispatched = false;
    let smsDetails = null;

    if (injectTsunami || (disasterInfo && disasterInfo.tsunamiRiskPercentage > 70)) {
      const alertMsg = `TSUNAMI EMERGENCY WARNING [${newRecord.buoyName}]: Hydrostatic sea-floor pressure surge detected! Predicted wave speed: ${disasterInfo?.waveVelocityKph || 390} km/h. Coastal ETA: ${disasterInfo?.coastalEtaMinutes || 35} mins. Take immediate evacuation actions!`;
      smsDetails = await sendSMS({
        message: alertMsg,
        buoyName: newRecord.buoyName,
        severity: 'CRITICAL',
        liveOnly: true
      });
      smsDispatched = Boolean(smsDetails?.success);
    } else if (latestEvaluatedRecord && latestEvaluatedRecord.riskPercentage > 75) {
      const alertMsg = `CRITICAL ANOMALY DETECTED on ${newRecord.buoyName}: ${latestEvaluatedRecord.anomalyTypes.join(', ')}. Risk Score: ${latestEvaluatedRecord.riskPercentage}%. Immediate action required!`;
      smsDetails = await sendSMS({
        message: alertMsg,
        buoyName: newRecord.buoyName,
        severity: 'CRITICAL',
        liveOnly: true
      });
      smsDispatched = Boolean(smsDetails?.success);
    }

    return res.json({
      success: true,
      newRecord,
      latestEvaluatedRecord,
      disasterInfo,
      smsDispatched,
      smsDetails,
      totalRecords: dataset.length
    });

  } catch (error) {
    console.error('Error processing streaming telemetry tick:', error);
    return res.status(500).json({ error: 'Failed to process live stream tick' });
  }
});

// ----------------------------------------------------
// DISASTER MANAGEMENT & EMERGENCY COORDINATION API
// ----------------------------------------------------

// 13. Get Active Disaster Scenario & Available Scenarios
router.get('/disaster/scenario', (req, res) => {
  res.json({
    activeScenario: disasterStore.getScenario(),
    activeScenarioKey: disasterStore.activeScenarioKey,
    allScenarios: disasterStore.getAllScenarios()
  });
});

// 14. Switch Disaster Scenario (Simulation)
router.post('/disaster/scenario', (req, res) => {
  try {
    const { key } = req.body;
    const scenario = disasterStore.setScenario(key);
    res.json({ success: true, scenario });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 15. Get Verified Shelters & Capacity
router.get('/disaster/shelters', (req, res) => {
  res.json(disasterStore.getShelters());
});

// 16. Get Relief Warehouses & Fleets
router.get('/disaster/warehouses', (req, res) => {
  res.json(disasterStore.getWarehouses());
});

// 17. AI Resource Shortage Optimization & Convoy Recommendations
router.get('/disaster/resources/optimization', (req, res) => {
  const result = disasterStore.computeResourceOptimization();
  res.json(result);
});

// 18. Dispatch AI Recommended Relief Convoy
router.post('/disaster/resources/dispatch', (req, res) => {
  try {
    const { recommendationId } = req.body;
    const convoy = disasterStore.dispatchConvoy(recommendationId);
    res.json({ success: true, convoy });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 19. Get Emergency SOS Requests
router.get('/disaster/sos', (req, res) => {
  res.json(disasterStore.getSOSRecords());
});

// 20. Create Emergency SOS
router.post('/disaster/sos', async (req, res) => {
  try {
    const sos = disasterStore.createSOS(req.body);

    // Auto-dispatch emergency SMS notification to Coast Guard / NDRF Command
    let smsDetails = null;
    try {
      const smsMessage = `🚨 EMERGENCY SOS DISPATCH [${sos.id}]: ${sos.userName} reported ${sos.emergencyType?.replace(/_/g, ' ')} at (${sos.lat}, ${sos.lng}). Triage: ${sos.triageScore}. Assigned Unit: ${sos.assignedUnit?.name || 'NDRF Vessel Alpha'} (Callsign: ${sos.assignedUnit?.callsign || 'RESCUE-1'}).`;
      smsDetails = await sendSMS({
        to: req.body.phone || '+919876543210',
        message: smsMessage,
        buoyName: 'SOS-SENTINEL-COMMAND',
        severity: 'CRITICAL',
        liveOnly: true
      });
    } catch (smsErr) {
      console.warn('Twilio SMS auto-dispatch fallback:', smsErr.message);
    }

    res.json({ 
      success: true, 
      sos,
      smsDispatched: Boolean(smsDetails?.success),
      smsDetails,
      destinationCenter: 'NDRF State Crisis Command & Coast Guard Maritime Rescue Coordination Centre (MRCC)',
      gatewayAck: sos.gatewayReceiptId
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record SOS dispatch' });
  }
});

// 21. Update SOS Rescue Status & First Responder Assignment
router.patch('/disaster/sos/:id', (req, res) => {
  const { status, assignedUnit } = req.body;
  const updated = disasterStore.updateSOSStatus(req.params.id, status, assignedUnit);
  if (!updated) return res.status(404).json({ error: 'SOS incident not found' });
  res.json({ success: true, sos: updated });
});

// 22. Ingest Offline Mesh Packet from Gateway
router.post('/disaster/mesh/sync', (req, res) => {
  try {
    const { packet } = req.body;
    if (!packet) return res.status(400).json({ error: 'Packet data required' });
    const receipt = disasterStore.processMeshPacket(packet);
    res.json({ success: true, receipt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to ingest mesh packet' });
  }
});

// 23. Family Safety Check-Ins
router.get('/disaster/family-checkin', (req, res) => {
  const { query } = req.query;
  const results = disasterStore.searchFamilyCheckIns(query);
  res.json(results);
});

router.post('/disaster/family-checkin', (req, res) => {
  try {
    const checkin = disasterStore.createFamilyCheckIn(req.body);
    res.json({ success: true, checkin });
  } catch (err) {
    res.status(400).json({ error: 'Failed to register family safety check-in' });
  }
});

// ----------------------------------------------------
// GEMINI AI CHATBOT PROXY & DISASTER RESCUE COORDINATOR
// ----------------------------------------------------

router.post('/chat', async (req, res) => {
  try {
    const { message, chatHistory = [], customApiKey } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message field is required.' });
    }

    // The local secrets file is the source of truth. A previously saved browser
    // key must not override it, otherwise an old sidebar value can keep causing
    // authentication failures after the file has been updated.
    const apiKey = loadGeminiApiKey() || (typeof customApiKey === 'string' && customApiKey.trim());

    let dataset = [];
    if (req.isMongoConnected) {
      dataset = await Telemetry.find().sort({ timestamp: -1 }).limit(1000);
    } else {
      dataset = getLocalData();
    }

    const summaryContext = generateTelemetrySummary(dataset);
    const activeScenario = disasterStore.getScenario();
    const shelters = disasterStore.getShelters();

    if (!apiKey) {
      console.log('No Gemini API Key supplied. Using mock marine scientist & rescue coordinator mode.');

      const lowerMessage = message.toLowerCase();
      let responseText = '';

      // Multilingual & Disaster Rescue Coordination Mock Logic
      if (
        lowerMessage.includes('sos') ||
        lowerMessage.includes('rescue') ||
        lowerMessage.includes('trapped') ||
        lowerMessage.includes('help') ||
        lowerMessage.includes('मदद') ||
        lowerMessage.includes('உதவி') ||
        lowerMessage.includes('ayuda')
      ) {
        responseText = `### 🚨 EMERGENCY RESCUE COORDINATOR DISPATCH
**FloatChat AI Emergency Sentinel has flagged your query as HIGH PRIORITY.**

**Immediate Actions:**
1. **Trigger Emergency SOS:** Click the red **Emergency SOS** button in the top navigation bar to broadcast your exact GPS coordinates and medical details to active NDRF & Coast Guard SAR teams.
2. **If Internet is Down:** Your SOS will automatically route across the **Offline P2P Mesh Network** using nearby phones and drone relays until it reaches an emergency satellite gateway!
3. **Audio & Strobe:** In the SOS Center, activate the **Rescue Strobe & Siren** so first responders can locate you in darkness, smoke, or water.
4. **Current Nearest Verified Safe Shelter:**
   - **${shelters[0].name}** (${shelters[0].elevationMeters}m elevation, ${shelters[0].distanceKm} km away)
   - Status: **${shelters[0].status}** (${shelters[0].currentOccupancy}/${shelters[0].totalCapacity} occupied)
   - Facilities: Medical Clinic, Clean Potable Water, Solar Microgrid, Starlink Satellite Link.`;
      } else if (
        lowerMessage.includes('tsunami') ||
        lowerMessage.includes('wave') ||
        lowerMessage.includes('surge') ||
        lowerMessage.includes('सुनामी')
      ) {
        responseText = `### 🌊 TSUNAMI EARLY WARNING PROTOCOL
**Active Situation:** ${activeScenario.name} (${activeScenario.severity})
* **Issued by:** ${activeScenario.agency}
* **Wave Velocity:** ${activeScenario.waveVelocityKph || 740} km/h | **Estimated Coastal Surge:** ${activeScenario.estimatedWaveHeightMeters || 4.8}m
* **Coastal Arrival ETA:** ${activeScenario.coastalEtaMinutes || 28} minutes

**Life-Safety Action Steps:**
- **Vertical Evacuation:** Move immediately to **at least +30 meters elevation** or 3 km inland.
- **Do Not Watch the Shore:** Receding ocean water is the definitive precursor to an catastrophic wave crest.
- **Turn-by-Turn Safe Zone Navigation:** Switch to the **Disaster Alerts & Safe Nav** tab to follow live elevation-aware routes that steer clear of coastal inundation zones!`;
      } else if (
        lowerMessage.includes('shelter') ||
        lowerMessage.includes('refuge') ||
        lowerMessage.includes('camp') ||
        lowerMessage.includes('शरण')
      ) {
        responseText = `### 🏛️ Verified Safe Shelters & Facilities
Here are the verified emergency shelters currently operating:

1. **${shelters[0].name}**
   - **Elevation:** ${shelters[0].elevationMeters}m (Safe from all flood & tsunami surges)
   - **Capacity:** ${shelters[0].currentOccupancy} / ${shelters[0].totalCapacity} (${Math.round((shelters[0].currentOccupancy/shelters[0].totalCapacity)*100)}% Full)
   - **Facilities:** Medical Trauma Station, Potable Water Reservoir, Solar Microgrid, Starlink Link.
2. **${shelters[1].name}**
   - **Elevation:** ${shelters[1].elevationMeters}m (Cat-5 Supercyclone Bunker)
   - **Capacity:** ${shelters[1].currentOccupancy} / ${shelters[1].totalCapacity}
3. **${shelters[2].name}**
   - **Elevation:** ${shelters[2].elevationMeters}m (Highland Safe Zone)

*Visit the **Smart Shelter & Resources** tab to inspect live inventory and trigger AI relief convoy replenishments.*`;
      } else if (
        lowerMessage.includes('mesh') ||
        lowerMessage.includes('offline') ||
        lowerMessage.includes('bluetooth') ||
        lowerMessage.includes('network')
      ) {
        responseText = `### 📶 Offline Mesh Networking & Store-and-Forward
When cellular and broadband infrastructure collapses during a catastrophe:
* **Decentralized Multi-Hop P2P:** FloatChat AI leverages Bluetooth Low Energy (BLE) and Wi-Fi Direct to form an ad-hoc mesh network between nearby phones, emergency buoys, and drone relays.
* **Store-and-Forward:** If no gateway is within range, packets are securely cached in local storage. Once an intermediate peer comes within radio range, messages are relayed hop-by-hop until reaching an online satellite gateway.
* **End-to-End Encryption:** Medical and personal notes are sealed cryptographically; intermediary relay phones only read routing headers.
* **Status Lifecycle:** Messages advance from \`Queued\` ➔ \`Relayed\` ➔ \`Delivered\` ➔ \`Acknowledged\`.

*⚠️ Note: Message transmission relies on physical opportunistic device paths and cannot be guaranteed without a reachable node chain.*`;
      } else if (lowerMessage.includes('temp') || lowerMessage.includes('warm') || lowerMessage.includes('heat')) {
        responseText = `### 🌡️ Ocean Temperature Report\nBased on active telemetry data, average temperature across our buoy network is approximately **10.5°C**.\n\n* **Surface buoy (Indian Reef - FC-IND-03)**: Recording values around **22.8°C**.\n* **Abyssal buoy (Atlantic Trench - FC-ATL-02)**: Recording values near **2.1°C** at ${dataset.length ? Math.max(...dataset.map(d => d.depth)) : 2500} meters.`;
      } else if (lowerMessage.includes('oxygen') || lowerMessage.includes('breath') || lowerMessage.includes('low o2')) {
        responseText = `### 🫧 Dissolved Oxygen Content Analysis\nOur sensor network records average dissolved oxygen levels of **5.8 mg/L**.\n\n⚠️ **Observations**:\n- Oxygen Minimum Zones (OMZ) detected around 200m to 1000m depth with readings dipping below **4.0 mg/L**.\n- Below **3.0 mg/L**, marine hypoxia alerts are triggered.`;
      } else if (lowerMessage.includes('salinity') || lowerMessage.includes('salt')) {
        responseText = `### 🧂 Salinity Profile\nSalinity values range between **33.1 PSU and 35.2 PSU** across Arctic and Atlantic transects.`;
      } else if (lowerMessage.includes('anomaly') || lowerMessage.includes('alert') || lowerMessage.includes('warning') || lowerMessage.includes('predict') || lowerMessage.includes('ml')) {
        responseText = `### 🚨 Machine Learning Telemetry Alerts & Anomaly Predictions\nEnsemble ML model (Isolation Forest + Mahalanobis Distance + Linear Forecasting) is operational:\n\n1. **Critical Hypoxia Warning**: Detected on **FC-PAC-01** (Oxygen level dipping to **3.2 mg/L**, Risk Score: **84%**).\n2. **Tsunami Pressure Anomaly Detection**: Active across abyssal bottom pressure recorders.\n3. **ML Accuracy Metrics**: Model operating at **96.8% Accuracy**, **97.2% Precision**, and **ROC-AUC of 0.984**.`;
      } else {
        responseText = `### 🌊 Welcome to FloatChat AI (Disaster Management & Ocean Sentinel)
I am your AI assistant specialized in marine oceanography, early disaster warning, and emergency rescue coordination.

**Current Situation:**
- Active Scenario: **${activeScenario.name}** (${activeScenario.severity})
- Nearest Safe Shelter: **${shelters[0].name}** (+${shelters[0].elevationMeters}m elevation)
- Network Status: **Dual Mode (Online Cloud & Offline P2P Mesh)**

**How can I assist you?**
* *“Where is the nearest safe shelter for tsunamis?”*
* *“How do I trigger an emergency SOS with rescue tracking?”*
* *“Explain how the offline Bluetooth mesh network relays messages.”*
* *“Show me AI resource distribution recommendations for relief warehouses.”*`;
      }

      return res.json({
        message: responseText,
        isMock: true,
        summarySent: true
      });
    }

    const systemInstruction = `You are FloatChat AI, an expert AI marine oceanographer, emergency disaster coordinator, and crisis response strategist.
You provide verified disaster guidance, safe-zone navigation, shelter coordination, and ocean telemetry analysis.
Support multilingual queries fluently (English, Hindi, Tamil, Bengali, Spanish, Telugu, French).

Current Active Disaster Scenario:
${JSON.stringify(activeScenario, null, 2)}

Verified Emergency Shelters in Area:
${JSON.stringify(shelters.map(s => ({ name: s.name, elevationMeters: s.elevationMeters, status: s.status, capacity: `${s.currentOccupancy}/${s.totalCapacity}` })), null, 2)}

Telemetry Dataset Summary:
${summaryContext}

Be concise, life-preserving, reassuring, and format responses with clean markdown (bullet points, bold emergency callouts).`;

    const contents = [];
    chatHistory.forEach(turn => {
      contents.push({
        role: turn.role === 'user' ? 'user' : 'model',
        parts: [{ text: turn.content }]
      });
    });

    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    // AI Studio keys created after May 2026 start with AQ. and must be sent
    // in the x-goog-api-key header. The older SDK query-string call is rejected.
    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents
        })
      }
    );
    const geminiData = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      const reason = geminiData?.error?.message || 'Gemini rejected the API key.';
      throw new Error(reason);
    }
    const responseText = (geminiData.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('')
      .trim();
    if (!responseText) {
      throw new Error('Gemini returned an empty reply.');
    }

    return res.json({
      message: responseText,
      isMock: false
    });

  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return res.status(500).json({ error: 'Failed to communicate with AI model', details: error.message });
  }
});

export default router;
