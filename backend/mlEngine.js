import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveMLAnomalies } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_TXT_FILE = path.join(__dirname, 'data', 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt');
const REPORT_MD_FILE = path.join(__dirname, 'data', 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.md');

/**
 * Oceanographic anomaly screening with robust median/MAD baselines scoped by
 * float and depth band. This is a statistical heuristic, not a trained model.
 */

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function depthBand(record) {
  if (record.depth === null || record.depth === undefined) return null;
  const depth = Number(record.depth);
  return Number.isFinite(depth) ? Math.floor(depth / 100) : null;
}

function robustStats(values) {
  const center = median(values);
  if (center === null) return { center: null, scale: null, count: 0 };
  const mad = median(values.filter(Number.isFinite).map(value => Math.abs(value - center)));
  return { center, scale: mad === null ? null : 1.4826 * mad, count: values.filter(Number.isFinite).length };
}

function buildDepthBaselines(dataset, fields) {
  const profileGroups = new Map();
  for (const record of dataset) {
    const band = depthBand(record);
    if (band === null) continue;
    const profileKey = `${record.buoyId || 'unknown'}|${record.timestamp}|${band}`;
    for (const field of fields) {
      const value = Number(record[field.key]);
      if (record[field.key] === null || record[field.key] === undefined || !Number.isFinite(value)) continue;
      if (!profileGroups.has(profileKey)) profileGroups.set(profileKey, { buoyId: record.buoyId, band, values: new Map() });
      const group = profileGroups.get(profileKey);
      if (!group.values.has(field.key)) group.values.set(field.key, []);
      group.values.get(field.key).push(value);
    }
  }
  const groups = new Map();
  for (const profile of profileGroups.values()) {
    for (const [fieldKey, values] of profile.values) {
      const profileValue = median(values);
      for (const key of [`float:${profile.buoyId}:${profile.band}:${fieldKey}`, `regional:${profile.band}:${fieldKey}`]) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(profileValue);
      }
    }
  }
  const stats = new Map([...groups].map(([key, values]) => [key, robustStats(values)]));
  return (record, field) => {
    const band = depthBand(record);
    if (band === null) return null;
    const local = stats.get(`float:${record.buoyId}:${band}:${field.key}`);
    if (local?.count >= 8 && local.scale > 0) return { ...local, basis: 'profile-median baseline for this float and 100 m depth band' };
    const regional = stats.get(`regional:${band}:${field.key}`);
    if (regional?.count >= 12 && regional.scale > 0) return { ...regional, basis: 'profile-median baseline across floats in the same 100 m depth band' };
    return null;
  };
}

function summarizeCoverage(dataset) {
  const sourceRows = new Map();
  const floatProfiles = new Map();
  for (const record of dataset) {
    const source = record.source || 'unknown';
    if (!sourceRows.has(source)) sourceRows.set(source, []);
    sourceRows.get(source).push(record);
    const key = `${record.buoyId}|${record.timestamp}`;
    floatProfiles.set(key, record);
  }
  const floats = new Set(dataset.map(record => record.buoyId).filter(Boolean));
  const timestamps = [...new Set(dataset.map(record => new Date(record.timestamp).getTime()).filter(Number.isFinite))].sort((a, b) => a - b);
  const fields = ['temperature', 'salinity', 'pressure', 'depth', 'oxygenContent', 'ph'];
  const availableMeasurements = Object.fromEntries(fields.map(field => [field, dataset.filter(record => record[field] !== null && record[field] !== undefined && Number.isFinite(Number(record[field]))).length]));
  const depths = dataset.filter(record => record.depth !== null && record.depth !== undefined).map(record => Number(record.depth)).filter(Number.isFinite);
  const profilesByFloat = {};
  const profileTimesByFloat = new Map();
  const profileRecordsByFloat = new Map();
  for (const [key, record] of floatProfiles) {
    const floatId = record.buoyId || 'unknown';
    profilesByFloat[floatId] = (profilesByFloat[floatId] || 0) + 1;
    if (!profileRecordsByFloat.has(floatId)) profileRecordsByFloat.set(floatId, []);
    profileRecordsByFloat.get(floatId).push(record);
    const time = new Date(record.timestamp).getTime();
    if (Number.isFinite(time)) {
      if (!profileTimesByFloat.has(floatId)) profileTimesByFloat.set(floatId, []);
      profileTimesByFloat.get(floatId).push(time);
    }
  }
  const intervalsDays = [...profileTimesByFloat.values()].flatMap(times => {
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    return sorted.slice(1).map((time, index) => (time - sorted[index]) / 86400000);
  }).filter(Number.isFinite).sort((a, b) => a - b);
  const perFloatCoverage = Object.fromEntries([...profileRecordsByFloat].map(([floatId, records]) => {
    const profileTimes = [...new Set(records.map(record => Date.parse(record.timestamp)).filter(Number.isFinite))].sort((a, b) => a - b);
    const gaps = profileTimes.slice(1).map((time, index) => (time - profileTimes[index]) / 86400000);
    const medianGap = median(gaps);
    const available = Object.fromEntries(fields.map(field => [field, records.filter(record => record[field] !== null && record[field] !== undefined && Number.isFinite(Number(record[field]))).length]));
    const floatDepths = records.filter(record => record.depth !== null && record.depth !== undefined).map(record => Number(record.depth)).filter(Number.isFinite);
    const spanDays = profileTimes.length > 1 ? (profileTimes.at(-1) - profileTimes[0]) / 86400000 : 0;
    return [floatId, {
      distinctProfiles: profileTimes.length,
      firstObservation: profileTimes.length ? new Date(profileTimes[0]).toISOString() : null,
      latestObservation: profileTimes.length ? new Date(profileTimes.at(-1)).toISOString() : null,
      medianProfileIntervalDays: medianGap === null ? null : Number(medianGap.toFixed(2)),
      availableVariables: Object.entries(available).filter(([, count]) => count > 0).map(([field]) => field),
      availableMeasurements: available,
      depthRangeMeters: floatDepths.length ? { min: Math.min(...floatDepths), max: Math.max(...floatDepths) } : null,
      trendAnalysisCandidate: profileTimes.length >= 3 && spanDays >= 30,
      forecastCandidate: profileTimes.length >= 8 && medianGap !== null && medianGap <= 30,
      eligibilityNote: profileTimes.length < 3 ? 'Too few distinct profiles for a temporal trend.' : (profileTimes.length < 8 ? 'Trend can be summarized; forecast validation needs at least 8 distinct profiles.' : (medianGap > 30 ? 'Sampling gaps are too large for the 7–30 day forecast window.' : 'Candidate only; forecast still requires horizon-specific chronological validation against persistence.'))
    }];
  }));
  return {
    observations: dataset.length,
    floats: floats.size,
    distinctProfiles: floatProfiles.size,
    profilesByFloat,
    perFloat: perFloatCoverage,
    profileIntervalDays: intervalsDays.length ? {
      min: Number(intervalsDays[0].toFixed(2)),
      median: Number(median(intervalsDays).toFixed(2)),
      max: Number(intervalsDays[intervalsDays.length - 1].toFixed(2)),
      intervalsCount: intervalsDays.length
    } : null,
    firstObservation: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    lastObservation: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
    depthRangeMeters: depths.length ? { min: Math.min(...depths), max: Math.max(...depths) } : null,
    availableMeasurements,
    missingMeasurements: Object.fromEntries(fields.map(field => [field, dataset.length - availableMeasurements[field]])),
    sources: Object.fromEntries([...sourceRows].map(([source, rows]) => [source, rows.length]))
  };
}

export function analyzeTelemetryML(dataset, { source = 'LIVE ARGOVIS', saveToDb = true } = {}) {
  if (!dataset || dataset.length === 0) {
    return {
      success: false,
      message: 'Dataset is empty. Cannot run ML analysis.'
    };
  }

  // Robust screening uses only measured ocean variables and compares records
  // within a float/depth band, falling back to a same-depth regional baseline.
  // Pressure/depth are retained as observations, but not treated as anomalies.
  const oceanFields = [
    { key: 'temperature', label: 'TEMPERATURE', unit: '°C' },
    { key: 'salinity', label: 'SALINITY', unit: ' PSU' },
    { key: 'oxygenContent', label: 'OXYGEN', unit: ' mg/L' },
    { key: 'ph', label: 'PH', unit: '' }
  ];
  const baselineFor = buildDepthBaselines(dataset, oceanFields);
  const N = dataset.length;

  const analyzedRecords = dataset.map((record) => {
    const components = [];
    for (const field of oceanFields) {
      const value = record[field.key] === null || record[field.key] === undefined ? null : Number(record[field.key]);
      if (!Number.isFinite(value)) continue;
      const baseline = baselineFor(record, field);
      if (!baseline) continue;
      const z = (value - baseline.center) / baseline.scale;
      components.push({ ...field, value, z, baseline });
    }
    const score = components.length ? Math.sqrt(components.reduce((sum, item) => sum + item.z ** 2, 0)) : null;
    const strongest = components.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const anomalous = strongest.filter(item => Math.abs(item.z) >= 3.5);
    const mlPredictedAnomaly = anomalous.length > 0;
    const anomalyTypes = anomalous.map(item => `${item.label}_ROBUST_DEPTH_BASELINE`);
    const explanation = anomalous.map(item => `${item.label.toLowerCase()} ${item.value}${item.unit} is ${item.z.toFixed(1)} robust standard deviations from the ${item.baseline.basis} (median ${item.baseline.center.toFixed(3)}, n=${item.baseline.count})`).join('; ');

    return {
      ...record,
      isolationForestScore: null,
      standardizedEuclideanDist: score === null ? null : Number(score.toFixed(4)),
      mahalanobisDist: null,
      ensembleAnomalyScore: score === null ? null : Number(score.toFixed(4)),
      anomalyScore: score === null ? null : Number(score.toFixed(4)),
      riskPercentage: null,
      isAnomaly: mlPredictedAnomaly,
      groundTruth: null,
      anomalyTypes,
      explanation: explanation || (score === null ? 'Insufficient same-depth baseline data or no supported ocean measurements.' : 'No measured ocean variable exceeded the robust screening threshold.'),
      robustComponents: components.map(item => ({ feature: item.key, value: item.value, robustZ: Number(item.z.toFixed(3)), baseline: item.baseline.basis, baselineCount: item.baseline.count })),
      severity: anomalous.some(item => Math.abs(item.z) >= 5) ? 'CRITICAL' : (mlPredictedAnomaly ? 'WARNING' : 'NORMAL')
    };
  });

  const total = N;
  const metrics = {
    accuracy: null,
    precision: null,
    recall: null,
    f1Score: null,
    rocAuc: null,
    confusionMatrix: null,
    totalRecordsAnalyzed: total,
    anomaliesDetectedCount: analyzedRecords.filter(r => r.isAnomaly).length,
    recordsScored: analyzedRecords.filter(record => record.anomalyScore !== null).length,
    recordsUnscored: analyzedRecords.filter(record => record.anomalyScore === null).length,
    evaluationStatus: 'NOT_EVALUATED',
    evaluationNote: 'No independent ground-truth labels are available. Live inference results are not evaluation metrics.'
  };

  // 2. Specialized Tsunami & Coastal Flood Simulation Module (Shallow Water Wave Theory)
  const disasterForecasts = predictTsunamisAndFloods(analyzedRecords);

  // 3. Time-Series Future Anomaly Predictor based on actual observation timestamps
  const futurePredictions = predictFutureAnomalies(analyzedRecords);
  const coverage = summarizeCoverage(dataset);
  const predictiveOceanIntelligence = {
    status: 'LIVE_FLOAT_HISTORY_REQUIRED',
    message: 'The SQLite screening cache does not retain full float histories or per-level QC. Select a float to retrieve its live Argovis profile history and test depth-matched models against persistence.',
    coverage,
    eventAssessments: [
      'marine heatwave or unusual warming', 'oxygen depletion or hypoxia development',
      'stratification change', 'salinity anomaly or freshwater influence',
      'pH trend / acidification indicator', 'unusual multivariate pattern'
    ].map(event => ({ event, status: 'NOT_ASSESSED_INSUFFICIENT_VALIDATED_TEMPORAL_COVERAGE' })),
    forecasts: futurePredictions,
    evaluation: { method: 'Chronological holdout against persistence baseline', status: 'NOT_RUN_INSUFFICIENT_DATA', mae: null, rmse: null, predictionInterval: null }
  };

  const summarizeValues = (values) => {
    const valid = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
    if (!valid.length) return { mean: null, std: null, count: 0 };
    const avg = valid.reduce((sum, value) => sum + value, 0) / valid.length;
    const variance = valid.length > 1
      ? valid.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (valid.length - 1)
      : null;
    return { mean: avg, std: variance === null ? null : Math.sqrt(variance), count: valid.length };
  };
  const globalStats = {
    temp: summarizeValues(dataset.map(d => d.temperature)),
    oxygen: summarizeValues(dataset.map(d => d.oxygenContent)),
    salinity: summarizeValues(dataset.map(d => d.salinity)),
    pressure: summarizeValues(dataset.map(d => d.pressure)),
    ph: summarizeValues(dataset.map(d => d.ph)),
    battery: summarizeValues(dataset.map(d => d.batteryLevel))
  };

  const benchmarkMetrics = { evaluationStatus: 'NOT_EVALUATED', note: 'Not evaluated – independent ground-truth labels unavailable. Expert-reviewed labels are required.' };

  const flaggedAnomalies = analyzedRecords
    .filter(r => r.isAnomaly)
    .map(r => {
      const platformId = r.platformId || String(r.buoyId || '').replace('ARGO-', '');
      const profileId = r.profileId || (r.cycleNumber ? `${platformId}_${r.cycleNumber}` : null);
      const stableId = profileId ? `ANOM-${profileId}-${Math.round(r.depth || 0)}` : `ANOM-${r.buoyId || 'FLOAT'}-${new Date(r.timestamp).getTime()}`;
      return {
        id: stableId,
        source: r.source === 'local' ? 'LOCAL BASELINE' : (source || 'LIVE ARGOVIS'),
        retrievalSource: r.retrievalSource || null,
        platformId,
        buoyId: r.buoyId,
        buoyName: r.buoyName,
        profileId,
        cycleNumber: r.cycleNumber !== undefined ? r.cycleNumber : null,
        observationTimestamp: r.timestamp,
        detectionTimestamp: new Date().toISOString(),
        latitude: r.latitude,
        longitude: r.longitude,
        depth: r.depth,
        pressure: r.pressure,
        temperature: r.temperature,
        salinity: r.salinity,
        oxygenContent: r.oxygenContent,
        ph: r.ph,
        batteryLevel: r.batteryLevel,
        anomalyType: r.anomalyTypes ? r.anomalyTypes.join(', ') : 'STATISTICAL_DISTRIBUTION_DRIFT',
        anomalyTypes: r.anomalyTypes,
        severity: r.severity,
        anomalyScore: r.anomalyScore,
        isolationForestScore: r.isolationForestScore,
        standardizedEuclideanDist: r.standardizedEuclideanDist,
        explanation: r.explanation,
      qcStatus: 'NOT_ASSESSED',
        isSimulated: false
      };
    });

  if (saveToDb && flaggedAnomalies.length > 0) {
    try {
      saveMLAnomalies(flaggedAnomalies);
    } catch {
      // Non-blocking
    }
  }

  const inferenceSummary = {
    totalRecordsAnalyzed: total,
    anomaliesDetectedCount: flaggedAnomalies.length,
    criticalCount: flaggedAnomalies.filter(a => a.severity === 'CRITICAL').length,
    warningCount: flaggedAnomalies.filter(a => a.severity === 'WARNING').length,
    evaluatedAt: new Date().toISOString(),
    dataSource: source
  };

  const reportText = generateMLReportText(metrics, globalStats, dataset, disasterForecasts, coverage);
  saveReportFiles(reportText);

  return {
    success: true,
    metrics,
    benchmarkMetrics,
    inferenceSummary,
    anomalies: flaggedAnomalies,
    stats: globalStats,
    records: analyzedRecords,
    futurePredictions,
    coverage,
    predictiveOceanIntelligence,
    disasterForecasts,
    reportTextFile: 'ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt'
  };
}

/**
 * Evaluates simulated shallow water wave velocity and hydrostatic pressure surge.
 * SCIENTIFIC LIMITATION: ARGO measurements alone do not predict earthquakes or tsunamis.
 * Hydrostatic surge detection is an experimental indicator, not an official warning declaration.
 */
function predictTsunamisAndFloods(records) {
  const buoyGroups = {};

  records.forEach(r => {
    if (!buoyGroups[r.buoyId]) buoyGroups[r.buoyId] = [];
    buoyGroups[r.buoyId].push(r);
  });

  const disasterResults = [];

  Object.keys(buoyGroups).forEach(buoyId => {
    const buoyRecords = buoyGroups[buoyId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const recent = buoyRecords.slice(-5);
    if (recent.length === 0) return;

    const latest = recent[recent.length - 1];
    const latestPres = latest.pressure !== null && latest.pressure !== undefined && Number.isFinite(Number(latest.pressure))
      ? Number(latest.pressure)
      : null;

    // Shallow Water Wave Velocity Formula: v = sqrt(g * depth)
    // ARGO profile pressure/depth are water-column measurements, not bottom-pressure
    // time series, atmospheric pressure, or coastal bathymetry.
    const oceanDepth = null;
    const waveVelocityMps = null;
    const waveVelocityKph = null;
    const etaMinutes = null;
    const tsunamiRiskScore = null;
    const tsunamiRiskPercentage = null;
    const floodRiskScore = null;
    const floodRiskPercentage = null;
    const tsunamiReasons = ['Not assessable from ARGO profiles; bottom-pressure and validated coastal data are unavailable.'];
    const floodReasons = ['Not assessable from ARGO profiles; atmospheric and coastal water-level observations are unavailable.'];

    disasterResults.push({
      buoyId: latest.buoyId,
      buoyName: latest.buoyName,
      latitude: latest.latitude,
      longitude: latest.longitude,
      oceanDepth,
      latestPressure: latestPres,
      pressureZScore: null,
      
      tsunamiRiskScore,
      tsunamiRiskPercentage,
      waveVelocityMps,
      waveVelocityKph,
      coastalEtaMinutes: etaMinutes,
      tsunamiThreatLevel: 'NOT_ASSESSABLE_FROM_ARGO',
      tsunamiReasons,

      floodRiskScore,
      floodRiskPercentage,
      floodThreatLevel: 'NOT_ASSESSABLE_FROM_ARGO',
      floodReasons,
      scientificDisclaimer: 'Experimental model output. Official warnings are issued exclusively by INCOIS, PTWC, or regional meteorological authorities.'
    });
  });

  return disasterResults;
}

/**
 * Forecasting is intentionally withheld until there is enough profile-level history
 * for a chronological holdout and persistence-baseline comparison.
 */
function predictFutureAnomalies(records) {
  return [];
}

const ACCEPTABLE_ARGO_QC_FLAGS = new Set(['1', '2', '5']);
const HISTORY_FEATURES = [
  { key: 'temperature', profileKey: 'temperature', label: 'Temperature', unit: '°C' },
  { key: 'salinity', profileKey: 'salinity', label: 'Salinity', unit: 'PSU' },
  { key: 'oxygen', profileKey: 'oxygen', label: 'Dissolved oxygen', unit: 'mg/L' },
  { key: 'ph', profileKey: 'ph', label: 'pH', unit: '' }
];

function argovisValueIsUsable(values, flags, index) {
  const value = Number(values?.[index]);
  if (values?.[index] === null || values?.[index] === undefined || !Number.isFinite(value)) return false;
  if (!Array.isArray(flags)) return true;
  return ACCEPTABLE_ARGO_QC_FLAGS.has(String(flags[index] ?? ''));
}

function fitLinearSeries(points) {
  if (points.length < 2) return null;
  const origin = points[0].time;
  const xs = points.map(point => (point.time - origin) / 86400000);
  const ys = points.map(point => point.value);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (!denominator) return null;
  const slopePerDay = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) / denominator;
  const intercept = yMean - slopePerDay * xMean;
  return {
    slopePerDay,
    predict: (time) => intercept + slopePerDay * ((time - origin) / 86400000)
  };
}

function fitArOneSeries(points, medianIntervalDays) {
  if (points.length < 8 || !medianIntervalDays) return null;
  const intervals = points.slice(1).map((point, index) => (point.time - points[index].time) / 86400000);
  const meanGap = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const gapCv = meanGap > 0
    ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - meanGap) ** 2, 0) / intervals.length) / meanGap
    : Infinity;
  const maxGap = Math.max(...intervals);
  if (gapCv > 0.3 || maxGap > medianIntervalDays * 2.5) return null;

  const previous = points.slice(0, -1).map(point => point.value);
  const next = points.slice(1).map(point => point.value);
  const xMean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const yMean = next.reduce((sum, value) => sum + value, 0) / next.length;
  const denominator = previous.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (!denominator) return null;
  const phi = previous.reduce((sum, value, index) => sum + (value - xMean) * (next[index] - yMean), 0) / denominator;
  if (!Number.isFinite(phi) || phi < 0 || phi >= 1) return null;
  const intercept = yMean - phi * xMean;
  const longRunMean = intercept / (1 - phi);
  return {
    phi,
    longRunMean,
    predict: (lastValue, horizonDays) => longRunMean + (lastValue - longRunMean) * (phi ** (horizonDays / medianIntervalDays))
  };
}

