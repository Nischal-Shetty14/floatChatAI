import { getArgovisApiKey } from './config.js';
import { saveTelemetryRecords, listTelemetryRecords, db } from './db.js';

const ARGOVIS_BASE_URL = 'https://argovis-api.colorado.edu';
const DISCOVERY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;   // 60 minutes
const OVERVIEW_CACHE_TTL_MS = 60 * 60 * 1000;  // 60 minutes

// Separate in-memory caches
const discoveryCache = new Map();
const profileCache = new Map();
let overviewCache = {
  timestamp: 0,
  data: null
};

let lastApiStatus = {
  isAvailable: false,
  lastChecked: null,
  error: null,
  lastSuccessfulSync: null
};

/**
 * Dynamically parses Argovis data_info into variable mapping and units.
 * Argovis data_info format:
 * [
 *   ["pressure", "temperature", "salinity", ...],
 *   ["units", "data_keys_mode"],
 *   [["decibar", "D"], ["degree_Celsius", "D"], ["psu", "D"], ...]
 * ]
 */
export function parseDataInfo(dataInfo) {
  if (!Array.isArray(dataInfo) || dataInfo.length === 0) {
    return { varNames: [], colMap: {}, units: {} };
  }

  const varNames = Array.isArray(dataInfo[0]) ? dataInfo[0].map(String) : [];
  const colMap = {};
  const units = {};

  varNames.forEach((name, idx) => {
    colMap[name.toLowerCase()] = idx;
  });

  if (Array.isArray(dataInfo[2])) {
    dataInfo[2].forEach((meta, idx) => {
      const varName = varNames[idx];
      if (varName && Array.isArray(meta) && meta[0]) {
        units[varName.toLowerCase()] = String(meta[0]);
      }
    });
  }

  return { varNames, colMap, units };
}

/**
 * Normalizes an Argovis profile document into standardized FloatChat observations and vertical profiles.
 * Correctly handles column-oriented data arrays: doc.data[colIdx][rowIdx].
 * Strict rule: missing measurements remain null. Never replace with 0 or arbitrary values.
 */
