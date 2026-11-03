import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { fileURLToPath } from "url";

import { analyzeTelemetryML, analyzeArgoFloatProfileHistory, getReportContent } from "./mlEngine.js";
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

function listEvaluableArgoObservations(limit = 5000) {
  const measuredFields = ['temperature', 'salinity', 'pressure', 'oxygenContent', 'ph'];
  const measured = listTelemetryRecords(limit).filter(record =>
    record.source === 'argovis' && measuredFields.some(field =>
      record[field] !== null && record[field] !== undefined && Number.isFinite(Number(record[field]))
    )
  );
  const byObservation = new Map();
  for (const record of measured) {
    const level = record.pressure !== null && record.pressure !== undefined && Number.isFinite(Number(record.pressure)) ? `p:${Number(record.pressure).toFixed(1)}`
      : record.depth !== null && record.depth !== undefined && Number.isFinite(Number(record.depth)) ? `d:${Number(record.depth).toFixed(1)}`
        : `v:${record.temperature ?? ''}|${record.salinity ?? ''}|${record.oxygenContent ?? ''}|${record.ph ?? ''}`;
    const key = `${record.buoyId}|${record.timestamp}|${level}`;
    const previous = byObservation.get(key);
    if (!previous || Number(record.id) > Number(previous.id)) byObservation.set(key, record);
  }
  return { records: [...byObservation.values()], duplicatesRemoved: measured.length - byObservation.size };
}

function tagArgoRetrievalSource(dataset, retrievalSource) {
  const sourceLabel = retrievalSource.includes('LIVE')
    ? 'ARGOVIS API-backed SQLite cache; refresh completed this evaluation, but per-row refresh time is not stored'
    : 'ARGOVIS API-backed SQLite cache; per-row refresh time is not stored';
  return dataset.map(record => ({ ...record, retrievalSource: sourceLabel }));
}
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
function inferChatFollowup(userQuery, chatHistory = []) {
  const floatPattern = /\b(\d{7})(?:_(\d{1,3}))?\b/;
  const directMatch = userQuery.match(floatPattern);
  const recentTurns = Array.isArray(chatHistory) ? [...chatHistory].reverse() : [];
  let previousUserQuery = '';
  let floatMatch = directMatch;

  for (const turn of recentTurns) {
    if (!previousUserQuery && turn?.role === 'user' && typeof turn.content === 'string') {
      previousUserQuery = turn.content;
    }
    if (!floatMatch && typeof turn?.content === 'string') {
      floatMatch = turn.content.match(floatPattern);
    }
    if (previousUserQuery && floatMatch) break;
  }

  const comparePattern = /\b(compare|compared|comparison|difference|change|changed|previous|prior|preceding|earlier|last observation|warmer|cooler|higher|lower)\b/i;
  const isShortFollowup = !directMatch && userQuery.trim().split(/\s+/).length <= 10 &&
    /\b(it|its|this float|that float|that|same)\b/i.test(userQuery);
  const inheritedComparison = isShortFollowup && comparePattern.test(previousUserQuery);
  const asksOtherFloat = /\b(compare|against|versus|vs\.?|another|other float)\b/i.test(userQuery) &&
    /\b(float|one|this|that|it)\b/i.test(userQuery);

  let field = null;
  if (/\b(temp|temperature|thermal|warmer|cooler)\b/i.test(userQuery)) field = 'temperature';
  else if (/\b(salinity|salt)\b/i.test(userQuery)) field = 'salinity';
  else if (/\b(oxygen|o2|doxy)\b/i.test(userQuery)) field = 'oxygen';
  else if (/\b(ph|acidity)\b/i.test(userQuery)) field = 'ph';
  else if (/\b(pressure|pres)\b/i.test(userQuery)) field = 'pressure';
  else if (inheritedComparison) {
    const previousFieldMatch = previousUserQuery.match(/\b(temp|temperature|thermal|salinity|salt|oxygen|o2|doxy|ph|acidity|pressure|pres)\b/i);
    const fieldToken = previousFieldMatch?.[0]?.toLowerCase();
    field = fieldToken && /temp|thermal/.test(fieldToken) ? 'temperature'
      : fieldToken && /salinity|salt/.test(fieldToken) ? 'salinity'
        : fieldToken && /oxygen|o2|doxy/.test(fieldToken) ? 'oxygen'
          : fieldToken && /ph|acidity/.test(fieldToken) ? 'ph'
            : fieldToken ? 'pressure' : null;
  }

  const wantsComparison = comparePattern.test(userQuery) || inheritedComparison || asksOtherFloat;
  return {
    floatId: floatMatch?.[1] || null,
    cycleNumber: directMatch?.[2] || floatMatch?.[2] || null,
    field,
    wantsComparison,
    wantsPreviousObservation: /\b(previous|prior|preceding|earlier|last observation)\b/i.test(userQuery) || inheritedComparison,
    asksOxygenConcern: /\b(oxygen|o2|doxy)\b/i.test(userQuery) && /\b(concern|low|hypoxia|safe|okay|ok|level)\b/i.test(userQuery),
    asksOtherFloat,
    isFollowup: !directMatch && recentTurns.some((turn) => turn?.role === 'user') &&
      /\b(it|its|this float|that float|that|same|previous|prior|earlier)\b/i.test(userQuery)
  };
}