function summarizeError(predictions) {
  if (!predictions.length) return { mae: null, rmse: null, count: 0 };
  const errors = predictions.map(item => item.prediction - item.actual);
  return {
    mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    rmse: Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length),
    count: errors.length
  };
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function backtestAtHorizon(points, horizonDays, medianIntervalDays, method) {
  const predictions = [];
  const minimumTrainingCount = method === 'persistence' ? 1 : 8;
  const toleranceDays = Math.max(3, medianIntervalDays * 0.55);
  for (let originIndex = minimumTrainingCount - 1; originIndex < points.length - 1; originIndex++) {
    const origin = points[originIndex];
    const targetTime = origin.time + horizonDays * 86400000;
    let targetIndex = -1;
    let nearestDistance = Infinity;
    for (let index = originIndex + 1; index < points.length; index++) {
      const distance = Math.abs(points[index].time - targetTime) / 86400000;
      if (distance < nearestDistance) { nearestDistance = distance; targetIndex = index; }
      if (points[index].time > targetTime + toleranceDays) break;
    }
    if (targetIndex < 0 || nearestDistance > toleranceDays) continue;
    const training = points.slice(0, originIndex + 1);
    let prediction = origin.value;
    if (method === 'linear') {
      const model = fitLinearSeries(training);
      if (!model) continue;
      prediction = model.predict(targetTime);
    } else if (method === 'ar1') {
      const model = fitArOneSeries(training, medianIntervalDays);
      if (!model) continue;
      prediction = model.predict(origin.value, horizonDays);
    }
    predictions.push({ prediction, actual: points[targetIndex].value, targetOffsetDays: (points[targetIndex].time - targetTime) / 86400000 });
  }
  return { ...summarizeError(predictions), toleranceDays };
}