export function normalizeArgoProfile(doc) {
  if (!doc) return { observations: [], verticalProfile: null };

  const [lng, lat] = (doc.geolocation && Array.isArray(doc.geolocation.coordinates))
    ? doc.geolocation.coordinates
    : [null, null];

  const timestamp = doc.timestamp || new Date().toISOString();
  const rawId = String(doc._id || '');
  const platformId = String(doc.platform_number || rawId.split('_')[0] || 'ARGO-UNKNOWN');
  const cycleNumber = doc.cycle_number !== undefined ? doc.cycle_number : (rawId.split('_')[1] || '');
  const buoyName = `Argo Float ${platformId}${cycleNumber !== '' ? ` (Cycle ${cycleNumber})` : ''}`;

  const { varNames, colMap, units } = parseDataInfo(doc.data_info);

  // Find column indices.
  // Argovis uses: 'pressure', 'temperature', 'salinity', 'doxy', 'ph_in_situ_total'
  // Adjusted variants (doxy_adjusted etc.) appear in some profiles; fall back to them if primary absent.
  const presIdx = colMap['pressure'] ?? colMap['pres'];
  const tempIdx = colMap['temperature'] ?? colMap['temp'];
  const psalIdx = colMap['salinity'] ?? colMap['psal'];
  const doxyIdx = colMap['doxy'] ?? colMap['doxy_adjusted'] ?? colMap['oxygen'];
  const phIdx   = colMap['ph_in_situ_total'] ?? colMap['ph_in_situ_total_adjusted'] ?? colMap['ph'];

  const rawData = doc.data;

  // Case 1: Metadata only (no measurements array)
  if (!Array.isArray(rawData) || rawData.length === 0) {
    const singleObs = {
      source: 'argovis',
      buoyId: `ARGO-${platformId}`,
      buoyName,
      profileId: rawId,
      cycleNumber,
      latitude: lat !== null ? Number(lat.toFixed(4)) : null,
      longitude: lng !== null ? Number(lng.toFixed(4)) : null,
      depth: 0,
      timestamp,
      temperature: null,
      pressure: null,
      salinity: null,
      oxygenContent: null,
      ph: null,
      batteryLevel: null,
      availableVariables: varNames
    };

    return {
      observations: [singleObs],
      verticalProfile: {
        profileId: rawId,
        platformId,
        cycleNumber,
        timestamp,
        coordinates: [lng, lat],
        levelsCount: 0,
        pressure: [],
        depth: [],
        temperature: [],
        salinity: [],
        oxygen: [],
        ph: [],
        units
      }
    };
  }

  // Case 2: Column-oriented measurements present
  // rawData[colIdx] is an array of length N
  const numLevels = Array.isArray(rawData[0]) ? rawData[0].length : 0;

  const pressureArr = (presIdx !== undefined && Array.isArray(rawData[presIdx])) ? rawData[presIdx] : [];
  const tempArr = (tempIdx !== undefined && Array.isArray(rawData[tempIdx])) ? rawData[tempIdx] : [];
  const psalArr = (psalIdx !== undefined && Array.isArray(rawData[psalIdx])) ? rawData[psalIdx] : [];
  const doxyArr = (doxyIdx !== undefined && Array.isArray(rawData[doxyIdx])) ? rawData[doxyIdx] : [];
  const phArr = (phIdx !== undefined && Array.isArray(rawData[phIdx])) ? rawData[phIdx] : [];

  const depthArr = [];
  const oxygenConvertedArr = [];

  for (let i = 0; i < numLevels; i++) {
    const p = pressureArr[i] !== null && pressureArr[i] !== undefined && !isNaN(pressureArr[i])
      ? Number(pressureArr[i])
      : null;
    // Hydrostatic pressure to depth approximation: 1 dbar ~ 0.993 meters
    depthArr.push(p !== null ? parseFloat((p * 0.993).toFixed(1)) : null);

    const ox = doxyArr[i] !== null && doxyArr[i] !== undefined && !isNaN(doxyArr[i])
      ? Number(doxyArr[i])
      : null;
    // Convert micromol/kg O2 to mg/L if present: 1 micromol/kg ~ 0.02295 mg/L
    oxygenConvertedArr.push(ox !== null ? parseFloat((ox * 0.02295).toFixed(2)) : null);
  }

  const hasOxygen = oxygenConvertedArr.some(v => v !== null && v !== undefined);
  const hasPh = phArr.some(v => v !== null && v !== undefined);

  const verticalProfile = {
    profileId: rawId,
    platformId,
    cycleNumber,
    timestamp,
    coordinates: [lng, lat],
    levelsCount: numLevels,
    hasOxygen,
    hasPh,
    sensorsEquipped: varNames,
    pressure: pressureArr,
    depth: depthArr,
    temperature: tempArr,
    salinity: psalArr,
    oxygen: oxygenConvertedArr,
    ph: phArr,
    units: {
      pressure: units['pressure'] || units['pres'] || 'decibar',
      temperature: units['temperature'] || units['temp'] || 'degree_Celsius',
      salinity: units['salinity'] || units['psal'] || 'psu',
      // Argovis stores doxy as micromole/kg; we convert to mg/L (÷ 43.568) for display
      oxygen: 'mg/L (converted from micromole/kg)',
      ph: 'dimensionless'
    }
  };

  // Sample distinct depth tiers for relational telemetry rows:
  // surface (~0-10m), shallow (~50-100m), mid-depth (~500m), and deep (>1000m)
  const sampledIndices = [];
  if (numLevels <= 6) {
    for (let i = 0; i < numLevels; i++) sampledIndices.push(i);
  } else {
    sampledIndices.push(0); // Surface
    const step = Math.max(1, Math.floor(numLevels / 5));
    for (let i = step; i < numLevels - 1; i += step) {
      sampledIndices.push(i);
    }
    sampledIndices.push(numLevels - 1); // Deepest
  }

  const observations = sampledIndices.map(idx => {
    const rawP = pressureArr[idx] !== null && pressureArr[idx] !== undefined && !isNaN(pressureArr[idx]) ? Number(pressureArr[idx]) : null;
    const rawT = tempArr[idx] !== null && tempArr[idx] !== undefined && !isNaN(tempArr[idx]) ? Number(tempArr[idx]) : null;
    const rawS = psalArr[idx] !== null && psalArr[idx] !== undefined && !isNaN(psalArr[idx]) ? Number(psalArr[idx]) : null;
    const rawOx = oxygenConvertedArr[idx] !== null && oxygenConvertedArr[idx] !== undefined ? oxygenConvertedArr[idx] : null;
    const rawPhVal = phArr[idx] !== null && phArr[idx] !== undefined && !isNaN(phArr[idx]) ? Number(phArr[idx]) : null;
    const d = depthArr[idx] !== null ? depthArr[idx] : (rawP !== null ? parseFloat((rawP * 0.993).toFixed(1)) : 5.0);

    return {
      source: 'argovis',
      buoyId: `ARGO-${platformId}`,
      buoyName,
      profileId: rawId,
      cycleNumber,
      latitude: lat !== null ? Number(lat.toFixed(4)) : null,
      longitude: lng !== null ? Number(lng.toFixed(4)) : null,
      depth: d,
      timestamp,
      temperature: rawT !== null ? parseFloat(rawT.toFixed(2)) : null,
      pressure: rawP !== null ? parseFloat(rawP.toFixed(1)) : null,
      salinity: rawS !== null ? parseFloat(rawS.toFixed(2)) : null,
      oxygenContent: rawOx,
      ph: rawPhVal !== null ? parseFloat(rawPhVal.toFixed(2)) : null,
      batteryLevel: null
    };
  });

  return { observations, verticalProfile };
}