const CHAT_PROFILE_FIELDS = {
  temperature: { array: 'temperature', label: 'temperature', unit: '°C' },
  salinity: { array: 'salinity', label: 'salinity', unit: 'PSU' },
  oxygen: { array: 'oxygen', label: 'dissolved oxygen', unit: 'mg/L' },
  ph: { array: 'ph', label: 'pH', unit: '' },
  pressure: { array: 'pressure', label: 'pressure', unit: 'dbar' },
};

function profilePointNearDepth(profile, field, targetDepth = null) {
  const config = CHAT_PROFILE_FIELDS[field];
  const vp = profile?.verticalProfile;
  const values = vp?.[config?.array];
  if (!Array.isArray(values) || !Array.isArray(vp.depth)) return null;
  const points = values.map((rawValue, index) => ({ rawValue, rawDepth: vp.depth[index] }))
    .filter((point) => point.rawValue !== null && point.rawValue !== undefined && point.rawDepth !== null && point.rawDepth !== undefined)
    .map((point) => ({ value: Number(point.rawValue), depth: Number(point.rawDepth) }))
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.depth));
  if (!points.length) return null;
  if (targetDepth === null) return points.sort((a, b) => a.depth - b.depth)[0];
  return points.sort((a, b) => Math.abs(a.depth - targetDepth) - Math.abs(b.depth - targetDepth))[0];
}

function compareProfilesAtDepth(currentProfile, previousProfile, field) {
  if (!currentProfile || !previousProfile || !CHAT_PROFILE_FIELDS[field]) return null;
  const currentTime = new Date(currentProfile.timestamp).getTime();
  const previousTime = new Date(previousProfile.timestamp).getTime();
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime) || previousTime >= currentTime) {
    return { field, unavailable: 'The retrieved profiles do not have distinct, correctly ordered observation timestamps.' };
  }
  const current = profilePointNearDepth(currentProfile, field);
  if (!current) return { field, unavailable: 'The measurement is not available in the latest profile.' };
  const previous = profilePointNearDepth(previousProfile, field, current.depth);
  if (!previous) return { field, unavailable: 'The measurement is not available in the previous profile.' };
  if (Math.abs(current.depth - previous.depth) > 50) {
    return { field, unavailable: `No previous-profile ${CHAT_PROFILE_FIELDS[field].label} measurement is available within 50 m of the latest depth.` };
  }
  return {
    field,
    label: CHAT_PROFILE_FIELDS[field].label,
    unit: CHAT_PROFILE_FIELDS[field].unit,
    current: { ...current, timestamp: currentProfile.timestamp, profileId: currentProfile.profileId },
    previous: { ...previous, timestamp: previousProfile.timestamp, profileId: previousProfile.profileId },
    difference: current.value - previous.value,
  };
}

function cachedProfileFromRows(rows, platformId) {
  const ordered = [...rows].sort((a, b) => Number(a.depth) - Number(b.depth));
  if (!ordered.length) return null;
  const hasValues = (field) => ordered.some((row) => row[field] !== null && row[field] !== undefined);
  return {
    profileId: null,
    platformId,
    cycleNumber: null,
    timestamp: ordered[0].timestamp,
    source: 'SQLite cached observations',
    coordinates: [ordered[0].longitude, ordered[0].latitude],
    verticalProfile: {
      levelsCount: ordered.length,
      depth: ordered.map((row) => row.depth),
      temperature: ordered.map((row) => row.temperature),
      pressure: ordered.map((row) => row.pressure),
      salinity: ordered.map((row) => row.salinity),
      oxygen: ordered.map((row) => row.oxygenContent),
      ph: ordered.map((row) => row.ph),
      hasOxygen: hasValues('oxygenContent'),
      hasPh: hasValues('ph'),
      sensorsEquipped: ['pressure', 'temperature', 'salinity', 'oxygenContent', 'ph']
        .filter((field) => hasValues(field)),
    },
  };
}