function analyzeHistorySeries(points, feature, bandStart, bandEnd) {
  const sorted = points.slice().sort((a, b) => a.time - b.time);
  const distinct = [];
  for (const point of sorted) {
    const previous = distinct[distinct.length - 1];
    if (previous && previous.time === point.time) previous.value = (previous.value + point.value) / 2;
    else distinct.push({ ...point });
  }
  const intervalDays = distinct.slice(1).map((point, index) => (point.time - distinct[index].time) / 86400000).filter(value => value > 0);
  const medianIntervalDays = median(intervalDays);
  const linear = fitLinearSeries(distinct);
  const ar1 = fitArOneSeries(distinct, medianIntervalDays);
  const validation = {};
  for (const horizon of [7, 30]) {
    validation[horizon] = {
      persistence: backtestAtHorizon(distinct, horizon, medianIntervalDays, 'persistence'),
      linear: distinct.length >= 8 ? backtestAtHorizon(distinct, horizon, medianIntervalDays, 'linear') : { mae: null, rmse: null, count: 0 },
      ar1: ar1 ? backtestAtHorizon(distinct, horizon, medianIntervalDays, 'ar1') : { mae: null, rmse: null, count: 0 }
    };
  }
  const allMethods = ['linear', 'ar1'];
  let selectedAlgorithm = 'persistence baseline';
  for (const method of allMethods) {
    if (!distinct.length || (method === 'linear' && !linear) || (method === 'ar1' && !ar1)) continue;
    const validAtBothHorizons = [7, 30].every(horizon => {
      const candidate = validation[horizon][method];
      const baseline = validation[horizon].persistence;
      return candidate.count >= 3 && baseline.count >= 3 && candidate.mae < baseline.mae;
    });
    if (validAtBothHorizons) {
      const current = selectedAlgorithm === 'persistence baseline' ? null : selectedAlgorithm === 'linear regression' ? 'linear' : 'ar1';
      const candidateScore = [7, 30].reduce((sum, horizon) => sum + validation[horizon][method].mae, 0);
      const currentScore = current ? [7, 30].reduce((sum, horizon) => sum + validation[horizon][current].mae, 0) : Infinity;
      if (candidateScore < currentScore) selectedAlgorithm = method === 'linear' ? 'linear regression' : 'AR(1) (ARIMA(1,0,0) approximation)';
    }
  }
  const selectedMethod = selectedAlgorithm === 'linear regression' ? 'linear' : selectedAlgorithm.startsWith('AR(1)') ? 'ar1' : 'persistence';
  const latest = distinct.at(-1) || null;
  const first = distinct[0] || null;
  const historicalValues = distinct.slice(0, -1).map(point => point.value);
  const historicalRange = historicalValues.length >= 8
    ? { lower5th: quantile(historicalValues, 0.05), upper95th: quantile(historicalValues, 0.95), sampleCount: historicalValues.length }
    : null;
  const latestHistoricalStatus = latest && historicalRange
    ? (latest.value < historicalRange.lower5th ? 'below historical 5th percentile'
      : latest.value > historicalRange.upper95th ? 'above historical 95th percentile' : 'within prior historical 5th–95th percentile range')
    : 'historical quantile screen unavailable';
  const supportedHorizons = [];
  const forecasts = [7, 30].map(horizonDays => {
    const checks = validation[horizonDays];
    const candidateValidation = selectedMethod === 'persistence' ? checks.persistence : checks[selectedMethod];
    const persistenceValidation = checks.persistence;
    const supported = Boolean(latest && distinct.length >= 8 && candidateValidation.count >= 3 &&
      candidateValidation.mae < persistenceValidation.mae);
    let forecastValue = null;
    if (supported) {
      const time = latest.time + horizonDays * 86400000;
      forecastValue = selectedMethod === 'linear' ? linear.predict(time)
        : selectedMethod === 'ar1' ? ar1.predict(latest.value, horizonDays)
          : latest.value;
      supportedHorizons.push(horizonDays);
    }
    return {
      horizonDays,
      supported,
      value: forecastValue === null ? null : Number(forecastValue.toFixed(4)),
      unit: feature.unit,
      algorithm: supported ? selectedAlgorithm : null,
      persistenceBaseline: latest ? Number(latest.value.toFixed(4)) : null,
      validation: {
        model: selectedMethod === 'persistence' ? null : candidateValidation,
        persistence: persistenceValidation,
        targetToleranceDays: candidateValidation.toleranceDays ?? persistenceValidation.toleranceDays ?? null
      },
      uncertainty: supported && candidateValidation.count >= 5
        ? { type: 'approximate holdout RMSE interval', lower: Number((forecastValue - 1.96 * candidateValidation.rmse).toFixed(4)), upper: Number((forecastValue + 1.96 * candidateValidation.rmse).toFixed(4)) }
        : null,
      reason: supported ? 'Chronological horizon-specific backtest improved on persistence.'
        : (distinct.length < 8 ? `Only ${distinct.length} valid distinct profile timestamps; at least 8 are required for forecast validation.`
          : `No candidate method beat persistence in at least 3 matched ${horizonDays}-day chronological holdout predictions.`)
    };
  });
  return {
    variable: feature.key,
    label: feature.label,
    unit: feature.unit,
    depthBand: { minMeters: bandStart, maxMeters: bandEnd },
    distinctProfiles: distinct.length,
    history: distinct.map(point => ({ timestamp: new Date(point.time).toISOString(), profileId: point.profileId, value: Number(point.value.toFixed(5)) })),
    firstTimestamp: first ? new Date(first.time).toISOString() : null,
    latestTimestamp: latest ? new Date(latest.time).toISOString() : null,
    latestValue: latest ? Number(latest.value.toFixed(5)) : null,
    historicalRange: historicalRange ? { lower5th: Number(historicalRange.lower5th.toFixed(5)), upper95th: Number(historicalRange.upper95th.toFixed(5)), sampleCount: historicalRange.sampleCount } : null,
    latestHistoricalStatus,
    medianProfileIntervalDays: medianIntervalDays,
    trend: distinct.length >= 3 && linear ? { slopePerDay: Number(linear.slopePerDay.toFixed(7)), changeFirstToLatest: Number((latest.value - first.value).toFixed(4)), direction: linear.slopePerDay > 0 ? 'increasing' : linear.slopePerDay < 0 ? 'decreasing' : 'flat' } : null,
    algorithm: selectedAlgorithm,
    modelSelection: 'Select linear regression or regular-cadence AR(1) only when it beats persistence on at least 3 matched chronological holdouts at both 7-day and 30-day horizons; otherwise withhold forecast.',
    validation,
    forecasts,
    supportedHorizons
  };
}