/**
 * Groups an array of profile metadata or profile docs by unique float (platform).
 * Ensures latest coordinates and latest observation timestamps are calculated accurately.
 */
export function groupProfilesByFloat(profiles = []) {
  const floatMap = new Map();

  for (const doc of profiles) {
    if (!doc || !doc._id) continue;
    const rawId = String(doc._id);
    const platformId = String(doc.platform_number || rawId.split('_')[0] || 'ARGO-UNKNOWN');
    const cycle = doc.cycle_number !== undefined ? Number(doc.cycle_number) : (Number(rawId.split('_')[1]) || 0);

    let lng = null;
    let lat = null;
    if (doc.geolocation && Array.isArray(doc.geolocation.coordinates)) {
      lng = Number(Number(doc.geolocation.coordinates[0]).toFixed(4));
      lat = Number(Number(doc.geolocation.coordinates[1]).toFixed(4));
    }

    const timestamp = doc.timestamp || new Date().toISOString();
    const { varNames } = parseDataInfo(doc.data_info);

    if (!floatMap.has(platformId)) {
      floatMap.set(platformId, {
        floatId: platformId,
        platformId,
        floatName: `Argo Float ${platformId}`,
        cycleCount: 0,
        cycles: [],
        latestProfileId: rawId,
        latestCycle: cycle,
        latestTimestamp: timestamp,
        latestLongitude: lng,
        latestLatitude: lat,
        availableVariables: varNames,
        source: (Array.isArray(doc.source) && doc.source[0]?.source?.[0]) || 'argo_core',
        metadataRef: Array.isArray(doc.metadata) ? doc.metadata[0] : null
      });
    }

    const entry = floatMap.get(platformId);
    entry.cycleCount += 1;
    entry.cycles.push({
      profileId: rawId,
      cycle,
      timestamp,
      longitude: lng,
      latitude: lat
    });

    // Merge variable names
    varNames.forEach(v => {
      if (!entry.availableVariables.includes(v)) {
        entry.availableVariables.push(v);
      }
    });

    // Update latest observation if this profile is newer
    if (new Date(timestamp) >= new Date(entry.latestTimestamp)) {
      entry.latestTimestamp = timestamp;
      entry.latestProfileId = rawId;
      entry.latestCycle = cycle;
      if (lng !== null && lat !== null) {
        entry.latestLongitude = lng;
        entry.latestLatitude = lat;
      }
    }
  }

  // Sort cycles descending for each float
  for (const float of floatMap.values()) {
    float.cycles.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  return Array.from(floatMap.values()).sort(
    (a, b) => new Date(b.latestTimestamp) - new Date(a.latestTimestamp)
  );
}

/**
 * Fetches the global overview dataset statistics from Argovis.
 * Endpoint: GET https://argovis-api.colorado.edu/argo/overview
 */
export async function getArgoOverview({ forceRefresh = false } = {}) {
  const isCacheValid = !forceRefresh &&
    (Date.now() - overviewCache.timestamp < OVERVIEW_CACHE_TTL_MS) &&
    overviewCache.data !== null;

  if (isCacheValid) {
    return {
      success: true,
      isCached: true,
      data: overviewCache.data
    };
  }

  const apiKey = getArgovisApiKey();
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['x-argokey'] = apiKey;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(`${ARGOVIS_BASE_URL}/argo/overview`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const json = await response.json();
      const summary = Array.isArray(json) && json[0]?.summary ? json[0].summary : (json.summary || json);

      const overviewData = {
        nCore: summary.nCore || 0,
        nBGC: summary.nBGC || 0,
        nDeep: summary.nDeep || 0,
        totalProfiles: (summary.nCore || 0) + (summary.nBGC || 0) + (summary.nDeep || 0),
        mostrecent: summary.mostrecent || null,
        latest_argovis_update: summary.latest_argovis_update || null,
        datacenters: summary.datacenters || []
      };

      overviewCache = {
        timestamp: Date.now(),
        data: overviewData
      };

      lastApiStatus.isAvailable = true;
      lastApiStatus.lastSuccessfulSync = new Date().toISOString();
      lastApiStatus.lastChecked = new Date().toISOString();
      lastApiStatus.error = null;

      return {
        success: true,
        isCached: false,
        data: overviewData
      };
    }

    throw new Error(`Argovis responded with HTTP ${response.status}`);
  } catch (err) {
    lastApiStatus.isAvailable = false;
    lastApiStatus.lastChecked = new Date().toISOString();
    lastApiStatus.error = err.message;

    // Use cached overview if available
    if (overviewCache.data) {
      return {
        success: true,
        isCached: true,
        isFallback: true,
        data: overviewCache.data
      };
    }

    // Default reference statistics when completely offline
    return {
      success: false,
      isFallback: true,
      error: err.message,
      data: {
        nCore: 3430000,
        nBGC: 413000,
        nDeep: 65000,
        totalProfiles: 3908000,
        mostrecent: null,
        latest_argovis_update: null,
        datacenters: ["BO","NM","KM","ME","JA","IF","CS","HZ","IN","AO","KO"]
      }
    };
  }
}

