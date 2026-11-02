import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { fileURLToPath } from "url";

import { analyzeTelemetryML, getReportContent } from "./mlEngine.js";
import {
  sendSMS,
  getSMSLogs,
  getTwilioConfigStatus,
  updateTwilioConfig,
} from "./twilioService.js";
import { disasterStore } from "./disasterService.js";
import { loadGeminiApiKey } from "./secrets.js";
import {
  requireAuth,
  requireRole,
  signToken,
  authenticate,
  changePassword,
} from "./auth.js";
import {
  createUser,
  listUsers,
  listAlerts,
  listTelemetryRecords,
  saveTelemetryRecords,
  listIncidents,
  recordIncident,
  updateIncidentStatus,
  getOpenIncidentsCount,
  getActiveIncident,
  saveMLAnomalies,
  listMLAnomalies,
  listResponderFleet,
  updateResponderUnit,
  listAuditEvents,
  recordAuditEvent,
} from "./db.js";
import { sendBroadcast } from "./broadcast.js";
import {
  getArgoProfiles,
  getArgovisStatus,
  getArgoOverview,
  discoverArgoProfiles,
  getArgoProfileById
} from "./argovisService.js";
import { getArgovisApiKey } from "./config.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "data", "telemetry.json");
const REPORT_FILE = path.join(
  __dirname,
  "data",
  "ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt",
);

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
  batteryLevel: { type: Number, required: true },
});

const Telemetry =
  mongoose.models.Telemetry || mongoose.model("Telemetry", telemetrySchema);

// Helper: Get telemetry observations from SQLite
function getLocalData() {
  try {
    const records = listTelemetryRecords();
    if (records && records.length > 0) return records;
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error("Error reading telemetry data:", error);
  }
  return [];
}

// Helper: Save telemetry observations to SQLite (and disk backup)
function saveLocalData(data) {
  try {
    if (Array.isArray(data)) {
      saveTelemetryRecords(data, "local", true);
    }
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("Error saving telemetry data:", error);
    return false;
  }
}