export function analyzeArgoFloatProfileHistory(profileResults = [], { floatId = null } = {}) {
  const seenProfiles = new Set();
  const profiles = [];
  let duplicateProfilesRemoved = 0;
  for (const result of profileResults) {
    if (!result?.success || result.isFallback || !result.verticalProfile) continue;
    const vertical = result.verticalProfile;
    const profileId = result.profileId || vertical.profileId || `${floatId || 'ARGO'}_${result.timestamp || vertical.timestamp}`;
    const timestamp = result.timestamp || vertical.timestamp;
    const key = `${profileId}|${timestamp}`;
    if (seenProfiles.has(key)) { duplicateProfilesRemoved++; continue; }
    seenProfiles.add(key);
    profiles.push({ result, vertical, profileId, timestamp, time: Date.parse(timestamp) });
  }
  profiles.sort((a, b) => a.time - b.time);

  const profileSummaries = [];
  const bandGroups = new Map();
  const qcCounts = {};
  const qcAcceptedCounts = {};
  let duplicateLevelsRemoved = 0;
  const depthRange = [];

  for (const profile of profiles) {
    const vertical = profile.vertical;
    const n = Math.max(vertical.pressure?.length || 0, vertical.depth?.length || 0, vertical.temperature?.length || 0);
    const qcFlags = vertical.qualityFlags || {};
    const levelByPressure = new Map();
    for (let index = 0; index < n; index++) {
      const pressureValue = vertical.pressure?.[index];
      const depthValue = vertical.depth?.[index];
      const pressure = pressureValue === null || pressureValue === undefined ? null : Number(pressureValue);
      const rawDepth = depthValue === null || depthValue === undefined ? null : Number(depthValue);
      const depth = Number.isFinite(rawDepth) ? rawDepth : (Number.isFinite(pressure) ? pressure * 0.993 : null);
      if (depth === null || !Number.isFinite(depth)) continue;
      const pressureQc = qcFlags.pressure;
      if (Array.isArray(pressureQc) && !ACCEPTABLE_ARGO_QC_FLAGS.has(String(pressureQc[index] ?? ''))) continue;
      const level = { index, depth, pressure: Number.isFinite(pressure) ? pressure : null, values: {} };
      for (const feature of HISTORY_FEATURES) {
        const values = vertical[feature.profileKey];
        const flags = qcFlags[feature.profileKey];
        const flag = Array.isArray(flags) ? String(flags[index] ?? 'missing') : 'unavailable';
        qcCounts[feature.key] ||= {};
        qcCounts[feature.key][flag] = (qcCounts[feature.key][flag] || 0) + 1;
        if (argovisValueIsUsable(values, flags, index)) {
          level.values[feature.key] = Number(values[index]);
          qcAcceptedCounts[feature.key] = (qcAcceptedCounts[feature.key] || 0) + 1;
        }
      }
      depthRange.push(depth);
      const pressureKey = level.pressure === null ? `d:${depth.toFixed(1)}` : `p:${level.pressure.toFixed(1)}`;
      const existing = levelByPressure.get(pressureKey);
      if (existing) {
        duplicateLevelsRemoved++;
        for (const [key, value] of Object.entries(level.values)) if (existing.values[key] === undefined) existing.values[key] = value;
      } else levelByPressure.set(pressureKey, level);
    }
    const uniqueLevels = [...levelByPressure.values()].sort((a, b) => a.depth - b.depth);
    const profileFields = {};
    const profileBands = new Map();
    for (const level of uniqueLevels) {
      const bandStart = Math.floor(level.depth / 100) * 100;
      if (!profileBands.has(bandStart)) profileBands.set(bandStart, new Map());
      const band = profileBands.get(bandStart);
      for (const [key, value] of Object.entries(level.values)) {
        if (!band.has(key)) band.set(key, []);
        band.get(key).push(value);
      }
    }
    for (const [bandStart, fieldValues] of profileBands) {
      const bandKey = `${bandStart}`;
      if (!bandGroups.has(bandKey)) bandGroups.set(bandKey, new Map());
      const target = bandGroups.get(bandKey);
      for (const feature of HISTORY_FEATURES) {
        const values = fieldValues.get(feature.key);
        if (!values?.length) continue;
        profileFields[feature.key] ||= true;
        if (!target.has(feature.key)) target.set(feature.key, []);
        target.get(feature.key).push({ time: profile.time, timestamp: profile.timestamp, value: median(values), profileId: profile.profileId });
      }
    }
    const gradients = [];
    for (let index = 1; index < uniqueLevels.length; index++) {
      const prev = uniqueLevels[index - 1];
      const current = uniqueLevels[index];
      const deltaDepth = current.depth - prev.depth;
      if (deltaDepth <= 0 || deltaDepth > 100) continue;
      gradients.push({
        temperature: prev.values.temperature !== undefined && current.values.temperature !== undefined ? (current.values.temperature - prev.values.temperature) / deltaDepth * 100 : null,
        salinity: prev.values.salinity !== undefined && current.values.salinity !== undefined ? (current.values.salinity - prev.values.salinity) / deltaDepth * 100 : null
      });
    }
    const validGradients = (key) => gradients.map(item => item[key]).filter(Number.isFinite);
    const tempGradients = validGradients('temperature');
    const salinityGradients = validGradients('salinity');
    profileSummaries.push({
      profileId: profile.profileId,
      cycleNumber: profile.result.cycleNumber ?? null,
      timestamp: profile.timestamp,
      coordinates: profile.vertical.coordinates || profile.result.coordinates || null,
      levels: uniqueLevels.length,
      variables: Object.keys(profileFields),
      source: profile.result.argovisDataSources || [profile.result.source || 'ARGOVIS API'],
      argovisUpdatedAt: profile.result.argovisUpdatedAt || null,
      qualityFlagsAvailable: vertical.qualityFlagsAvailable || [],
      verticalGradients: {
        temperatureCPer100m: tempGradients.length ? Number(median(tempGradients).toFixed(4)) : null,
        salinityPsuPer100m: salinityGradients.length ? Number(median(salinityGradients).toFixed(4)) : null,
        temperatureStratificationProxy: tempGradients.length ? Number(median(tempGradients.map(Math.abs)).toFixed(4)) : null,
        note: 'Profile gradient indicator only; not density-derived buoyancy frequency.'
      }
    });
  }

  const bands = [...bandGroups].sort((a, b) => Number(a[0]) - Number(b[0])).map(([start, fields]) => ({
    depthBand: { minMeters: Number(start), maxMeters: Number(start) + 100 },
    fields: HISTORY_FEATURES.flatMap(feature => {
      const points = fields.get(feature.key);
      return points?.length ? [analyzeHistorySeries(points, feature, Number(start), Number(start) + 100)] : [];
    })
  }));
  const latestProfile = profileSummaries.at(-1) || null;
  return {
    floatId,
    source: 'ARGOVIS live API',
    fullProfileDocumentsAnalyzed: profiles.length,
    distinctProfilesRetrieved: profiles.length,
    duplicateProfilesRemoved,
    duplicateLevelsRemoved,
    firstProfileTimestamp: profileSummaries[0]?.timestamp || null,
    latestObservationTimestamp: latestProfile?.timestamp || null,
    profileIntervalDays: (() => {
      const intervals = profileSummaries.slice(1).map((profile, index) => (Date.parse(profile.timestamp) - Date.parse(profileSummaries[index].timestamp)) / 86400000);
      return intervals.length ? { min: Number(Math.min(...intervals).toFixed(2)), median: Number(median(intervals).toFixed(2)), max: Number(Math.max(...intervals).toFixed(2)), count: intervals.length } : null;
    })(),
    depthRangeMeters: depthRange.length ? { min: Number(Math.min(...depthRange).toFixed(1)), max: Number(Math.max(...depthRange).toFixed(1)) } : null,
    qualityControl: { acceptedFlags: [...ACCEPTABLE_ARGO_QC_FLAGS], countsByVariable: qcCounts, acceptedValuesByVariable: qcAcceptedCounts, note: 'Only flags 1, 2 and 5 are included in trend analysis. Flags 0, 3, 4, 6, 7, 8 (estimated), 9 and missing flags are excluded when a QC array is present. Values are retained with QC provenance in each profile summary.' },
    latestVerticalStructure: latestProfile?.verticalGradients || null,
    profiles: profileSummaries,
    bands
  };
}