/**
 * Discovers Argo profiles metadata across regions, dates, and platforms.
 * When data parameter is omitted, returns lightweight metadata documents without heavy arrays.
 */
export async function discoverArgoProfiles({
  startDate,
  endDate,
  box,
  polygon,
  center,
  radius = 500,
  platform,
  id,
  limit = 200,
  forceRefresh = false
} = {}) {
  // Default to Indian Ocean bounding box if not specified: [[40,-40],[120,30]]
  const effectiveBox = box || (!center && !platform && !id ? '[[40,-40],[120,30]]' : null);

  // Argovis requires a date range for spatial queries to prevent HTTP 413 (Payload Too Large)
  let effectiveStartDate = startDate;
  let effectiveEndDate = endDate;
  if (!effectiveStartDate && !effectiveEndDate && !platform && !id) {
    effectiveStartDate = '2025-01-01T00:00:00Z';
    effectiveEndDate = '2025-01-10T00:00:00Z';
  }

  const queryKey = JSON.stringify({
    startDate: effectiveStartDate || '',
    endDate: effectiveEndDate || '',
    box: effectiveBox || '',
    polygon: polygon || '',
    platform: platform || '',
    center: center || '',
    radius: radius || '',
    id: id || '',
    limit
  });

  const isCacheValid = !forceRefresh &&
    discoveryCache.has(queryKey) &&
    (Date.now() - discoveryCache.get(queryKey).timestamp < DISCOVERY_CACHE_TTL_MS);

  if (isCacheValid) {
    const cached = discoveryCache.get(queryKey);
    return {
      success: true,
      isFallback: false,
      isCached: true,
      source: 'argovis_cache',
      count: cached.profiles.length,
      uniqueFloatCount: cached.uniqueFloats.length,
      profiles: cached.profiles,
      uniqueFloats: cached.uniqueFloats,
      lastChecked: lastApiStatus.lastChecked,
      lastSuccessfulSync: lastApiStatus.lastSuccessfulSync
    };
  }

  const params = new URLSearchParams();
  if (effectiveStartDate) params.append('startDate', effectiveStartDate);
  if (effectiveEndDate) params.append('endDate', effectiveEndDate);
  if (effectiveBox) {
    params.append('box', typeof effectiveBox === 'string' ? effectiveBox : JSON.stringify(effectiveBox));
  }
  if (polygon) {
    params.append('polygon', typeof polygon === 'string' ? polygon : JSON.stringify(polygon));
  }
  if (center) {
    params.append('center', center);
    params.append('radius', String(radius));
  }
  if (platform) params.append('platform', platform);
  if (id) params.append('id', id);

  // NOTE: We intentionally OMIT data parameter so Argovis returns metadata only
  const targetUrl = `${ARGOVIS_BASE_URL}/argo?${params.toString()}`;

  const apiKey = getArgovisApiKey();
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['x-argokey'] = apiKey;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const rawDocs = await response.json();
      if (Array.isArray(rawDocs)) {
        const sliced = rawDocs.slice(0, limit);
        const uniqueFloats = groupProfilesByFloat(sliced);

        discoveryCache.set(queryKey, {
          timestamp: Date.now(),
          profiles: sliced,
          uniqueFloats
        });

        lastApiStatus.isAvailable = true;
        lastApiStatus.lastChecked = new Date().toISOString();
        lastApiStatus.lastSuccessfulSync = new Date().toISOString();
        lastApiStatus.error = null;

        return {
          success: true,
          isFallback: false,
          isCached: false,
          source: 'argovis_live',
          totalDiscoveredInRegion: rawDocs.length,
          displayedCount: sliced.length,
          count: sliced.length,
          uniqueFloatCount: uniqueFloats.length,
          geographicBounds: effectiveBox || 'Indian Ocean Basin [[40, -40], [120, 30]]',
          dateRange: { startDate: effectiveStartDate, endDate: effectiveEndDate },
          profiles: sliced,
          uniqueFloats,
          lastChecked: lastApiStatus.lastChecked,
          lastSuccessfulSync: lastApiStatus.lastSuccessfulSync
        };
      }
    }

    throw new Error(`Argovis responded with HTTP ${response.status}`);
  } catch (err) {
    lastApiStatus.isAvailable = false;
    lastApiStatus.lastChecked = new Date().toISOString();
    lastApiStatus.error = err.message;

    // Build fallback from SQLite stored telemetry records
    const fallbackRecords = listTelemetryRecords(150);
    const fallbackFloatsMap = new Map();

    fallbackRecords.forEach(r => {
      const floatId = String(r.buoyId || 'UNKNOWN').replace('ARGO-', '');
      if (!fallbackFloatsMap.has(floatId)) {
        fallbackFloatsMap.set(floatId, {
          floatId,
          platformId: floatId,
          floatName: r.buoyName || `Station ${floatId}`,
          cycleCount: 1,
          cycles: [{ profileId: `${floatId}_001`, cycle: 1, timestamp: r.timestamp, longitude: r.longitude, latitude: r.latitude }],
          latestProfileId: `${floatId}_001`,
          latestCycle: 1,
          latestTimestamp: r.timestamp,
          latestLongitude: r.longitude,
          latestLatitude: r.latitude,
          availableVariables: ['pressure', 'temperature', 'salinity', 'oxygenContent', 'ph'],
          source: r.source || 'local_baseline'
        });
      }
    });

    const fallbackFloats = Array.from(fallbackFloatsMap.values());

    return {
      success: false,
      isFallback: true,
      source: 'local_fallback',
      error: `Argovis API unreachable (${err.message}). Displaying local historical stations.`,
      count: fallbackRecords.length,
      uniqueFloatCount: fallbackFloats.length,
      profiles: [],
      uniqueFloats: fallbackFloats,
      lastChecked: lastApiStatus.lastChecked,
      lastSuccessfulSync: lastApiStatus.lastSuccessfulSync
    };
  }
}