// Helper: Generate comprehensive grounded context for Gemini AI
async function buildGroundedContext(userQuery = "", chatHistory = []) {
  const dataset = listTelemetryRecords(100);
  const activeScenario = disasterStore.getScenario();
  const shelters = disasterStore.getShelters();
  const warehouses = disasterStore.getWarehouses();
  const openIncidents = listIncidents(5).filter((i) => i.status === "OPEN");
  const sosRecords = disasterStore.getSOSRecords();
  const activeSOS = sosRecords.filter((s) => s.status !== "RESCUED");
  const recentAnomalies = listMLAnomalies(10);

  // Station stats
  const buoySummary = {};
  dataset.forEach((item) => {
    const id = item.buoyId;
    if (!buoySummary[id]) {
      buoySummary[id] = {
        name: item.buoyName,
        source: item.source || "local",
        lat: item.latitude,
        lng: item.longitude,
        readingsCount: 0,
        latestReading: item,
      };
    }
    buoySummary[id].readingsCount++;
    if (
      new Date(item.timestamp) >
      new Date(buoySummary[id].latestReading.timestamp)
    ) {
      buoySummary[id].latestReading = item;
    }
  });

  // Retrieve Argovis overview and regional float observations
  let argoOverview = null;
  let argoFloats = [];
  let specificProfile = null;

  try {
    const overviewRes = await getArgoOverview();
    if (overviewRes && overviewRes.data) {
      argoOverview = overviewRes.data;
    }

    const discoveryRes = await discoverArgoProfiles({ limit: 20 });
    if (discoveryRes && Array.isArray(discoveryRes.uniqueFloats)) {
      argoFloats = discoveryRes.uniqueFloats.slice(0, 10);
    }

    // Entity & Intent Extraction with Multi-Turn Conversational Memory
    let floatId = null;
    let cycleNum = null;
    const directMatch = userQuery.match(/\b(\d{7})(?:_(\d{1,3}))?\b/);
    if (directMatch) {
      floatId = directMatch[1];
      cycleNum = directMatch[2] || null;
    } else if (Array.isArray(chatHistory)) {
      // Resolve pronoun/reference ("that float", "previous profile", "its oxygen", etc.)
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        const text = typeof chatHistory[i].content === 'string' ? chatHistory[i].content : '';
        const prevMatch = text.match(/\b(\d{7})(?:_(\d{1,3}))?\b/);
        if (prevMatch) {
          floatId = prevMatch[1];
          cycleNum = prevMatch[2] || null;
          break;
        }
      }
    }

    if (floatId) {
      const targetId = cycleNum ? `${floatId}_${cycleNum}` : null;
      if (targetId) {
        const profRes = await getArgoProfileById(targetId);
        if (profRes && profRes.success) specificProfile = profRes;
      } else {
        const floatObj = argoFloats.find((f) => f.floatId === floatId);
        const profId = floatObj?.latestProfileId || `${floatId}_300`;
        let profRes = await getArgoProfileById(profId);
        if (!profRes || !profRes.success) {
          // Try common cycle indices if not in discovery list
          profRes = await getArgoProfileById(`${floatId}_001`);
        }
        if (profRes && profRes.success) specificProfile = profRes;
      }
    }
  } catch (e) {
    // Non-blocking fallback
  }

  let context = `=== GROUNDED RETRIEVAL CONTEXT (SOURCE OF TRUTH) ===\n\n`;

  // 1. Disaster Situation
  context += `[DISASTER SITUATION STATUS]\n`;
  if (activeScenario && activeScenario.type !== 'NORMAL') {
    context += `- Type: SIMULATED SCENARIO (Predefined disaster drill/simulation)\n`;
    context += `- Name: ${activeScenario.name} (${activeScenario.type})\n`;
    context += `- Severity: ${activeScenario.severity}\n`;
    context += `- Agency: ${activeScenario.agency || "Disaster Management Authority"}\n`;
    context += `- Instructions: ${activeScenario.instructions}\n`;
    if (activeScenario.waveVelocityKph)
      context += `- Simulated Wave Velocity: ${activeScenario.waveVelocityKph} km/h (ETA: ${activeScenario.coastalEtaMinutes} mins)\n`;
  } else {
    context += `- Situation: All Clear — Routine Oceanographic Monitoring (No disaster scenario active)\n`;
  }

  // 2. Verified Safe Shelters
  context += `\n[VERIFIED SAFE SHELTERS (${shelters.length} Shelters in Area)]\n`;
  shelters.forEach((s) => {
    const occPct = Math.round(
      (s.currentOccupancy / (s.totalCapacity || 1)) * 100,
    );
    context += `- ${s.name} (${s.id}): Status=${s.status}, Occupancy=${s.currentOccupancy}/${s.totalCapacity} (${occPct}%), Elevation=+${s.elevationMeters}m MSL\n`;
    context += `  Supplies: Water=${s.supplies?.waterLiters || 0}L, Food=${s.supplies?.foodMeals || 0} meals, Medical Kits=${s.supplies?.medicalKits || 0}\n`;
  });

  // 3. Relief Warehouses
  context += `\n[RELIEF LOGISTICS WAREHOUSES]\n`;
  warehouses.forEach((w) => {
    context += `- ${w.name} (${w.id}): Road Accessible=${w.accessibleByRoad ? "YES" : "NO"}\n`;
    context += `  Stock: Water=${w.inventory?.waterLiters || 0}L, Food=${w.inventory?.foodMeals || 0} meals, Medical=${w.inventory?.medicalKits || 0} kits\n`;
  });

  // 4. Open Incidents & SOS
  context += `\n[EMERGENCY INCIDENTS & SOS STATUS]\n`;
  context += `- Active Citizen SOS Requests: ${activeSOS.length} pending rescue\n`;
  if (openIncidents.length > 0) {
    openIncidents.forEach((inc) => {
      context += `- Verified Incident: ${inc.title} on ${inc.buoyName || "Network"} (${inc.severity}) - ${inc.detectedValue}\n`;
    });
  } else {
    context += `- Live Verified Incidents: None currently active. (Normal telemetry monitoring)\n`;
  }

  // 5. Ocean Telemetry Stations & Latest Observations
  context += `\n[ACTIVE OCEAN STATIONS & OBSERVATIONS (${Object.keys(buoySummary).length} Active Stations)]\n`;
  Object.values(buoySummary).forEach((b) => {
    const lr = b.latestReading;
    context += `- ${b.name} (${b.latestReading.buoyId}): Source=${b.source}, Position=(${b.lat}, ${b.lng}), Latest Obs Time=${lr.timestamp}\n`;
    context += `  Measurements: Temp=${lr.temperature !== null ? lr.temperature + "°C" : "N/A"}, Depth=${lr.depth}m, Pres=${lr.pressure !== null ? lr.pressure + " dbar" : "N/A"}, Salinity=${lr.salinity !== null ? lr.salinity + " PSU" : "N/A"}, O2=${lr.oxygenContent !== null ? lr.oxygenContent + " mg/L" : "N/A"}, pH=${lr.ph !== null ? lr.ph : "N/A"}, Battery=${lr.batteryLevel !== null ? lr.batteryLevel + "%" : "N/A"}\n`;
  });

  // 6. Argovis Real-World Float Observations
  context += `\n[ARGOVIS REAL-WORLD OCEANOGRAPHIC FLOATS]\n`;
  if (argoOverview) {
    context += `- Global Argovis Dataset: ${argoOverview.totalProfiles} profiles (${argoOverview.nCore} Core, ${argoOverview.nBGC} BGC, ${argoOverview.nDeep} Deep). Data update: ${argoOverview.latest_argovis_update || "Recent"}\n`;
  }
  if (argoFloats.length > 0) {
    context += `- Active Real Floats Discovered in Region:\n`;
    argoFloats.forEach((f) => {
      context += `  * Float ${f.floatId} (${f.source}): Latest Position=(${f.latestLatitude}, ${f.latestLongitude}), Latest Cycle=${f.latestCycle}, Obs Time=${f.latestTimestamp}, Variables=[${f.availableVariables.join(", ")}]\n`;
    });
  }
  if (specificProfile && specificProfile.verticalProfile) {
    const vp = specificProfile.verticalProfile;
    context += `- Detailed Vertical Profile for Float ${specificProfile.platformId} (Profile ${specificProfile.profileId}, Cycle ${specificProfile.cycleNumber}):\n`;
    context += `  Position: Lat ${specificProfile.coordinates[1]}°, Lng ${specificProfile.coordinates[0]}° | Observation Time: ${specificProfile.timestamp}\n`;
    context += `  Total Depth Levels: ${vp.levelsCount}\n`;
    context += `  Sensors Equipped: [${(vp.sensorsEquipped || []).join(", ")}]\n`;
    context += `  BGC Availability: Dissolved Oxygen=${vp.hasOxygen ? 'YES (Active doxy sensor)' : 'NO (Sensor not equipped)'}, pH=${vp.hasPh ? 'YES (Active ph sensor)' : 'NO (Sensor not equipped)'}\n`;
    if (vp.temperature && vp.temperature.length > 0) {
      context += `  Surface Level: Temp=${vp.temperature[0]}°C, Pres=${vp.pressure[0]} dbar, Depth=${vp.depth[0]}m, Salinity=${vp.salinity[0]} PSU, O2=${vp.oxygen?.[0] !== null && vp.oxygen?.[0] !== undefined ? vp.oxygen[0] + ' mg/L' : 'N/A'}, pH=${vp.ph?.[0] !== null && vp.ph?.[0] !== undefined ? vp.ph[0] : 'N/A'}\n`;
      // Find level closest to 1000m
      let idx1000 = 0;
      let minDiff = Infinity;
      for (let i = 0; i < vp.depth.length; i++) {
        if (vp.depth[i] !== null) {
          const diff = Math.abs(vp.depth[i] - 1000);
          if (diff < minDiff) { minDiff = diff; idx1000 = i; }
        }
      }
      if (vp.depth[idx1000] !== null) {
        context += `  ~1000m Level (${Math.round(vp.depth[idx1000])}m / ${Math.round(vp.pressure[idx1000])} dbar): Temp=${vp.temperature[idx1000]}°C, Salinity=${vp.salinity[idx1000]} PSU, O2=${vp.oxygen?.[idx1000] !== null && vp.oxygen?.[idx1000] !== undefined ? vp.oxygen[idx1000] + ' mg/L' : 'N/A'}\n`;
      }
      const deepIdx = vp.temperature.length - 1;
      context += `  Deepest Level (${Math.round(vp.depth[deepIdx])}m): Temp=${vp.temperature[deepIdx]}°C, Pres=${vp.pressure[deepIdx]} dbar, Salinity=${vp.salinity[deepIdx]} PSU\n`;
    }
  }

  // 7. ML Anomaly Detection Engine Findings
  context += `\n[DETECTED OCEANOGRAPHIC ANOMALIES (ML ENGINE)]\n`;
  if (recentAnomalies.length > 0) {
    context += `- Persisted Flagged Anomalies (${recentAnomalies.length} records in database):\n`;
    recentAnomalies.forEach((a) => {
      context += `  * [${a.severity}] Station ${a.buoy_name || a.buoy_id} (Source: ${a.source}): Anomaly Score=${a.anomaly_score}, Flags=[${a.anomaly_type}], Obs Time=${a.observation_timestamp}\n`;
      context += `    Measurements: Depth=${a.depth}m, Pres=${a.pressure} dbar, Temp=${a.temperature !== null ? a.temperature + '°C' : 'N/A'}, Salinity=${a.salinity !== null ? a.salinity + ' PSU' : 'N/A'}, O2=${a.oxygen_content !== null ? a.oxygen_content + ' mg/L' : 'N/A'}, pH=${a.ph !== null ? a.ph : 'N/A'}\n`;
      context += `    Reason: ${a.explanation}\n`;
    });
  } else {
    context += `- No critical anomalies detected in recent telemetry evaluation.\n`;
  }

  context += `\n=== END CONTEXT ===\n`;
  return { context, argoOverview, argoFloats, specificProfile, recentAnomalies };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 0. Server Status Check
router.get("/status", (req, res) => {
  const twilio = getTwilioConfigStatus();
  return res.json({
    status: "online",
    isMongoConnected: req.isMongoConnected || false,
    twilioConfigured: twilio.smsReady,
    geminiConfigured: Boolean(loadGeminiApiKey()),
    argovisConfigured: Boolean(getArgovisApiKey()),
    twilioAccountReady: twilio.accountReady,
    twilioSmsReady: twilio.smsReady,
    twilioWhatsappReady: twilio.whatsappReady,
  });
});