function generateMLReportText(metrics, stats, dataset, disasterForecasts = [], coverage = summarizeCoverage(dataset)) {
  const now = new Date().toISOString();
  const formatStat = (stat, unit = '', digits = 2) => stat.mean === null
    ? 'N/A'
    : `${stat.mean.toFixed(digits)}${unit} | StdDev = ${stat.std === null ? 'N/A' : `${stat.std.toFixed(digits)}${unit}`}`;

  return `================================================================================
FLOATCHAT AI - ADVANCED TSUNAMI, FLOOD & ANOMALY PREDICTION REPORT
================================================================================
Generated At          : ${now}
Dataset Size          : ${dataset.length} Records
Algorithm Architecture: Profile-Median Robust MAD Screening by Float and 100 m Depth Band
Disaster Target       : ARGO Ocean-Condition Anomaly Screening
Tsunami / Flood Risk  : Not assessable from ARGO profile data
================================================================================

1. METHODOLOGY & MATHEMATICAL ARCHITECTURE
--------------------------------------------------------------------------------
A. Robust Depth-Aware Screening
   Per-measurement robust z = (x - median) / (1.4826 * MAD), using a float/depth
   band baseline when it has enough samples, otherwise a same-depth regional baseline.
   A record is flagged when an available ocean variable has absolute robust z >= 3.5.
   Combined Euclidean distance is a unitless screening score, not a probability.
   Each profile contributes one median per feature and depth band. No Isolation Forest,
   PCA, Mahalanobis covariance model, or trained classifier is implemented.

B. Tsunami / Coastal Flood Assessment
   Not calculated: ARGO pressure and depth represent water-column profile levels,
   not seafloor bottom-pressure time series, bathymetry, or coastal water levels.

C. Predictive Ocean Intelligence
   Forecasts are withheld until profile-level history supports chronological validation
   against a persistence baseline. Profile levels are never treated as time steps.

D. SCIENTIFIC LIMITATION NOTICE:
   ARGO oceanographic profile measurements alone do not predict earthquakes or tsunamis.
   Tsunami, flood, rainfall, cloud, cyclone, and conventional weather forecasts are
   unavailable from this dataset. Follow official warnings from national authorities.


2. MODEL EVALUATION & HONEST ACCURACY METRICS
--------------------------------------------------------------------------------
Overall Model Accuracy    : Not evaluated
Precision Score           : Not evaluated
Recall Score              : Not evaluated
F1 Score                  : Not evaluated
ROC-AUC Benchmark         : Not evaluated
Total Telemetry Evaluated : ${metrics.totalRecordsAnalyzed} records
Anomalies Detected        : ${metrics.anomaliesDetectedCount} records

Confusion Matrix         : Not evaluated (no independent ground-truth labels)
Evaluation Note          : Anomaly inference is not model performance evaluation.
Evaluation Method        : Not run. Requires independently expert-reviewed labels,
                            locked chronological train/test periods, threshold selection
                            on training data only, and comparison with a simple baseline.


3. ACTUAL DATA COVERAGE
--------------------------------------------------------------------------------
Floats                  : ${coverage.floats}
Distinct Profiles       : ${coverage.distinctProfiles}
First Observation      : ${coverage.firstObservation || 'N/A'}
Last Observation       : ${coverage.lastObservation || 'N/A'}
Depth Range            : ${coverage.depthRangeMeters ? `${coverage.depthRangeMeters.min}–${coverage.depthRangeMeters.max} m` : 'N/A'}
Profile Intervals      : ${coverage.profileIntervalDays ? `median ${coverage.profileIntervalDays.median} days across ${coverage.profileIntervalDays.intervalsCount} intervals` : 'N/A'}
Available Values       : ${Object.entries(coverage.availableMeasurements).map(([feature, count]) => `${feature}=${count}`).join(', ')}

4. PREDICTIVE OCEAN INTELLIGENCE
--------------------------------------------------------------------------------
Forecast Status        : Withheld; available temporal coverage is insufficient for
                          validated 7–30 day forecasting against a persistence baseline.
Forecast MAE / RMSE    : Not evaluated; no forecast holdout was run.
Prediction Intervals   : Not available.
ARGO profiles alone do not support rainfall, clouds, cyclones, atmospheric pressure,
or conventional weather forecasts.

5. BASELINE OCEANOGRAPHIC FEATURE DISTRIBUTIONS
--------------------------------------------------------------------------------
- Temperature        : Mean = ${formatStat(stats.temp, ' °C')}
- Dissolved Oxygen   : Mean = ${formatStat(stats.oxygen, ' mg/L')}
- Salinity           : Mean = ${formatStat(stats.salinity, ' PSU')}
- Pressure           : Mean = ${formatStat(stats.pressure, ' dbar')}
- pH Level           : Mean = ${formatStat(stats.ph)}
- Battery Level      : Mean = ${formatStat(stats.battery, ' %')}

================================================================================
Report generated automatically by FloatChat AI Predictive Engine.
================================================================================
`;
}

function saveReportFiles(content) {
  try {
    const dataDir = path.dirname(REPORT_TXT_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(REPORT_TXT_FILE, content, 'utf8');
    fs.writeFileSync(REPORT_MD_FILE, `# FloatChat AI ML Report\n\`\`\`text\n${content}\n\`\`\``, 'utf8');
  } catch (err) {
    console.error('Error saving ML report file:', err);
  }
}

export function getReportContent() {
  try {
    if (fs.existsSync(REPORT_TXT_FILE)) {
      return fs.readFileSync(REPORT_TXT_FILE, 'utf8');
    }
  } catch (err) {
    console.error('Error reading report file:', err);
  }
  return 'ML Accuracy Report not yet generated. Please execute ML prediction first.';
}

export default {
  analyzeTelemetryML,
  getReportContent
};