/**
 * Retrieves a detailed individual profile with measurement arrays for a selected float and cycle.
 * Endpoint: GET https://argovis-api.colorado.edu/argo?id=${profileId}&data=pressure&data=temperature&data=salinity...
 */
export async function getArgoProfileById(profileId, {
  dataVars = ['all'],
  forceRefresh = false
} = {}) {
  if (!profileId) {
    return { success: false, error: 'profileId is required' };
  }

  const requestedVars = Array.isArray(dataVars) ? dataVars : [dataVars];
  const cacheKey = `${profileId}_${requestedVars.sort().join('_')}`;
  const isCacheValid = !forceRefresh &&
    profileCache.has(cacheKey) &&
    (Date.now() - profileCache.get(cacheKey).timestamp < PROFILE_CACHE_TTL_MS);

  if (isCacheValid) {
    const cached = profileCache.get(cacheKey);
    return {
      success: true,
      isFallback: false,
      isCached: true,
      ...cached.data
    };
  }

  const CORE_VARS = ['pressure', 'temperature', 'salinity'];
  const BGC_VARS  = ['doxy', 'ph_in_situ_total'];

  /**
   * Helper: build a fetch URL for a given set of data variables.
   */
  function buildProfileUrl(vars) {
    const p = new URLSearchParams();
    p.append('id', profileId);
    if (vars.includes('all')) {
      p.append('data', 'all');
    } else {
      vars.forEach(v => p.append('data', v));
    }
    return `${ARGOVIS_BASE_URL}/argo?${p.toString()}`;
  }

  const apiKey = getArgovisApiKey();
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['x-argokey'] = apiKey;

  /**
   * Fetches a profile URL and returns the first document, or null on failure/empty.
   */
  async function fetchProfile(url) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) return null;
      const docs = await res.json();
      return Array.isArray(docs) && docs.length > 0 ? docs[0] : null;
    } catch {
      clearTimeout(tid);
      return null;
    }
  }

  try {
    let doc = null;
    let requestedBGC = false;

    // Argovis Variable Retrieval Strategy:
    // Argovis API returns 404/empty if ANY requested variable is absent on that profile.
    // However, data=all natively returns ALL sensors present on that specific float without 404ing!
    // We prefer data=all to capture core + BGC measurements (doxy, ph_in_situ_total) in a single request.
    const wantsAll = requestedVars.includes('all');
    const hasBGCInRequest = requestedVars.some(v => BGC_VARS.includes(v)) || wantsAll;

    if (wantsAll) {
      doc = await fetchProfile(buildProfileUrl(['all']));
      if (doc) requestedBGC = true;
    } else if (hasBGCInRequest) {
      // Try requested specific variables first
      doc = await fetchProfile(buildProfileUrl(requestedVars));
      if (doc) {
        requestedBGC = true;
      } else {
        // If specific combination 404'd (e.g. float has doxy but not ph), query data=all to get whatever sensors exist
        doc = await fetchProfile(buildProfileUrl(['all']));
        if (doc) requestedBGC = true;
      }
    }

    // Step 2: Fallback to core-only vars if needed
    if (!doc) {
      const coreUrl = buildProfileUrl(CORE_VARS);
      doc = await fetchProfile(coreUrl);
    }

    if (doc) {
      const { observations, verticalProfile } = normalizeArgoProfile(doc);

      const resultData = {
        profileId: doc._id,
        // platform_number is NOT present in Argovis responses — always derive from _id
        platformId: String(doc._id).split('_')[0],
        cycleNumber: doc.cycle_number !== undefined ? doc.cycle_number : (String(doc._id).split('_')[1] || ''),
        timestamp: doc.timestamp,
        coordinates: doc.geolocation?.coordinates || [0, 0],
        verticalProfile,
        observations,
        requestedBGC,
        source: (Array.isArray(doc.source) && doc.source[0]?.source?.[0]) || 'argo_core'
      };

      profileCache.set(cacheKey, {
        timestamp: Date.now(),
        data: resultData
      });

      // Persist sampled levels into SQLite observations without overwriting baseline
      try {
        if (observations.length > 0) {
          saveTelemetryRecords(observations, 'argovis', false);
        }
      } catch {
        // Non-blocking
      }

      lastApiStatus.isAvailable = true;
      lastApiStatus.lastChecked = new Date().toISOString();
      lastApiStatus.lastSuccessfulSync = new Date().toISOString();

      return {
        success: true,
        isFallback: false,
        isCached: false,
        ...resultData
      };
    }

    throw new Error(`Profile ${profileId} returned HTTP ${response.status}`);
  } catch (err) {
    // Check if we have any cached observations for this float in SQLite
    const platformId = profileId.split('_')[0];
    const localRows = listTelemetryRecords(100).filter(r => r.buoyId === `ARGO-${platformId}` || r.buoyId?.includes(platformId));

    if (localRows.length > 0) {
      return {
        success: true,
        isFallback: true,
        profileId,
        platformId,
        cycleNumber: localRows[0].cycleNumber || 1,
        timestamp: localRows[0].timestamp,
        coordinates: [localRows[0].longitude, localRows[0].latitude],
        observations: localRows,
        verticalProfile: {
          profileId,
          platformId,
          cycleNumber: 1,
          timestamp: localRows[0].timestamp,
          coordinates: [localRows[0].longitude, localRows[0].latitude],
          levelsCount: localRows.length,
          pressure: localRows.map(r => r.pressure),
          depth: localRows.map(r => r.depth),
          temperature: localRows.map(r => r.temperature),
          salinity: localRows.map(r => r.salinity),
          oxygen: localRows.map(r => r.oxygenContent),
          ph: localRows.map(r => r.ph),
          units: { pressure: 'decibar', temperature: 'degree_Celsius', salinity: 'psu', oxygen: 'mg/L', ph: 'pH scale' }
        },
        source: 'local_fallback'
      };
    }

    return {
      success: false,
      isFallback: true,
      error: `Could not retrieve profile ${profileId}: ${err.message}`
    };
  }
}