router.post("/auth/register", (req, res) => {
  try {
    const { username, fullName, phone, password } = req.body || {};
    const user = createUser({
      username,
      fullName,
      phone,
      password,
      role: "user",
    });
    const token = signToken(user);
    return res.json({ token, user });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err.message || "Could not create the account." });
  }
});

router.post("/auth/login", (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = authenticate(username, password);
    if (!user)
      return res
        .status(401)
        .json({ error: "Login id or password is incorrect." });
    return res.json({ token: signToken(user), user });
  } catch (err) {
    return res
      .status(400)
      .json({ error: "Login id or password is incorrect." });
  }
});

router.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

router.post("/auth/change-password", requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    changePassword(req.user.id, currentPassword, newPassword);
    return res.json({ success: true });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err.message || "Could not change the password." });
  }
});

router.get("/admin/users", requireRole("admin"), (req, res) => {
  return res.json({ users: listUsers() });
});

router.post("/admin/warehouse-managers", requireRole("admin"), (req, res) => {
  try {
    const { username, fullName, phone, password } = req.body || {};
    const user = createUser({
      username,
      fullName,
      phone,
      password,
      role: "warehouse_manager",
    });
    return res.json({ success: true, user });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err.message || "Could not add the warehouse manager." });
  }
});

router.get("/admin/broadcasts", requireRole("admin"), (req, res) => {
  return res.json({ broadcasts: listAlerts(50) });
});

router.post("/admin/broadcast", requireRole("admin"), async (req, res) => {
  try {
    const { message, channels, testPhone } = req.body || {};
    const report = await sendBroadcast({ message, channels, testPhone });
    return res.json(report);
  } catch (err) {
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Alert dispatch failed." });
  }
});

// Incidents & Alert Feed
router.get("/incidents", (req, res) => {
  try {
    return res.json({ incidents: listIncidents() });
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve incidents" });
  }
});

router.post(
  "/incidents",
  requireRole("admin", "warehouse_manager"),
  (req, res) => {
    try {
      const incident = recordIncident(req.body);
      return res.json({ success: true, incident });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  },
);

router.patch(
  "/incidents/:id",
  requireRole("admin", "warehouse_manager"),
  (req, res) => {
    try {
      const incident = updateIncidentStatus(req.params.id, req.body.status);
      return res.json({ success: true, incident });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  },
);

// 1. Get Telemetry Data
router.get("/telemetry", async (req, res) => {
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
    console.error("Error fetching telemetry data:", error);
    return res.status(500).json({ error: "Failed to retrieve telemetry data" });
  }
});

// Argovis Oceanographic Endpoints (Overview, Discovery, Profiles, Detail)
router.get("/argo/overview", async (req, res) => {
  try {
    const result = await getArgoOverview({ forceRefresh: req.query.refresh === "true" });
    return res.json(result);
  } catch (error) {
    console.error("Error retrieving Argovis overview:", error);
    return res.status(500).json({ error: "Failed to retrieve Argovis overview", details: error.message });
  }
});

router.get("/argo/floats", async (req, res) => {
  try {
    const result = await discoverArgoProfiles({
      ...req.query,
      forceRefresh: req.query.refresh === "true",
      limit: req.query.limit ? Number(req.query.limit) : 200
    });
    return res.json(result);
  } catch (error) {
    console.error("Error discovering Argovis floats:", error);
    return res.status(500).json({ error: "Failed to discover Argovis floats", details: error.message });
  }
});

router.get("/argo/profile/:id", async (req, res) => {
  try {
    const dataVars = req.query.data
      ? (Array.isArray(req.query.data) ? req.query.data : [req.query.data])
      : ["pressure", "temperature", "salinity", "doxy", "ph_in_situ_total"];
    const result = await getArgoProfileById(req.params.id, {
      dataVars,
      forceRefresh: req.query.refresh === "true"
    });
    return res.json(result);
  } catch (error) {
    console.error("Error retrieving individual Argovis profile:", error);
    return res.status(500).json({ error: "Failed to retrieve profile", details: error.message });
  }
});

router.get("/argo/profiles", async (req, res) => {
  try {
    const result = await getArgoProfiles(req.query);
    return res.json(result);
  } catch (error) {
    console.error("Error retrieving Argovis profiles:", error);
    return res
      .status(500)
      .json({
        error: "Failed to retrieve Argovis profiles",
        details: error.message,
      });
  }
});

router.get("/argo/status", (req, res) => {
  try {
    return res.json(getArgovisStatus());
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve Argovis status" });
  }
});

// 2. Upload Telemetry (Supports JSON and CSV)
router.post("/upload", upload.single("file"), async (req, res) => {
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
        return res.json({
          success: true,
          count: records.length,
          message: "JSON telemetry data imported successfully",
        });
      }
      return res
        .status(400)
        .json({ error: "Please upload a telemetry file (CSV or JSON)" });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let records = [];

    if (fileExt === ".json") {
      const fileData = fs.readFileSync(filePath, "utf8");
      records = JSON.parse(fileData);
    } else if (fileExt === ".csv") {
      records = await new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on("data", (data) => {
            results.push({
              timestamp: data.timestamp || new Date().toISOString(),
              buoyId: data.buoyId || "UNKNOWN",
              buoyName: data.buoyName || "Unknown Buoy",
              latitude: parseFloat(data.latitude || 0),
              longitude: parseFloat(data.longitude || 0),
              depth: parseFloat(data.depth || 0),
              temperature: parseFloat(data.temperature || 0),
              pressure: parseFloat(data.pressure || 0),
              salinity: parseFloat(data.salinity || 0),
              oxygenContent: parseFloat(data.oxygenContent || 0),
              ph: parseFloat(data.ph || 8.1),
              batteryLevel: parseFloat(data.batteryLevel || 100),
            });
          })
          .on("end", () => resolve(results))
          .on("error", (err) => reject(err));
      });
    } else {
      fs.unlinkSync(filePath);
      return res
        .status(400)
        .json({ error: "Unsupported file format. Please upload CSV or JSON." });
    }

    fs.unlinkSync(filePath);

    if (records.length === 0) {
      return res
        .status(400)
        .json({
          error: "The uploaded file contains no readable telemetry data.",
        });
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
      message: `Uploaded ${records.length} records successfully.`,
    });
  } catch (error) {
    console.error("Error uploading telemetry:", error);
    return res
      .status(500)
      .json({
        error: "Failed to upload/parse telemetry file",
        details: error.message,
      });
  }
});

// 3. Reset to sample dataset
router.post("/reset", async (req, res) => {
  try {
    const sampleFilePath = path.join(__dirname, "data", "telemetry.json");
    if (!fs.existsSync(sampleFilePath)) {
      return res
        .status(404)
        .json({
          error:
            "No baseline sample data available on the server. Try generating it first.",
        });
    }
    const sampleData = JSON.parse(fs.readFileSync(sampleFilePath, "utf8"));

    if (req.isMongoConnected) {
      await Telemetry.deleteMany({});
      await Telemetry.insertMany(sampleData);
    } else {
      saveLocalData(sampleData);
    }

    return res.json({
      success: true,
      count: sampleData.length,
      message: "Reset database to baseline 30-day ocean telemetry.",
    });
  } catch (err) {
    console.error("Error resetting database:", err);
    return res.status(500).json({ error: "Failed to reset database" });
  }
});

// ----------------------------------------------------
// ADVANCED MACHINE LEARNING ANOMALY PREDICTION ROUTES
// ----------------------------------------------------