async function buildGroundedContext(userQuery = "", chatHistory = []) {
  const dataset = listTelemetryRecords(5000).slice(-100);
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
  let previousProfile = null;
  let otherFloatProfile = null;
  const followup = inferChatFollowup(userQuery, chatHistory);
  let profileComparison = null;

  try {
    const overviewRes = await getArgoOverview();
    if (overviewRes && overviewRes.data) {
      argoOverview = overviewRes.data;
    }

    const discoveryRes = await discoverArgoProfiles({ limit: 20 });
    if (discoveryRes && Array.isArray(discoveryRes.uniqueFloats)) {
      argoFloats = discoveryRes.uniqueFloats.slice(0, 10);
    }

    // Resolve explicit float IDs first, then use the most recent chat turn that
    // named a float. Profile metadata is sorted by timestamp, never by depth row.
    const floatId = followup.floatId;
    const cycleNum = followup.cycleNumber;
    let floatProfiles = [];
    if (floatId) {
      const floatDiscovery = await discoverArgoProfiles({ platform: floatId, limit: 100 });
      if (Array.isArray(floatDiscovery.profiles)) {
        floatProfiles = floatDiscovery.profiles
          .filter((profile) => String(profile?._id || '').startsWith(`${floatId}_`))
          .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      }
      const requestedIndex = cycleNum
        ? floatProfiles.findIndex((profile) => String(profile._id).endsWith(`_${cycleNum}`))
        : 0;
      const selectedIndex = requestedIndex >= 0 ? requestedIndex : (cycleNum ? -1 : 0);
      const selectedProfileId = floatProfiles[selectedIndex]?._id ||
        (cycleNum ? `${floatId}_${cycleNum}` : argoFloats.find((item) => item.floatId === floatId)?.latestProfileId);

      if (selectedProfileId) {
        const currentResult = await getArgoProfileById(selectedProfileId);
        if (currentResult?.success) specificProfile = currentResult;
      }

      const previousMetadata = selectedIndex >= 0 ? floatProfiles[selectedIndex + 1] : null;
      if (followup.wantsComparison && followup.wantsPreviousObservation && previousMetadata?._id) {
        const previousResult = await getArgoProfileById(previousMetadata._id, { persist: false });
        if (previousResult?.success) previousProfile = previousResult;
      }

      // Offline/cached fallback: group database depth samples by their shared
      // profile timestamp so only distinct casts count as previous observations.
      if (!specificProfile || (followup.wantsPreviousObservation && !previousProfile)) {
        const cachedRows = listTelemetryRecords(5000).filter((row) =>
          row.source === 'argovis' && String(row.buoyId || '').replace(/^ARGO-/, '') === floatId
        );
        const byTimestamp = new Map();
        cachedRows.forEach((row) => {
          if (!byTimestamp.has(row.timestamp)) byTimestamp.set(row.timestamp, []);
          byTimestamp.get(row.timestamp).push(row);
        });
        const cachedProfiles = [...byTimestamp.entries()]
          .sort(([a], [b]) => new Date(b) - new Date(a))
          .map(([, rows]) => cachedProfileFromRows(rows, floatId));
        if (!specificProfile && cachedProfiles.length) specificProfile = cachedProfiles[0];
        if (followup.wantsPreviousObservation && !previousProfile && specificProfile?.timestamp) {
          previousProfile = cachedProfiles.find((profile) => new Date(profile.timestamp) < new Date(specificProfile.timestamp)) || null;
        }
      }

      if (specificProfile && previousProfile && followup.wantsPreviousObservation && followup.field) {
        profileComparison = compareProfilesAtDepth(specificProfile, previousProfile, followup.field);
      }
    }

    if (followup.asksOtherFloat) {
      const otherFloat = argoFloats.find((item) => item.floatId !== floatId && item.latestProfileId);
      if (otherFloat) {
        const otherResult = await getArgoProfileById(otherFloat.latestProfileId, { persist: false });
        if (otherResult?.success) otherFloatProfile = otherResult;
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

  // Summarize changes across distinct observation times only. Depth samples from one
  // ARGO cast are not a time series and must not be presented as a temporal forecast.
  context += `\n[OBSERVED OCEAN CONDITION TRENDS — descriptive, not a weather forecast]\n`;
  Object.entries(buoySummary).forEach(([id, station]) => {
    const times = new Map();
    dataset.filter((item) => item.buoyId === id).forEach((item) => {
      const time = item.timestamp;
      if (!times.has(time)) times.set(time, []);
      times.get(time).push(item);
    });
    const snapshots = [...times.entries()].sort(([a], [b]) => new Date(a) - new Date(b));
    if (snapshots.length < 2) {
      context += `- ${station.name} (${id}): Insufficient distinct observation times to describe a temporal trend.\n`;
      return;
    }
    const summarize = (rows, field) => {
      const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const firstRows = snapshots[0][1];
    const lastRows = snapshots[snapshots.length - 1][1];
    const changes = ['temperature', 'salinity', 'oxygenContent', 'ph'].map((field) => {
      const start = summarize(firstRows, field);
      const end = summarize(lastRows, field);
      return start === null || end === null ? `${field}=unavailable` : `${field} ${start.toFixed(2)} → ${end.toFixed(2)} (Δ ${(end - start).toFixed(2)})`;
    });
    context += `- ${station.name} (${id}): ${snapshots.length} distinct observation times from ${snapshots[0][0]} to ${snapshots.at(-1)[0]}; ${changes.join('; ')}. Descriptive endpoint comparison only.\n`;
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
    context += `- Detailed Vertical Profile for Float ${specificProfile.platformId} (Profile ${specificProfile.profileId || 'cached observations'}, Cycle ${specificProfile.cycleNumber ?? 'N/A'}):\n`;
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

  if (followup.floatId) {
    context += `\n[CHAT SESSION FOLLOW-UP RESOLUTION]\n`;
    context += `- Current conversational float: ${followup.floatId}. Treat pronouns in this turn as referring to this float unless the user names another.\n`;
    if (specificProfile) {
      context += `- Current profile: ${specificProfile.profileId} observed ${specificProfile.timestamp}. Its vertical levels are one cast, not separate observations in time.\n`;
    }
    if (previousProfile) {
      context += `- Previous distinct profile: ${previousProfile.profileId} observed ${previousProfile.timestamp}.\n`;
    } else if (followup.wantsPreviousObservation) {
      context += `- No earlier distinct profile for this float was retrieved; do not infer a temporal change from levels within one cast.\n`;
    }
    if (profileComparison) {
      if (profileComparison.unavailable) {
        context += `- Requested comparison (${followup.field}): unavailable. ${profileComparison.unavailable}\n`;
      } else {
        context += `- Requested ${profileComparison.label} comparison at comparable depths: current ${profileComparison.current.value}${profileComparison.unit} at ${profileComparison.current.depth} m on ${profileComparison.current.timestamp}; previous ${profileComparison.previous.value}${profileComparison.unit} at ${profileComparison.previous.depth} m on ${profileComparison.previous.timestamp}; difference current minus previous = ${profileComparison.difference.toFixed(3)}${profileComparison.unit}.\n`;
      }
    }
    if (otherFloatProfile) {
      const otherTemp = profilePointNearDepth(otherFloatProfile, 'temperature');
      const otherSalinity = profilePointNearDepth(otherFloatProfile, 'salinity');
      context += `- Comparison float: ${otherFloatProfile.platformId}, profile ${otherFloatProfile.profileId}, observed ${otherFloatProfile.timestamp}; shallowest available temperature=${otherTemp ? `${otherTemp.value} °C at ${otherTemp.depth} m` : 'N/A'}, salinity=${otherSalinity ? `${otherSalinity.value} PSU at ${otherSalinity.depth} m` : 'N/A'}. Compare values descriptively and note that floats may be in different locations and times.\n`;
    } else if (followup.asksOtherFloat) {
      context += `- No second float profile was retrieved for a comparison.\n`;
    }
  }

  // 7. ML Anomaly Detection Engine Findings
  context += `\n[DETECTED OCEANOGRAPHIC ANOMALIES (ML ENGINE)]\n`;
  if (recentAnomalies.length > 0) {
    context += `- Persisted Flagged Anomalies (${recentAnomalies.length} records in database):\n`;
    recentAnomalies.forEach((a) => {
      context += `  * [${a.severity}] Station ${a.buoy_name || a.buoy_id} (Source: ${a.source}): Unitless standardized distance=${a.anomaly_score ?? 'unavailable'} (not a probability), Flags=[${a.anomaly_type}], Obs Time=${a.observation_timestamp}\n`;
      context += `    Measurements: Depth=${a.depth}m, Pres=${a.pressure} dbar, Temp=${a.temperature !== null ? a.temperature + '°C' : 'N/A'}, Salinity=${a.salinity !== null ? a.salinity + ' PSU' : 'N/A'}, O2=${a.oxygen_content !== null ? a.oxygen_content + ' mg/L' : 'N/A'}, pH=${a.ph !== null ? a.ph : 'N/A'}\n`;
      context += `    Reason: ${a.explanation}\n`;
    });
  } else {
    context += `- No persisted flagged anomalies are available. This does not establish that recent observations contain no anomalies.\n`;
  }

  context += `\n=== END CONTEXT ===\n`;
  return { context, argoOverview, argoFloats, specificProfile, previousProfile, otherFloatProfile, profileComparison, followup, recentAnomalies };
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
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
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

// 5. Run ML anomaly screening on cached ARGO observations only.
router.post("/ml/predict", async (req, res) => {
  try {
    const { records: dataset, duplicatesRemoved } = listEvaluableArgoObservations();

    if (!dataset || dataset.length === 0) {
      return res
        .status(400)
        .json({ error: "No cached ARGO observations available for ML evaluation." });
    }

    const mlResults = analyzeTelemetryML(tagArgoRetrievalSource(dataset, "CACHED ARGOVIS"), { source: "CACHED ARGOVIS", saveToDb: true });
    return res.json({ ...mlResults, duplicatesRemoved, deduplicationKey: 'float + profile timestamp + pressure/depth' });
  } catch (error) {
    console.error("Error executing ML anomaly model:", error);
    return res
      .status(500)
      .json({ error: "ML Anomaly Engine failure", details: error.message });
  }
});

// Re-evaluate against ARGO observations; synthetic/local demo telemetry is excluded.
router.post("/ml/evaluate", async (req, res) => {
  try {
    let dataset = [];
    let duplicatesRemoved = 0;
    let dataSource = "CACHED ARGOVIS";
    const forceLive = req.body?.forceLive === true || req.query?.refresh === "true";

    if (forceLive) {
      try {
        const discovery = await discoverArgoProfiles({ limit: 15, forceRefresh: true });
        let liveProfilesFetched = 0;
        if (discovery.uniqueFloats && discovery.uniqueFloats.length > 0) {
          // Select discovered floats including BGC floats if available
          for (const f of discovery.uniqueFloats.slice(0, 4)) {
            if (f.latestProfileId) {
              const profile = await getArgoProfileById(f.latestProfileId, { forceRefresh: true });
              if (profile?.success && !profile.isCached && !profile.isFallback) liveProfilesFetched++;
            }
          }
        }
        if (liveProfilesFetched > 0) dataSource = "ARGOVIS LIVE REFRESH + SQLITE CACHE";
      } catch (fetchErr) {
        console.warn("Live Argovis ML fetch fallback:", fetchErr.message);
      }
    }

    let argoDataset = listEvaluableArgoObservations();
    dataset = argoDataset.records;
    duplicatesRemoved = argoDataset.duplicatesRemoved;
    if (!dataset.length && !forceLive) {
      try {
        const discovery = await discoverArgoProfiles({ limit: 12 });
        let liveProfilesFetched = 0;
        for (const float of (discovery.uniqueFloats || []).slice(0, 3)) {
          if (float.latestProfileId) {
            const profile = await getArgoProfileById(float.latestProfileId);
            if (profile?.success && !profile.isCached && !profile.isFallback) liveProfilesFetched++;
          }
        }
        argoDataset = listEvaluableArgoObservations();
        dataset = argoDataset.records;
        duplicatesRemoved = argoDataset.duplicatesRemoved;
        if (dataset.length && liveProfilesFetched > 0) dataSource = "ARGOVIS LIVE + SQLITE CACHE";
      } catch (fetchErr) {
        console.warn("Argovis ML fetch fallback:", fetchErr.message);
      }
    }

    if (!dataset || dataset.length === 0) {
      return res.status(400).json({ error: "No ARGO observations are available from Argovis or the local cache. Synthetic telemetry is not used for this evaluation." });
    }

    dataset = tagArgoRetrievalSource(dataset, dataSource);
    const mlResults = analyzeTelemetryML(dataset, { source: dataSource, saveToDb: true });
    return res.json({
      ...mlResults,
      dataSource,
      duplicatesRemoved,
      deduplicationKey: 'float + profile timestamp + pressure/depth',
      evaluatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error evaluating ML model:", error);
    return res.status(500).json({ error: "ML Anomaly evaluation failure", details: error.message });
  }
});

// Live, read-only per-float history analysis. Profile retrieval is explicitly
// non-persistent; this endpoint does not write telemetry or ML results to SQLite.
router.post("/ml/ocean-intelligence", async (req, res) => {
  try {
    const floatId = String(req.body?.floatId || '').replace(/^ARGO-/, '').trim();
    if (!/^\d{7}$/.test(floatId)) {
      return res.status(400).json({ error: "Select a valid seven-digit ARGO float identifier." });
    }

    const discovery = await discoverArgoProfiles({ platform: floatId, limit: 500, forceRefresh: true });
    if (!discovery.success || discovery.isFallback || discovery.source !== 'argovis_live' || !Array.isArray(discovery.profiles)) {
      return res.status(503).json({
        error: "A live Argovis metadata response was unavailable; cached or demonstration records are not substituted for this analysis.",
        source: discovery.source || 'unavailable',
        lastChecked: discovery.lastChecked || null
      });
    }

    const metadataProfiles = discovery.profiles
      .filter(profile => profile?._id && Number.isFinite(Date.parse(profile.timestamp)))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const uniqueMetadata = [...new Map(metadataProfiles.map(profile => [String(profile._id), profile])).values()];
    const selectedProfiles = uniqueMetadata.slice(-36);
    const profileResults = [];
    for (let index = 0; index < selectedProfiles.length; index += 4) {
      const batch = selectedProfiles.slice(index, index + 4);
      const results = await Promise.all(batch.map(profile =>
        getArgoProfileById(String(profile._id), { dataVars: ['all'], forceRefresh: true, persist: false })
      ));
      profileResults.push(...results.filter(result => result?.success && !result.isFallback && result.verticalProfile));
    }

    if (!profileResults.length) {
      return res.status(502).json({ error: "Argovis listed this float but no full profile documents could be retrieved.", floatId, metadataProfilesAvailable: uniqueMetadata.length });
    }

    const analysis = analyzeArgoFloatProfileHistory(profileResults, { floatId });
    return res.json({
      success: true,
      source: 'ARGOVIS LIVE API',
      requestedAt: new Date().toISOString(),
      floatId,
      metadataProfilesAvailable: uniqueMetadata.length,
      fullProfileLimit: 36,
      olderMetadataProfilesNotFetched: Math.max(0, uniqueMetadata.length - selectedProfiles.length),
      profileFetchFailures: selectedProfiles.length - profileResults.length,
      analysis
    });
  } catch (error) {
    console.error("Error analyzing live Argovis float history:", error);
    return res.status(502).json({ error: "Live Argovis profile history analysis failed." });
  }
});

// Retrieve Persisted ML Anomalies
router.get("/ml/anomalies", (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    let anomalies = listMLAnomalies(limit).filter(anomaly => String(anomaly.source || '').toUpperCase().includes('ARGOVIS'));

    // If no ARGO anomaly is persisted, only evaluate cached ARGO observations.
    if (anomalies.length === 0) {
      const { records } = listEvaluableArgoObservations();
      if (records.length > 0) {
        const ml = analyzeTelemetryML(tagArgoRetrievalSource(records, "CACHED ARGOVIS"), { source: "CACHED ARGOVIS", saveToDb: true });
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
    const { context: groundedContext, argoOverview, argoFloats, specificProfile, previousProfile, otherFloatProfile, profileComparison, followup, recentAnomalies } =
      await buildGroundedContext(trimmedMessage, chatHistory);
    const shelters = disasterStore.getShelters();
    const activeScenario = disasterStore.getScenario();
    const dataset = listTelemetryRecords(5000).slice(-100);

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
      } else if (/\b(rain|rainfall|weather|cyclone|cloud|atmospheric|air pressure)\b/i.test(trimmedMessage)) {
        responseText = `ARGO floats measure ocean conditions such as temperature, salinity, pressure and, on equipped floats, oxygen or pH. They do not measure rainfall, clouds, atmospheric pressure or cyclones, so I cannot produce a conventional weather forecast from these data. I can summarize available ocean observations and distinguish depth profiles from changes over time.`;
      } else if (followup.asksOtherFloat) {
        if (specificProfile && otherFloatProfile) {
          const currentTemp = profilePointNearDepth(specificProfile, 'temperature');
          const currentSalinity = profilePointNearDepth(specificProfile, 'salinity');
          const otherTemp = profilePointNearDepth(otherFloatProfile, 'temperature');
          const otherSalinity = profilePointNearDepth(otherFloatProfile, 'salinity');
          responseText = `### Float profile comparison (retrieved observations)
- **Float ${specificProfile.platformId}**, profile ${specificProfile.profileId} (${specificProfile.timestamp}): temperature ${currentTemp ? `${currentTemp.value}°C at ${currentTemp.depth} m` : 'N/A'}; salinity ${currentSalinity ? `${currentSalinity.value} PSU at ${currentSalinity.depth} m` : 'N/A'}.
- **Float ${otherFloatProfile.platformId}**, profile ${otherFloatProfile.profileId} (${otherFloatProfile.timestamp}): temperature ${otherTemp ? `${otherTemp.value}°C at ${otherTemp.depth} m` : 'N/A'}; salinity ${otherSalinity ? `${otherSalinity.value} PSU at ${otherSalinity.depth} m` : 'N/A'}.

These are shallowest available measurements, but the profiles may differ in location and observation time; this is a descriptive comparison, not a controlled environmental comparison.`;
        } else {
          responseText = 'I could not retrieve two distinct float profiles for a grounded comparison. No second float measurement is available in the retrieved Argovis results.';
        }
      } else if (followup.wantsComparison) {
        if (profileComparison && !profileComparison.unavailable) {
          const differenceText = `${profileComparison.difference > 0 ? '+' : ''}${profileComparison.difference.toFixed(3)}${profileComparison.unit}`;
          responseText = `### ${profileComparison.label[0].toUpperCase()}${profileComparison.label.slice(1)} comparison for Float ${specificProfile.platformId}
- Latest profile: **${profileComparison.current.value}${profileComparison.unit}** at ${profileComparison.current.depth} m on ${profileComparison.current.timestamp}.
- Previous distinct profile: **${profileComparison.previous.value}${profileComparison.unit}** at ${profileComparison.previous.depth} m on ${profileComparison.previous.timestamp}.
- Difference (latest minus previous): **${differenceText}**.

I matched the nearest measurements within 50 m, so this compares separate profiles at similar depths rather than different depths within one cast.`;
        } else {
          const unavailable = profileComparison?.unavailable || 'No previous distinct profile was retrieved for this float.';
          responseText = `I can’t calculate that temporal comparison from the available observations. ${unavailable} Measurements at different depths within one profile are not treated as previous observations.`;
        }
      } else if (followup.asksOxygenConcern) {
        const oxygenPoints = (specificProfile?.verticalProfile?.oxygen || [])
          .map((value, index) => ({ value, depth: specificProfile.verticalProfile.depth[index] }))
          .filter((point) => point.value !== null && point.value !== undefined && point.depth !== null && point.depth !== undefined)
          .map((point) => ({ value: Number(point.value), depth: Number(point.depth) }))
          .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.depth));
        if (oxygenPoints.length) {
          const minimum = oxygenPoints.reduce((lowest, point) => point.value < lowest.value ? point : lowest);
          responseText = `Float ${specificProfile.platformId} profile ${specificProfile.profileId} (${specificProfile.timestamp}) has dissolved oxygen measurements. The lowest measured value is **${minimum.value} mg/L at ${minimum.depth} m**. ${minimum.value < 4 ? 'That is below FloatChat’s 4 mg/L screening value and merits review in local oceanographic context.' : 'That is above FloatChat’s 4 mg/L screening value.'} One profile does not establish oxygen depletion developing over time.`;
        } else {
          responseText = specificProfile
            ? `Dissolved oxygen is not available in retrieved profile ${specificProfile.profileId}; this float/profile may not have an active oxygen sensor.`
            : 'I could not retrieve an oxygen measurement for this float. No oxygen value is available to assess.';
        }
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
          const score = highest.anomalyScore ?? highest.anomaly_score;
          const obsTime = highest.observationTimestamp || highest.observation_timestamp;
          const temp = highest.temperature !== null && highest.temperature !== undefined ? `${highest.temperature}°C` : 'N/A';
          const psal = highest.salinity !== null && highest.salinity !== undefined ? `${highest.salinity} PSU` : 'N/A';
          const oxy = (highest.oxygenContent ?? highest.oxygen_content) !== null && (highest.oxygenContent ?? highest.oxygen_content) !== undefined ? `${highest.oxygenContent ?? highest.oxygen_content} mg/L` : 'N/A';
          const phVal = (highest.ph !== null && highest.ph !== undefined) ? highest.ph : 'N/A';

          responseText = `### 🚨 ML Anomaly Detection Findings (Grounded Database)
**[Rule-Based Assistant — Gemini is not configured]**

- **Persisted Anomalies:** ${recentAnomalies.length} flagged observations. Scores are standardized distances, not risk probabilities.
- **Highest Severity Anomaly:**
  * **Station:** **${stName}** (Platform: \`${pId}\`)
  * **Severity:** **${highest.severity}** (Standardized distance: **${score !== undefined ? score : 'unavailable'}**, unitless)
  * **Observation Time:** ${obsTime ? new Date(obsTime).toUTCString() : 'Recent'}
  * **Data Source:** **${highest.source}**
  * **Depth / Pressure:** ${highest.depth}m / ${highest.pressure} dbar
  * **Measured Values:** Temp: ${temp}, Salinity: ${psal}, O₂: ${oxy}, pH: ${phVal}
  * **Classification Explanation:** ${highest.explanation || highest.anomalyType || 'Multivariate statistical distance deviation > 3.6 sigma'}
- **Data Provenance:** Observations originate from **${highest.source}**. Missing sensor channels remain null without synthetic data injection.`;
        } else {
          responseText = `### 🧪 ML Anomaly Detection Findings
**[Rule-Based Assistant — Gemini is not configured]**

- **Status:** No persisted flagged anomalies are available to summarize.
- **Findings:** This does not establish that recent observations are anomaly-free. Run an evaluation in the ML dashboard to analyze the current dataset.
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
        const primaryShelter = shelters[0];
        const shelterDetails = primaryShelter
          ? `**${primaryShelter.name}** (+${primaryShelter.elevationMeters}m elevation MSL), Status: ${primaryShelter.status}, Occupancy: ${primaryShelter.currentOccupancy}/${primaryShelter.totalCapacity}`
          : 'No verified shelter records are currently available in the database.';
        responseText = `### 🚨 EMERGENCY RESCUE COORDINATION
**[Rule-Based Assistant — Gemini is not configured]**

**Immediate Life-Safety Actions:**
1. **Trigger Emergency SOS:** Click **Emergency SOS** in the top bar to record your GPS coordinates and medical details for Coast Guard & NDRF SAR units.
2. **Nearest Verified Safe Shelter (From Database):**
   - ${shelterDetails}
   ${primaryShelter ? `- Water Supply: ${primaryShelter.supplies?.waterLiters ?? 'N/A'} Liters | Meals: ${primaryShelter.supplies?.foodMeals ?? 'N/A'}` : ''}
3. **If Cellular is Down:** Your SOS packet will be held in the offline queue and relayed across the peer mesh simulation until reaching a satellite gateway.`;
      } else if (
        lowerMessage.includes("tsunami") ||
        lowerMessage.includes("wave") ||
        lowerMessage.includes("surge") ||
        lowerMessage.includes("सुनामी")
      ) {
        responseText = `### 🌊 TSUNAMI & INUNDATION PROTOCOL
**[Rule-Based Assistant — Gemini is not configured]**

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
**[Rule-Based Assistant — Gemini is not configured]**\n\n`;
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
          const validTemperatures = vp.temperature.map((value, index) => ({ value, depth: vp.depth[index] }))
            .filter((point) => point.value !== null && point.value !== undefined && point.depth !== null && point.depth !== undefined)
            .map((point) => ({ value: Number(point.value), depth: Number(point.depth) }))
            .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.depth));
          const temperatureRange = validTemperatures.length > 1
            ? Math.max(...validTemperatures.map((point) => point.value)) - Math.min(...validTemperatures.map((point) => point.value))
            : null;
          const validOxygen = (vp.oxygen || []).filter(Number.isFinite);
          const minOxygen = validOxygen.length ? Math.min(...validOxygen) : null;
          
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

          responseText = `### 🌊 ARGO Float ${specificProfile.platformId}${specificProfile.cycleNumber !== null && specificProfile.cycleNumber !== undefined ? ` (Cycle ${specificProfile.cycleNumber})` : ''}
**[Grounded Float Observation — Argovis Integration]**

- **Profile:** \`${specificProfile.profileId || 'SQLite cached observations'}\`
- **Location:** Lat ${specificProfile.coordinates[1]}°, Lng ${specificProfile.coordinates[0]}°
- **Observation Time:** ${new Date(specificProfile.timestamp).toUTCString()}
- **Depth Range:** ${Math.round(vp.depth[0] || 0)}m to ${Math.round(vp.depth[deepIdx] || 0)}m (${vp.levelsCount} discrete levels)
- **Shallowest Observation:** ${vp.temperature[0] !== null && vp.temperature[0] !== undefined ? `${vp.temperature[0]}°C` : 'Temperature N/A'} | Salinity: ${vp.salinity[0] !== null && vp.salinity[0] !== undefined ? `${vp.salinity[0]} PSU` : 'N/A'} (Depth: ${vp.depth[0] !== null && vp.depth[0] !== undefined ? `${vp.depth[0]}m` : 'N/A'})
${tempAt1000 ? `- **Observation at ~1000m Depth:** **${tempAt1000.temp}°C** (at ${tempAt1000.depth}m / ${tempAt1000.pres} dbar)` : ''}
- **Deepest Observation:** ${vp.temperature[deepIdx] !== null && vp.temperature[deepIdx] !== undefined ? `${vp.temperature[deepIdx]}°C` : 'Temperature N/A'} | Salinity: ${vp.salinity[deepIdx] !== null && vp.salinity[deepIdx] !== undefined ? `${vp.salinity[deepIdx]} PSU` : 'N/A'} (Depth: ${vp.depth[deepIdx] !== null && vp.depth[deepIdx] !== undefined ? `${Math.round(vp.depth[deepIdx])}m` : 'N/A'})
- **Within-profile structure:** ${temperatureRange !== null ? `Temperature spans ${temperatureRange.toFixed(2)}°C across measured depths; this describes one cast, not a temporal warming or marine heatwave trend.` : 'Insufficient valid temperature-depth pairs to describe stratification.'}
- **Oxygen profile:** ${minOxygen !== null ? `Lowest measured value ${minOxygen} mg/L across ${validOxygen.length} valid levels; this alone does not establish hypoxia development over time.` : 'No valid oxygen measurements in this profile.'}
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
          responseText = dataset.length ? `### 🌊 Ocean Telemetry & ARGO Observations
**[Rule-Based Assistant — Gemini is not configured]**

- **Total Stored Observations:** ${dataset.length} records across active stations.
- **Latest Record Station:** ${sampleBuoy.buoyName || "Buoy Network"} (${sampleBuoy.buoyId || "N/A"})
- **Observation Timestamp:** ${sampleBuoy.timestamp || "Recent"}
- **Temperature:** ${sampleBuoy.temperature !== null ? sampleBuoy.temperature + "°C" : "Not Measured"}
- **Salinity:** ${sampleBuoy.salinity !== null ? sampleBuoy.salinity + " PSU" : "Not Measured"}
- **Hydrostatic Depth:** ${sampleBuoy.depth}m` : 'No ocean observation records are currently available in the local database or Argovis retrieval.';
        }
      } else {
        responseText = `### 🌊 FloatChat AI Marine & Emergency Coordinator
**[Rule-Based Assistant — Gemini is not configured]**

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
- Do not present ARGO data as a rainfall, cloud, atmospheric pressure, cyclone, or conventional weather forecast. Describe oceanographic observations only.
- Distinguish vertical structure in one profile from temporal trends across separate observation times. Do not claim marine heatwaves, long-term acidification, or oxygen depletion development without suitable baselines and repeated observations.
- For follow-up questions, use the resolved chat float and the explicitly retrieved profile timestamps. When a computed comparison is provided, answer that comparison directly instead of repeating the previous profile summary. If the previous distinct profile or a comparable-depth measurement is missing, say so.
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

    const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    let geminiResponse;
    try {
      geminiResponse = await fetch(geminiUrl, {
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
    } catch {
      return res.json({
        message: 'Gemini could not be reached. Local retrieval completed, but I cannot reliably interpret the request right now. Please retry or ask about a specific float/profile.',
        isMock: true,
        geminiConfigured: false,
      });
    }

    const geminiData = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      const reason =
        geminiData?.error?.message ||
        `Gemini API returned status ${geminiResponse.status}`;
      const fallbackFacts = specificProfile?.verticalProfile
        ? `Retrieved Float ${specificProfile.platformId}, profile ${specificProfile.profileId} at ${specificProfile.timestamp}. Available variables: ${(specificProfile.verticalProfile.sensorsEquipped || []).join(', ') || 'not listed'}.`
        : argoFloats.length
          ? `Retrieved ${argoFloats.length} Argovis float summaries: ${argoFloats.slice(0, 5).map((float) => `${float.floatId} (cycle ${float.latestCycle}, observed ${float.latestTimestamp})`).join('; ')}.`
          : dataset.length
            ? `Retrieved ${dataset.length} local observations. The latest stored observation is ${dataset.at(-1).buoyId} at ${dataset.at(-1).timestamp}; ask for a specific station or measurement for a deterministic summary.`
            : 'No local or Argovis observation records were available for a grounded answer.';
      return res.json({
        message: `Gemini is temporarily unavailable, so I could not interpret the question with the language model. I did retrieve these source facts: ${fallbackFacts}`,
        isMock: true,
        geminiConfigured: false,
        fallbackReason: reason,
      });
    }

    const responseText = (geminiData.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!responseText) {
      return res.json({
        message: 'Gemini returned an empty reply. The retrieved data is available, but I could not produce a reliable interpretation. Please retry or ask about a specific float/profile.',
        isMock: true,
        geminiConfigured: false,
      });
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