/**
 * Backward-compatible function for existing route /api/argo/profiles.
 * Now internally leverages discovery and dynamic normalization.
 */
export async function getArgoProfiles({
  startDate,
  endDate,
  platform,
  box,
  center,
  radius = 500,
  limit = 50,
  forceRefresh = false
} = {}) {
  const discoveryResult = await discoverArgoProfiles({
    startDate,
    endDate,
    box,
    center,
    radius,
    platform,
    limit,
    forceRefresh
  });

  // Return formatted response compatible with existing consumers
  const observations = [];
  discoveryResult.uniqueFloats.forEach(f => {
    observations.push({
      source: 'argovis',
      buoyId: `ARGO-${f.floatId}`,
      buoyName: f.floatName,
      latitude: f.latestLatitude,
      longitude: f.latestLongitude,
      depth: 0,
      timestamp: f.latestTimestamp,
      temperature: null,
      pressure: null,
      salinity: null,
      oxygenContent: null,
      ph: null,
      batteryLevel: null,
      cycleNumber: f.latestCycle,
      availableVariables: f.availableVariables
    });
  });

  return {
    success: discoveryResult.success,
    isFallback: discoveryResult.isFallback,
    isCached: discoveryResult.isCached,
    source: discoveryResult.source,
    count: observations.length,
    uniqueFloatCount: discoveryResult.uniqueFloatCount,
    observations,
    uniqueFloats: discoveryResult.uniqueFloats,
    lastChecked: lastApiStatus.lastChecked,
    lastSuccessfulSync: lastApiStatus.lastSuccessfulSync,
    apiKeyConfigured: Boolean(getArgovisApiKey())
  };
}