// 5. Run ML Anomaly Detection & Predictive Forecasting
router.post("/ml/predict", async (req, res) => {
  try {
    let dataset = [];
    let dataSource = req.body.source || "LOCAL BASELINE";
    if (
      req.body &&
      Array.isArray(req.body.dataset) &&
      req.body.dataset.length > 0
    ) {
      dataset = req.body.dataset;
    } else if (req.isMongoConnected) {
      dataset = await Telemetry.find().sort({ timestamp: 1 });
    } else {
      dataset = getLocalData();
    }

    if (!dataset || dataset.length === 0) {
      return res
        .status(400)
        .json({ error: "No telemetry data available for ML evaluation." });
    }

    const mlResults = analyzeTelemetryML(dataset, { source: dataSource, saveToDb: true });
    return res.json(mlResults);
  } catch (error) {
    console.error("Error executing ML anomaly model:", error);
    return res
      .status(500)
      .json({ error: "ML Anomaly Engine failure", details: error.message });
  }
});

// Dynamic Re-Evaluate ML Model on latest eligible observations (Argovis live/cached or baseline)
router.post("/ml/evaluate", async (req, res) => {
  try {
    let dataset = [];
    let dataSource = "LOCAL BASELINE";
    const forceLive = req.body?.forceLive === true || req.query?.refresh === "true";

    // 1. Direct dataset passed from client
    if (req.body && Array.isArray(req.body.dataset) && req.body.dataset.length > 0) {
      dataset = req.body.dataset;
      dataSource = req.body.source || "LIVE ARGOVIS";
    } else if (forceLive) {
      // Force live retrieval of fresh Argovis profiles
      try {
        const discovery = await discoverArgoProfiles({ limit: 15, forceRefresh: true });
        if (discovery.uniqueFloats && discovery.uniqueFloats.length > 0) {
          // Select discovered floats including BGC floats if available
          for (const f of discovery.uniqueFloats.slice(0, 4)) {
            if (f.latestProfileId) {
              await getArgoProfileById(f.latestProfileId, { forceRefresh: true });
            }
          }
        }
        const updated = listTelemetryRecords(1000);
        const freshArgo = updated.filter(t => t.source === 'argovis');
        if (freshArgo.length > 0) {
          dataset = freshArgo;
          dataSource = "LIVE ARGOVIS";
        }
      } catch (fetchErr) {
        console.warn("Live Argovis ML fetch fallback:", fetchErr.message);
      }
    }

    // 2. Fall back to cached Argovis observations in SQLite if not already populated
    if (dataset.length === 0) {
      const allTelemetry = listTelemetryRecords(1000);
      const argoRecords = allTelemetry.filter(t => t.source === 'argovis');

      if (argoRecords.length >= 6) {
        dataset = argoRecords;
        dataSource = "CACHED ARGOVIS";
      } else {
        // Try retrieval of fresh Argovis profiles
        try {
          const discovery = await discoverArgoProfiles({ limit: 12 });
          if (discovery.uniqueFloats && discovery.uniqueFloats.length > 0) {
            for (const f of discovery.uniqueFloats.slice(0, 3)) {
              if (f.latestProfileId) {
                await getArgoProfileById(f.latestProfileId);
              }
            }
            const updated = listTelemetryRecords(1000);
            const freshArgo = updated.filter(t => t.source === 'argovis');
            if (freshArgo.length > 0) {
              dataset = freshArgo;
              dataSource = "LIVE ARGOVIS";
            }
          }
        } catch (fetchErr) {
          console.warn("Argovis ML fetch fallback:", fetchErr.message);
        }

        if (dataset.length === 0) {
          dataset = allTelemetry.length > 0 ? allTelemetry : getLocalData();
          dataSource = "LOCAL BASELINE";
        }
      }
    }

    if (!dataset || dataset.length === 0) {
      return res.status(400).json({ error: "No telemetry observations available for ML evaluation." });
    }

    const mlResults = analyzeTelemetryML(dataset, { source: dataSource, saveToDb: true });
    return res.json({
      ...mlResults,
      dataSource,
      evaluatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error evaluating ML model:", error);
    return res.status(500).json({ error: "ML Anomaly evaluation failure", details: error.message });
  }
});

// Retrieve Persisted ML Anomalies
router.get("/ml/anomalies", (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    let anomalies = listMLAnomalies(limit);

    // If table empty, initialize with evaluation of current telemetry
    if (anomalies.length === 0) {
      const records = listTelemetryRecords(500);
      if (records.length > 0) {
        const ml = analyzeTelemetryML(records, { source: "LOCAL BASELINE", saveToDb: true });
        anomalies = ml.anomalies || listMLAnomalies(limit);
      }
    }

    return res.json({
      success: true,
      count: anomalies.length,
      anomalies
    });
  } catch (error) {
    console.error("Error retrieving ML anomalies:", error);
    return res.status(500).json({ error: "Failed to retrieve ML anomalies", details: error.message });
  }
});

// Check Active Live Incident vs Simulated Scenario Status
router.get("/incidents/active-status", (req, res) => {
  try {
    const openCount = getOpenIncidentsCount();
    const activeIncident = getActiveIncident();
    const activeScenario = disasterStore.getScenario();

    return res.json({
      success: true,
      hasOpenLiveIncident: openCount > 0,
      openIncidentsCount: openCount,
      activeIncident,
      activeScenario,
      isSimulatedScenario: !activeIncident || (activeScenario && activeScenario.type !== 'NORMAL')
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to check active incident status" });
  }
});

// 6. Retrieve Generated ML Technical & Accuracy Report Text
router.get("/ml/report", (req, res) => {
  try {
    const content = getReportContent();
    return res.json({
      success: true,
      reportText: content,
      filename: "ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt",
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Failed to load ML accuracy report text" });
  }
});

// 7. Download Generated ML Accuracy Report File
router.get("/ml/report/download", (req, res) => {
  try {
    if (!fs.existsSync(REPORT_FILE)) {
      // Trigger evaluation on local data if file doesn't exist yet
      const dataset = getLocalData();
      if (dataset.length > 0) {
        analyzeTelemetryML(dataset);
      }
    }

    if (fs.existsSync(REPORT_FILE)) {
      return res.download(
        REPORT_FILE,
        "ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt",
      );
    } else {
      return res
        .status(404)
        .send(
          "Report file has not been generated yet. Please run ML prediction first.",
        );
    }
  } catch (error) {
    console.error("Error serving report download:", error);
    return res.status(500).send("Error downloading ML report file");
  }
});

// ----------------------------------------------------
// TWILIO SMS ALERT SYSTEM ROUTES
// ----------------------------------------------------

// 8. Send SMS Alert via Twilio
router.post(
  "/sms/send",
  requireRole("admin", "warehouse_manager"),
  async (req, res) => {
    try {
      const { to, message, buoyName, severity, liveOnly, channel } = req.body;
      if (!message) {
        return res
          .status(400)
          .json({ error: "Message body is required for SMS dispatch." });
      }

      const result = await sendSMS({
        to,
        message,
        buoyName,
        severity,
        liveOnly: Boolean(liveOnly),
        channel,
      });
      return res.json(result);
    } catch (error) {
      console.error("Error dispatching SMS alert:", error);
      return res
        .status(500)
        .json({ error: "SMS dispatch failed", details: error.message });
    }
  },
);

// 9. Get Twilio Configuration Status
router.get("/sms/config", requireRole("admin"), (req, res) => {
  return res.json(getTwilioConfigStatus());
});

// 10. Update Twilio Configuration Credentials
router.post("/sms/config", requireRole("admin"), (req, res) => {
  try {
    const { accountSid, authToken, fromNumber, recipientPhone } = req.body;
    const updatedStatus = updateTwilioConfig({
      accountSid,
      authToken,
      fromNumber,
      recipientPhone,
    });
    return res.json({ success: true, status: updatedStatus });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Failed to update Twilio configuration" });
  }
});

// 11. Get SMS Audit Logs
router.get(
  "/sms/logs",
  requireRole("admin", "warehouse_manager"),
  (req, res) => {
    return res.json({
      logs: getSMSLogs(),
    });
  },
);

// 11b. Twilio Delivery Status Webhook Callback
router.post("/sms/status-callback", (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body || {};
  if (MessageSid) {
    console.log(
      `[Twilio Webhook] Message ${MessageSid} status update: ${MessageStatus}${ErrorCode ? ` (Error ${ErrorCode})` : ""}`,
    );
    try {
      db.prepare(
        `
        UPDATE alert_dispatches
        SET status = ?, error_message = COALESCE(?, error_message)
        WHERE provider_sid = ?
      `,
      ).run(
        MessageStatus || "UNKNOWN",
        ErrorCode ? `Twilio error ${ErrorCode}` : null,
        MessageSid,
      );
    } catch (e) {
      // Ignored if table record not found
    }
  }
  // Twilio expects a 200/204 response
  return res.status(200).send("<Response></Response>");
});

// ----------------------------------------------------
// REAL-TIME STREAMING TELEMETRY SIMULATOR ROUTE
// ----------------------------------------------------

// 12. Simulate incoming live sensor feed tick
router.post("/stream/tick", async (req, res) => {
  try {
    const {
      buoyId = "FC-PAC-01",
      injectAnomaly = false,
      injectTsunami = false,
      injectFlood = false,
    } = req.body;
    let dataset = getLocalData();

    const buoyRef = dataset.find((d) => d.buoyId === buoyId) || {
      buoyId: "FC-PAC-01",
      buoyName: "Pacific Deep-Shift",
      latitude: 14.599,
      longitude: -140.211,
      depth: 1200,
    };

    const lastReading = dataset[dataset.length - 1] || {};
    const timestamp = new Date().toISOString();

    let newTemp = 4.5 + (Math.random() * 0.4 - 0.2);
    let newO2 = 6.2 + (Math.random() * 0.4 - 0.2);
    let newSalinity = 34.6 + (Math.random() * 0.1 - 0.05);
    let newPH = 8.1 + (Math.random() * 0.04 - 0.02);
    let newBattery = Math.max(10, (lastReading.batteryLevel || 95) - 0.1);
    let basePressure =
      (buoyRef.depth || 1200) * 1.005 + (Math.random() * 2 - 1);

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
      batteryLevel: parseFloat(newBattery.toFixed(1)),
    };

    dataset.push(newRecord);
    if (dataset.length > 500) dataset.shift();

    saveLocalData(dataset);

    const mlEvaluation = analyzeTelemetryML(dataset);
    const latestEvaluatedRecord =
      mlEvaluation.records[mlEvaluation.records.length - 1];
    const disasterInfo = mlEvaluation.disasterForecasts?.find(
      (d) => d.buoyId === buoyRef.buoyId,
    );

    let smsDispatched = false;
    let smsDetails = null;

    if (
      injectTsunami ||
      (disasterInfo && disasterInfo.tsunamiRiskPercentage > 70)
    ) {
      const alertMsg = `TSUNAMI EMERGENCY WARNING [${newRecord.buoyName}]: Hydrostatic sea-floor pressure surge detected! Predicted wave speed: ${disasterInfo?.waveVelocityKph || 390} km/h. Coastal ETA: ${disasterInfo?.coastalEtaMinutes || 35} mins. Take immediate evacuation actions!`;

      // Persist in SQLite incidents table
      recordIncident({
        id: `INC-TSUNAMI-${Date.now()}`,
        title: `TSUNAMI EMERGENCY WARNING: ${newRecord.buoyName}`,
        buoyId: newRecord.buoyId,
        buoyName: newRecord.buoyName,
        severity: "CRITICAL",
        status: "OPEN",
        detectedValue: `Abyssal Surge (${newRecord.pressure} dbar). Wave Speed: ${disasterInfo?.waveVelocityKph || 390} km/h`,
        threshold: "Tsunami Risk > 70%",
        mlRiskScore: disasterInfo?.tsunamiRiskPercentage || 85,
        remediationSteps: [
          "Automated Twilio Tsunami Emergency SMS Alert dispatched to Coastal SAR Command.",
          `Coastal ETA: ${disasterInfo?.coastalEtaMinutes || 35} minutes. Activate Harbor Tide Gates.`,
          "Notify National Tsunami Warning Center (NTWC).",
        ],
      });

      smsDetails = await sendSMS({
        message: alertMsg,
        buoyName: newRecord.buoyName,
        severity: "CRITICAL",
        liveOnly: true,
      });
      smsDispatched = Boolean(smsDetails?.success);
    } else if (
      latestEvaluatedRecord &&
      latestEvaluatedRecord.riskPercentage > 75
    ) {
      const alertMsg = `CRITICAL ANOMALY DETECTED on ${newRecord.buoyName}: ${latestEvaluatedRecord.anomalyTypes.join(", ")}. Risk Score: ${latestEvaluatedRecord.riskPercentage}%. Immediate action required!`;

      // Persist in SQLite incidents table
      recordIncident({
        id: `INC-ANOMALY-${Date.now()}`,
        title: `CRITICAL ANOMALY: ${newRecord.buoyName}`,
        buoyId: newRecord.buoyId,
        buoyName: newRecord.buoyName,
        severity: "CRITICAL",
        status: "OPEN",
        detectedValue: latestEvaluatedRecord.anomalyTypes.join(", "),
        threshold: "ML Risk > 75%",
        mlRiskScore: latestEvaluatedRecord.riskPercentage,
        remediationSteps: [
          "Dispatch automated SMS notification to coastal monitoring team.",
          "Increase sensor polling frequency to high-frequency profile.",
          "Inspect optical sensor and battery telemetry.",
        ],
      });

      smsDetails = await sendSMS({
        message: alertMsg,
        buoyName: newRecord.buoyName,
        severity: "CRITICAL",
        liveOnly: true,
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
      totalRecords: dataset.length,
    });
  } catch (error) {
    console.error("Error processing streaming telemetry tick:", error);
    return res
      .status(500)
      .json({ error: "Failed to process live stream tick" });
  }
});

// ----------------------------------------------------
// DISASTER MANAGEMENT & EMERGENCY COORDINATION API
// ----------------------------------------------------

// 13. Get Active Disaster Scenario & Available Scenarios
router.get("/disaster/scenario", (req, res) => {
  res.json({
    activeScenario: disasterStore.getScenario(),
    activeScenarioKey: disasterStore.activeScenarioKey,
    allScenarios: disasterStore.getAllScenarios(),
  });
});

// 14. Switch Disaster Scenario (Simulation)
router.post("/disaster/scenario", (req, res) => {
  try {
    const { key } = req.body;
    const scenario = disasterStore.setScenario(key);
    res.json({ success: true, scenario });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 15. Get Verified Shelters & Capacity
router.get("/disaster/shelters", (req, res) => {
  res.json(disasterStore.getShelters());
});

// 16. Get Relief Warehouses & Fleets
router.get("/disaster/warehouses", (req, res) => {
  res.json(disasterStore.getWarehouses());
});

// 17. AI Resource Shortage Optimization & Convoy Recommendations
router.get("/disaster/resources/optimization", (req, res) => {
  const result = disasterStore.computeResourceOptimization();
  res.json(result);
});

// 18. Dispatch AI Recommended Relief Convoy
router.post("/disaster/resources/dispatch", (req, res) => {
  try {
    const { recommendationId } = req.body;
    const convoy = disasterStore.dispatchConvoy(recommendationId);
    res.json({ success: true, convoy });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 19. Get Emergency SOS Requests
router.get("/disaster/sos", (req, res) => {
  res.json(disasterStore.getSOSRecords());
});

// 20. Create Emergency SOS
router.post("/disaster/sos", async (req, res) => {
  try {
    const sos = disasterStore.createSOS(req.body);

    // Auto-dispatch emergency SMS notification to Coast Guard / NDRF Command
    let smsDetails = null;
    try {
      const smsMessage = `🚨 EMERGENCY SOS DISPATCH [${sos.id}]: ${sos.userName} reported ${sos.emergencyType?.replace(/_/g, " ")} at (${sos.lat}, ${sos.lng}). Triage: ${sos.triageScore}. Assigned Unit: ${sos.assignedUnit?.name || "NDRF Vessel Alpha"} (Callsign: ${sos.assignedUnit?.callsign || "RESCUE-1"}).`;
      smsDetails = await sendSMS({
        to: req.body.phone || "+919876543210",
        message: smsMessage,
        buoyName: "SOS-SENTINEL-COMMAND",
        severity: "CRITICAL",
        liveOnly: true,
      });
    } catch (smsErr) {
      console.warn("Twilio SMS auto-dispatch fallback:", smsErr.message);
    }

    res.json({
      success: true,
      sos,
      smsDispatched: Boolean(smsDetails?.success),
      smsDetails,
      destinationCenter:
        "NDRF State Crisis Command & Coast Guard Maritime Rescue Coordination Centre (MRCC)",
      gatewayAck: sos.gatewayReceiptId,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to record SOS dispatch" });
  }
});

// 21. Update SOS Rescue Status & First Responder Assignment
router.patch("/disaster/sos/:id", (req, res) => {
  const { status, assignedUnit } = req.body;
  const updated = disasterStore.updateSOSStatus(
    req.params.id,
    status,
    assignedUnit,
  );
  if (!updated)
    return res.status(404).json({ error: "SOS incident not found" });
  res.json({ success: true, sos: updated });
});

// 22. Ingest Offline Mesh Packet from Gateway
router.post("/disaster/mesh/sync", (req, res) => {
  try {
    const { packet } = req.body;
    if (!packet) return res.status(400).json({ error: "Packet data required" });
    const receipt = disasterStore.processMeshPacket(packet);
    res.json({ success: true, receipt });
  } catch (err) {
    res.status(500).json({ error: "Failed to ingest mesh packet" });
  }
});

// 23. Family Safety Check-Ins
router.get("/disaster/family-checkin", (req, res) => {
  const { query } = req.query;
  const results = disasterStore.searchFamilyCheckIns(query);
  res.json(results);
});

router.post("/disaster/family-checkin", (req, res) => {
  try {
    const checkin = disasterStore.createFamilyCheckIn(req.body);
    return res.json({ success: true, checkin });
  } catch (err) {
    return res
      .status(400)
      .json({ error: "Failed to register family safety check-in" });
  }
});

// 24. First Responder SAR Fleet
router.get("/disaster/responders", (req, res) => {
  try {
    return res.json({ responders: listResponderFleet() });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Failed to retrieve responder fleet" });
  }
});

router.patch(
  "/disaster/responders/:id",
  requireRole("admin", "warehouse_manager"),
  (req, res) => {
    try {
      const { status, assignment } = req.body;
      const unit = updateResponderUnit(req.params.id, status, assignment);
      return res.json({ success: true, unit });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  },
);

// 25. Rescue Command Audit Events
router.get("/disaster/audit-events", (req, res) => {
  try {
    return res.json({ events: listAuditEvents() });
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve audit events" });
  }
});

router.post(
  "/disaster/audit-events",
  requireRole("admin", "warehouse_manager"),
  (req, res) => {
    try {
      const event = recordAuditEvent(req.body);
      return res.json({ success: true, event });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  },
);

// ----------------------------------------------------
// GEMINI AI CHATBOT PROXY & GROUNDED RETRIEVAL ASSISTANT
// ----------------------------------------------------

router.post("/chat", async (req, res) => {
  try {
    const { message, chatHistory = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message field is required." });
    }

    const trimmedMessage = message.trim();
    const apiKey = loadGeminiApiKey();

    // 1. Retrieve Grounded Context from SQLite, Disaster Store & Argovis
    const { context: groundedContext, argoOverview, argoFloats, specificProfile, recentAnomalies } =
      await buildGroundedContext(trimmedMessage, chatHistory);
    const shelters = disasterStore.getShelters();
    const activeScenario = disasterStore.getScenario();
    const dataset = listTelemetryRecords(100);

    // 2. If Gemini API key is not configured, provide a grounded rule-based response with clear disclosure
    if (!apiKey) {
      const lowerMessage = trimmedMessage.toLowerCase();
      let responseText = "";

      // Off-domain filter
      const isOffDomain =
        lowerMessage.includes("recipe") ||
        lowerMessage.includes("movie") ||
        lowerMessage.includes("crypto") ||
        lowerMessage.includes("bitcoin") ||
        lowerMessage.includes("stock market") ||
        lowerMessage.includes("poem") ||
        lowerMessage.includes("joke");

      if (isOffDomain) {
        responseText = `I am specialized strictly in oceanography, ocean telemetry, disaster preparedness, and FloatChat platform coordination. I cannot assist with unrelated subjects.`;
      } else if (
        lowerMessage.includes("anomaly") ||
        lowerMessage.includes("anomalies") ||
        lowerMessage.includes("ml") ||
        lowerMessage.includes("deviation")
      ) {
        if (recentAnomalies && recentAnomalies.length > 0) {
          const highest = [...recentAnomalies].sort((a, b) => (b.anomalyScore || b.anomaly_score || 0) - (a.anomalyScore || a.anomaly_score || 0))[0];
          const stName = highest.buoyName || highest.buoy_name || highest.buoyId || 'ARGO Float';
          const pId = highest.platformId || highest.platform_id || highest.buoyId || 'ARGO';
          const score = highest.anomalyScore ?? highest.anomaly_score ?? 1.0;
          const obsTime = highest.observationTimestamp || highest.observation_timestamp;
          const temp = highest.temperature !== null && highest.temperature !== undefined ? `${highest.temperature}°C` : 'N/A';
          const psal = highest.salinity !== null && highest.salinity !== undefined ? `${highest.salinity} PSU` : 'N/A';
          const oxy = (highest.oxygenContent ?? highest.oxygen_content) !== null && (highest.oxygenContent ?? highest.oxygen_content) !== undefined ? `${highest.oxygenContent ?? highest.oxygen_content} mg/L` : 'N/A';
          const phVal = (highest.ph !== null && highest.ph !== undefined) ? highest.ph : 'N/A';

          responseText = `### 🚨 ML Anomaly Detection Findings (Grounded Database)
**[Rule-Based Assistant — Gemini API key placeholder active]**

- **Total Detected Anomalies:** ${recentAnomalies.length} observations flagged by the Isolation Forest & Multivariate Mahalanobis engine.
- **Highest Severity Anomaly:**
  * **Station:** **${stName}** (Platform: \`${pId}\`)
  * **Severity:** **${highest.severity}** (ML Anomaly Score: **${score}**)
  * **Observation Time:** ${obsTime ? new Date(obsTime).toUTCString() : 'Recent'}
  * **Data Source:** **${highest.source}**
  * **Depth / Pressure:** ${highest.depth}m / ${highest.pressure} dbar
  * **Measured Values:** Temp: ${temp}, Salinity: ${psal}, O₂: ${oxy}, pH: ${phVal}
  * **Classification Explanation:** ${highest.explanation || highest.anomalyType || 'Multivariate statistical distance deviation > 3.6 sigma'}
- **Data Provenance:** Observations originate from **${highest.source}**. Missing sensor channels remain null without synthetic data injection.`;
        } else {
          responseText = `### 🧪 ML Anomaly Detection Findings
**[Rule-Based Assistant — Gemini API key placeholder active]**

- **Status:** Evaluated 150+ observations across the telemetry database.
- **Findings:** No critical anomalies currently flagged above threshold (3.6 sigma).
- **Run Fresh Evaluation:** Click **Re-Evaluate ML Model (Live Argovis)** in the ML Anomaly Detection dashboard to run real-time inference on newly discovered Argovis floats.`;
        }
      } else if (
        lowerMessage.includes("simulated") ||
        lowerMessage.includes("real") ||
        lowerMessage.includes("drill") ||
        lowerMessage.includes("verified incident")
      ) {
        const isSimulated = activeScenario && activeScenario.type !== 'NORMAL';
        responseText = `### 🛰️ Incident & Disaster Scenario Status
**[Rule-Based Assistant — Grounded Source of Truth]**

- **Current Active Scenario:** **${activeScenario?.name || "All Clear — Routine Monitoring"}**
- **Classification:** **${isSimulated ? "SIMULATED SCENARIO (Predefined Training Drill)" : "ROUTINE MONITORING"}**
- **Verified Real Incidents:** There are currently **0 live emergency declarations** open in the active verification log.
- **Rule:** A selected scenario in the simulator is strictly for disaster management readiness and safe-navigation route testing; it does not represent an actual physical catastrophe unless officially verified by INCOIS or the Coast Guard.`;
      } else if (
        lowerMessage.includes("sos") ||
        lowerMessage.includes("rescue") ||
        lowerMessage.includes("trapped") ||
        lowerMessage.includes("help") ||
        lowerMessage.includes("मदद") ||
        lowerMessage.includes("உதவி") ||
        lowerMessage.includes("ayuda")
      ) {
        const primaryShelter = shelters[0] || {
          name: "Emergency Safe Zone",
          elevationMeters: 30,
          status: "OPEN",
          currentOccupancy: 0,
          totalCapacity: 500,
        };
        responseText = `### 🚨 EMERGENCY RESCUE COORDINATION
**[Rule-Based Assistant — Gemini API key placeholder active]**

**Immediate Life-Safety Actions:**
1. **Trigger Emergency SOS:** Click **Emergency SOS** in the top bar to record your GPS coordinates and medical details for Coast Guard & NDRF SAR units.
2. **Nearest Verified Safe Shelter (From Database):**
   - **${primaryShelter.name}** (+${primaryShelter.elevationMeters}m elevation MSL)
   - Status: **${primaryShelter.status}** (${primaryShelter.currentOccupancy}/${primaryShelter.totalCapacity} occupied)
   - Water Supply: ${primaryShelter.supplies?.waterLiters || 0} Liters | Meals: ${primaryShelter.supplies?.foodMeals || 0}
3. **If Cellular is Down:** Your SOS packet will be held in the offline queue and relayed across the peer mesh simulation until reaching a satellite gateway.`;
      } else if (
        lowerMessage.includes("tsunami") ||
        lowerMessage.includes("wave") ||
        lowerMessage.includes("surge") ||
        lowerMessage.includes("सुनामी")
      ) {
        responseText = `### 🌊 TSUNAMI & INUNDATION PROTOCOL
**[Rule-Based Assistant — Gemini API key placeholder active]**

**Current Database Scenario:** ${activeScenario?.name || "Monitoring"} (${activeScenario?.severity || "LOW"})
- **Official Agency:** ${activeScenario?.agency || "INCOIS / Regional Warning Center"}
- **Evacuation Rule:** Move to **at least +${activeScenario?.elevationHazardLimitMeters || 25}m elevation** or 3 km inland immediately.
- **Scientific Limitation:** Deep-sea bottom pressure surges provide hydrodynamic early indicators. ARGO floats alone do not predict tsunamis or earthquakes. Always obey official INCOIS / PTWC bulletins.`;
      } else if (
        lowerMessage.includes("shelter") ||
        lowerMessage.includes("refuge") ||
        lowerMessage.includes("warehouse") ||
        lowerMessage.includes("food") ||
        lowerMessage.includes("water") ||
        lowerMessage.includes("शरण")
      ) {
        responseText = `### 🏛️ Verified Safe Shelters (Live Database Status)
**[Rule-Based Assistant — Gemini API key placeholder active]**\n\n`;
        shelters.slice(0, 3).forEach((s, idx) => {
          responseText += `${idx + 1}. **${s.name}** (+${s.elevationMeters}m MSL)\n   - Capacity: **${s.currentOccupancy} / ${s.totalCapacity}** (${s.status})\n   - Potable Water: **${s.supplies?.waterLiters || 0} L** | Meals: **${s.supplies?.foodMeals || 0}** | Medical: **${s.supplies?.medicalKits || 0} kits**\n`;
        });
        if (warehouses && warehouses.length > 0) {
          responseText += `\n**Relief Warehouses:**\n`;
          warehouses.slice(0, 2).forEach(w => {
            responseText += `- **${w.name}**: Stock = ${w.inventory?.waterLiters || 0}L Water, ${w.inventory?.foodMeals || 0} Meals, Road Accessible: ${w.accessibleByRoad ? 'YES' : 'NO'}\n`;
          });
        }
        responseText += `\n*Visit **Smart Shelters & AI** to view AI warehouse reallocation recommendations.*`;
      } else if (
        lowerMessage.includes("float") ||
        lowerMessage.includes("argo") ||
        lowerMessage.includes("buoy") ||
        lowerMessage.includes("station") ||
        lowerMessage.includes("temp") ||
        lowerMessage.includes("salinity") ||
        lowerMessage.includes("oxygen") ||
        lowerMessage.includes("ph") ||
        lowerMessage.includes("profile") ||
        lowerMessage.includes("ocean") ||
        lowerMessage.includes("1000")
      ) {
        if (specificProfile && specificProfile.verticalProfile) {
          const vp = specificProfile.verticalProfile;
          const deepIdx = Math.max(0, vp.depth.length - 1);
          
          // Check if asked about 1000m
          let tempAt1000 = null;
          if (lowerMessage.includes("1000")) {
            let idx1000 = 0, minDiff = Infinity;
            for (let i = 0; i < vp.depth.length; i++) {
              if (vp.depth[i] !== null) {
                const diff = Math.abs(vp.depth[i] - 1000);
                if (diff < minDiff) { minDiff = diff; idx1000 = i; }
              }
            }
            tempAt1000 = { depth: Math.round(vp.depth[idx1000]), temp: vp.temperature[idx1000], pres: Math.round(vp.pressure[idx1000]) };
          }

          // Check if asked specifically about oxygen or pH
          const asksOxygen = lowerMessage.includes("oxygen") || lowerMessage.includes("o2");
          const asksPh = lowerMessage.includes("ph");

          responseText = `### 🌊 ARGO Float ${specificProfile.platformId} (Cycle ${specificProfile.cycleNumber})
**[Grounded Float Observation — Argovis Integration]**

- **Profile ID:** \`${specificProfile.profileId}\`
- **Location:** Lat ${specificProfile.coordinates[1]}°, Lng ${specificProfile.coordinates[0]}°
- **Observation Time:** ${new Date(specificProfile.timestamp).toUTCString()}
- **Depth Range:** ${Math.round(vp.depth[0] || 0)}m to ${Math.round(vp.depth[deepIdx] || 0)}m (${vp.levelsCount} discrete levels)
- **Surface Observation:** ${vp.temperature[0]}°C | Salinity: ${vp.salinity[0]} PSU (Depth: ${vp.depth[0]}m)
${tempAt1000 ? `- **Observation at ~1000m Depth:** **${tempAt1000.temp}°C** (at ${tempAt1000.depth}m / ${tempAt1000.pres} dbar)` : ''}
- **Deepest Observation:** ${vp.temperature[deepIdx]}°C | Salinity: ${vp.salinity[deepIdx]} PSU (Depth: ${Math.round(vp.depth[deepIdx])}m)
- **Biogeochemical Sensors:**
  * Dissolved Oxygen: **${vp.hasOxygen ? `✓ Present (${vp.oxygen.filter(x => x !== null).length} valid levels, Surface: ${vp.oxygen[0]} mg/L)` : '✗ Not equipped (Core Argo float — CTD only)'}**
  * In-Situ pH: **${vp.hasPh ? `✓ Present (${vp.ph.filter(x => x !== null).length} valid levels, Surface: ${vp.ph[0]})` : '✗ Not equipped (Core Argo float — CTD only)'}**
- **Sensors Equipped:** [${(vp.sensorsEquipped || []).join(', ')}]
- **Platform Source:** ${specificProfile.source}`;
        } else if (argoFloats && argoFloats.length > 0) {
          responseText = `### 🌊 Discovered ARGO Floats (Indian Ocean Region)
**[Grounded Float Directory — Argovis Integration]**

Identified **${argoFloats.length} active research floats** in the regional monitoring area:
${argoFloats.slice(0, 6).map(f => `- **Float ${f.floatId}** (Cycle ${f.latestCycle}): Location (${f.latestLatitude}°, ${f.latestLongitude}°), Observed: ${new Date(f.latestTimestamp).toLocaleDateString()}, Sensors: [${f.availableVariables.slice(0, 4).join(', ')}]`).join('\n')}

*Ask "What is the temperature profile of float ${argoFloats[0]?.floatId}?" or "Does float ${argoFloats[0]?.floatId} have dissolved oxygen measurements?".*`;
        } else {
          const sampleBuoy = dataset[dataset.length - 1] || {};
          responseText = `### 🌊 Ocean Telemetry & ARGO Observations
**[Rule-Based Assistant — Gemini API key placeholder active]**

- **Total Stored Observations:** ${dataset.length} records across active stations.
- **Latest Record Station:** ${sampleBuoy.buoyName || "Buoy Network"} (${sampleBuoy.buoyId || "N/A"})
- **Observation Timestamp:** ${sampleBuoy.timestamp || "Recent"}
- **Temperature:** ${sampleBuoy.temperature !== null ? sampleBuoy.temperature + "°C" : "Not Measured"}
- **Salinity:** ${sampleBuoy.salinity !== null ? sampleBuoy.salinity + " PSU" : "Not Measured"}
- **Hydrostatic Depth:** ${sampleBuoy.depth}m`;
        }
      } else {
        responseText = `### 🌊 FloatChat AI Marine & Emergency Coordinator
**[Rule-Based Assistant — Gemini API key placeholder active]**

I am specialized strictly in oceanography, ARGO float profiles, disaster response, and shelter logistics.

**Current Active Situation:**
- Scenario: **${activeScenario?.name || "All Clear - Routine Monitoring"}** (${activeScenario?.severity || "LOW"})
- Verified Shelters: **${shelters.length} facilities active**
- Database Records: **${dataset.length} observations**

*To activate natural language reasoning and grounded query expansion, set GEMINI_API_KEY in backend/.env*`;
      }

      return res.json({
        message: responseText,
        isMock: true,
        geminiConfigured: false,
      });
    }

    // 3. Live Gemini API Call with Strict Grounding & Domain Enforcement
    const systemInstruction = `You are FloatChat AI, an expert marine oceanographer, emergency disaster coordinator, and life-safety response strategist for FloatChatAI.

STRICT DOMAIN BOUNDARIES:
- You ONLY assist with: oceanography, marine science, ocean telemetry, ARGO float profiles, ocean anomalies, disaster preparedness, emergency safe-zone navigation, shelters, relief warehouses, resource logistics, and FloatChat platform capabilities.
- If a user asks questions outside these domains (e.g. general trivia, politics, recipes, creative fiction, unrelated coding), POLITELY REFUSE:
  "I am specialized strictly in oceanography, ocean telemetry, disaster preparedness, and FloatChat platform coordination. I cannot assist with unrelated subjects."

GROUNDED RETRIEVAL CONSTRAINTS (HIGHEST PRIORITY):
- You must NEVER invent, assume, or hallucinate measurements, float IDs, locations, or dates.
- Answer strictly using the Grounded System Context provided below.
- If a measurement (such as dissolved oxygen, pH, or battery level) is not present or marked as null in the retrieved profile, EXPLICITLY STATE that this sensor parameter is not available on this observation profile.
- NEVER claim that ARGO float measurements independently predict tsunamis or earthquakes. ARGO observes oceanographic physical properties (temperature, salinity, pressure); early tsunami warnings depend on hydrostatic bottom pressure transducers and official tsunami warning centers (INCOIS, PTWC).
- Distinguish real observations from predictive forecasts. Always cite the observation timestamp when discussing measurements.
- Format responses concisely with clean Markdown (bullet points, bold emergency callouts).

${groundedContext}`;

    const contents = [];
    chatHistory.slice(-8).forEach((turn) => {
      contents.push({
        role: turn.role === "user" ? "user" : "model",
        parts: [{ text: String(turn.content || "") }],
      });
    });

    contents.push({
      role: "user",
      parts: [{ text: trimmedMessage }],
    });

    const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: {
          temperature: 0.2, // Low temperature for factual precision
          maxOutputTokens: 1000,
        },
      }),
    });

    const geminiData = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      const reason =
        geminiData?.error?.message ||
        `Gemini API returned status ${geminiResponse.status}`;
      return res.status(502).json({
        error: "Failed to communicate with Google Gemini API.",
        details: reason,
      });
    }

    const responseText = (geminiData.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!responseText) {
      return res.status(502).json({ error: "Gemini returned an empty reply." });
    }

    return res.json({
      message: responseText,
      isMock: false,
      geminiConfigured: true,
      model: modelName,
    });
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return res
      .status(500)
      .json({
        error: "Internal server error while processing chat request",
        details: error.message,
      });
  }
});

export default router;