/**
 * Returns the current status of the Argovis integration.
 * Public Argovis API is open and functional; optional API key increases quotas.
 */
export function getArgovisStatus() {
  const apiKey = getArgovisApiKey();
  const argoCount = Number(db.prepare("SELECT COUNT(*) AS n FROM telemetry_observations WHERE source = 'argovis'").get().n);
  const localCount = Number(db.prepare("SELECT COUNT(*) AS n FROM telemetry_observations WHERE source != 'argovis'").get().n);

  return {
    isConfigured: true, // Public Argovis API is ready and available without credentials
    apiKeyConfigured: Boolean(apiKey),
    isAvailable: lastApiStatus.isAvailable,
    lastChecked: lastApiStatus.lastChecked,
    lastSuccessfulSync: lastApiStatus.lastSuccessfulSync,
    lastError: lastApiStatus.error,
    cachedArgoCount: argoCount,
    fallbackRecordsCount: localCount,
    overview: overviewCache.data || null,
    provider: 'Argovis API 2.0 (University of Colorado Boulder)',
    docsUrl: 'https://argovis-api.colorado.edu/docs/'
  };
}

export default {
  getArgoProfiles,
  getArgoOverview,
  discoverArgoProfiles,
  getArgoProfileById,
  getArgovisStatus,
  normalizeArgoProfile,
  groupProfilesByFloat,
  parseDataInfo
};
