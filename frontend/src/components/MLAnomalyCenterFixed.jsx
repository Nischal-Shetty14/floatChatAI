import React, { useState, useEffect } from 'react';
import { Brain, Cpu, Download, FileText, RefreshCw, AlertTriangle, CheckCircle2, Zap, ShieldAlert, BarChart3, ChevronRight, Send, Radio, Activity } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { authHeaders } from '../utils/authClient';

function MLAnomalyCenter({ telemetryData }) {
  const [mlData, setMlData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('predictions'); // 'predictions', 'disasters', 'forecasting', 'formulas', 'report'
  const [reportText, setReportText] = useState('');
  const [isSendingSMS, setIsSendingSMS] = useState(false);
  const [smsNotification, setSmsNotification] = useState(null);
  const [dataSource, setDataSource] = useState('WAITING FOR ARGOVIS DATA');
  const [lastEvaluatedAt, setLastEvaluatedAt] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [selectedFloatId, setSelectedFloatId] = useState('');
  const [selectedDepthBand, setSelectedDepthBand] = useState('');
  const [floatAnalysis, setFloatAnalysis] = useState(null);
  const [floatAnalysisLoading, setFloatAnalysisLoading] = useState(false);
  const [floatAnalysisError, setFloatAnalysisError] = useState('');

  // Run ML Evaluation (Live Argovis or Cached Observations)
  const runMLEvaluation = async (forceLive = false) => {
    setIsLoading(true);
    setLoadError('');
    try {
      const response = await fetch('/api/ml/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceLive })
      });
      if (response.ok) {
        const data = await response.json();
        setMlData(data);
        if (data.dataSource) setDataSource(data.dataSource);
        if (data.evaluatedAt) setLastEvaluatedAt(data.evaluatedAt);
      } else {
        const error = await response.json().catch(() => ({}));
        setLoadError(error.error || 'ARGO evaluation failed. No source data may be available.');
      }
    } catch (err) {
      console.error('Error fetching ML results:', err);
      setLoadError('Could not reach the FloatChat backend.');
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch report text
  const fetchReportText = async () => {
    try {
      const response = await fetch('/api/ml/report');
      if (response.ok) {
        const data = await response.json();
        setReportText(data.reportText);
      }
    } catch (err) {
      console.error('Error loading report text:', err);
    }
  };

  const getAnomalyExplanation = (tag) => {
    switch (tag) {
      case 'STATISTICAL_DISTRIBUTION_DRIFT':
        return 'Significant multivariate deviation from the normal oceanographic distribution.';
      case 'HYPOXIA_CRITICAL':
        return 'Dissolved oxygen below the engine screening threshold (<2.8 mg/L); confirm sensor units and local criteria.';
      case 'THERMAL_INVERSION':
        return 'Warm measurement below 500 m flagged for review; a single threshold does not establish a temperature inversion.';
      case 'HYDROSTATIC_PRESSURE_SURGE':
        return 'Hydrostatic pressure or depth anomaly significantly exceeding standard profile limits.';
      case 'SALINITY_ANOMALY':
        return 'Abnormal salinity spike or freshwater dilution layer detected.';
      case 'PH_OUTLIER':
        return 'pH measurement outside the configured screening range; this alone does not establish ocean acidification.';
      case 'BATTERY_CRITICAL':
        return 'Sensor power reserve depleted below critical safe operation limit.';
      default:
        return 'Unusual oceanographic measurement pattern flagged by standardized-distance screening.';
    }
  };

  useEffect(() => {
    runMLEvaluation(false).then(fetchReportText);
  }, []);

  useEffect(() => {
    const coverage = mlData?.coverage?.perFloat || {};
    const floatIds = Object.keys(coverage);
    if (floatIds.length && !floatIds.includes(selectedFloatId)) {
      const preferred = floatIds.sort((a, b) => coverage[b].distinctProfiles - coverage[a].distinctProfiles)[0];
      setSelectedFloatId(preferred.replace(/^ARGO-/, ''));
    }
  }, [mlData, selectedFloatId]);

  const analyzeSelectedFloat = async () => {
    if (!selectedFloatId) return;
    setFloatAnalysisLoading(true);
    setFloatAnalysisError('');
    setFloatAnalysis(null);
    try {
      const response = await fetch('/api/ml/ocean-intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ floatId: selectedFloatId })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Argovis profile retrieval failed.');
      setFloatAnalysis(data);
      const defaultBand = data.analysis?.bands?.find(band => band.fields.some(field => field.key === 'temperature')) || data.analysis?.bands?.[0];
      if (defaultBand) setSelectedDepthBand(String(defaultBand.depthBand.minMeters));
    } catch (error) {
      setFloatAnalysisError(error.message || 'Could not analyze this float.');
    } finally {
      setFloatAnalysisLoading(false);
    }
  };

  // Handle direct download of the ML report text file
  const handleDownloadReport = () => {
    window.location.href = '/api/ml/report/download';
  };

  const handleQuickSMSAlert = async (record) => {
    setIsSendingSMS(true);
    setSmsNotification(null);
    try {
      const scoreText = Number.isFinite(record.anomalyScore) ? `Standardized distance: ${record.anomalyScore.toFixed(2)} (unitless).` : 'No calibrated risk probability is available.';
      const msg = `ML ALERT: ${record.buoyName} (${record.buoyId}) flagged ${record.anomalyTypes ? record.anomalyTypes.join(', ') : 'oceanographic anomaly'}. ${scoreText}`;
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: msg,
          buoyName: record.buoyName,
          severity: record.severity || 'CRITICAL',
          liveOnly: true
        })
      });
      const data = await res.json();
      if (data.success) {
        setSmsNotification({ type: 'success', text: `Emergency SMS dispatched! Mode: ${data.mode} (ID: ${data.sid})` });
      } else {
        setSmsNotification({ type: 'error', text: `SMS Notice: ${data.error || 'Check Twilio credentials'}` });
      }
    } catch (err) {
      setSmsNotification({ type: 'error', text: 'Error contacting server for SMS dispatch.' });
    } finally {
      setIsSendingSMS(false);
    }
  };

  const metrics = mlData?.metrics || { totalRecordsAnalyzed: 0, confusionMatrix: null };

  const evaluatedRecords = mlData?.records || [];
  const recentObservations = [...evaluatedRecords]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 30);
  const detectedAnomalies = mlData?.records?.filter(r => r.isAnomaly) || [];
  const futurePredictions = mlData?.futurePredictions || [];
  const coverage = mlData?.coverage;
  const disasterForecasts = mlData?.disasterForecasts || [];
  const floatCoverage = coverage?.perFloat || {};
  const selectableFloats = Object.entries(floatCoverage).sort((a, b) => b[1].distinctProfiles - a[1].distinctProfiles);
  const selectedCoverage = floatCoverage[`ARGO-${selectedFloatId}`];
  const selectedHistory = floatAnalysis?.analysis;
  const currentBand = selectedHistory?.bands?.find(band => String(band.depthBand.minMeters) === selectedDepthBand);

  return (
    <div className="tab-container">
      {/* Header Banner */}
      <div className="section-header glow-box">
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div className="icon-badge" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>
            <Brain size={28} />
          </div>
          <div>
            <h1 className="gradient-title" style={{ fontSize: '24px', margin: 0 }}>
              Ocean-Condition Anomaly Screening
            </h1>
            <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0 0', fontSize: '14px' }}>
              Profile-median robust screening of actual ARGO measurements in comparable depth bands
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '6px 12px', borderRadius: '20px',
            background: dataSource.includes('ARGOVIS') ? 'rgba(0,180,100,0.12)' : 'rgba(255,255,255,0.1)',
            border: `1px solid ${dataSource.includes('ARGOVIS') ? 'var(--color-success)' : 'var(--border)'}`,
            fontSize: '11px', fontWeight: '700',
            color: dataSource.includes('ARGOVIS') ? 'var(--color-success)' : 'var(--text-secondary)'
          }}>
            <Activity size={13} />
            <span>{dataSource}</span>
          </div>

          <button className="btn-secondary" onClick={() => runMLEvaluation(true)} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
            <span>{isLoading ? 'Retrieving Argovis & Evaluating...' : 'Re-Evaluate ML Model (Live Argovis)'}</span>
          </button>

          <button className="btn-primary" onClick={handleDownloadReport}>
            <Download size={16} />
            <span>Download ML Report (.txt)</span>
          </button>
        </div>
      </div>

      {loadError && <div className="panel-card" role="alert"><strong>ARGO evaluation unavailable:</strong> {loadError}</div>}

      {lastEvaluatedAt && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span>Last Evaluation: <strong>{new Date(lastEvaluatedAt).toLocaleString()}</strong></span>
          <span>·</span>
          <span>Dataset Source: <strong>{dataSource}</strong> ({metrics.totalRecordsAnalyzed || 0} observations evaluated)</span>
          <span>·</span>
          <span>Anomalies Flagged: <strong>{detectedAnomalies.length}</strong></span>
        </div>
      )}

      {smsNotification && (
        <div className={`alert-banner ${smsNotification.type === 'success' ? 'banner-success' : 'banner-error'}`}>
          {smsNotification.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{smsNotification.text}</span>
          <button onClick={() => setSmsNotification(null)} className="close-btn">×</button>
        </div>
      )}

      {/* Model Performance Scorecards: Distinguishes Offline Ground-Truth Benchmark from Live Inference */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Benchmark Accuracy</span>
            <CheckCircle2 size={18} color="var(--color-success)" />
          </div>
          <div className="stat-value text-success">Not evaluated</div>
          <div className="stat-footer">No independent labeled benchmark dataset is available</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Precision &amp; Recall</span>
            <Zap size={18} color="var(--color-primary)" />
          </div>
          <div className="stat-value text-primary">Not evaluated</div>
          <div className="stat-footer">Precision, recall and F1 require ground-truth labels</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">ROC-AUC Index</span>
            <Cpu size={18} color="var(--color-info)" />
          </div>
          <div className="stat-value text-info">Not evaluated</div>
          <div className="stat-footer">ROC-AUC requires labeled evaluation data</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">ARGO Anomalies Flagged</span>
            <ShieldAlert size={18} color="var(--color-warning)" />
          </div>
          <div className="stat-value text-warning">{detectedAnomalies.length}</div>
          <div className="stat-footer">{metrics.recordsScored || 0} scored · {metrics.recordsUnscored || 0} unscored of {metrics.totalRecordsAnalyzed || 0} observations</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-label">Inference Data Source</span>
            <Activity size={18} color={dataSource.includes('ARGOVIS') ? 'var(--color-success)' : 'var(--color-primary)'} />
          </div>
          <div className="stat-value" style={{ fontSize: '16px', color: dataSource.includes('ARGOVIS') ? 'var(--color-success)' : 'var(--color-primary)', textTransform: 'uppercase' }}>
            {dataSource}
          </div>
          <div className="stat-footer">Real-world CTD observations &amp; sampled depths</div>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="subtabs-bar">
        <button 
          className={`subtab-btn ${activeTab === 'predictions' ? 'active' : ''}`}
          onClick={() => setActiveTab('predictions')}
        >
          <ShieldAlert size={16} />
          <span>Anomaly Predictions ({detectedAnomalies.length})</span>
        </button>

        <button 
          className={`subtab-btn ${activeTab === 'disasters' ? 'active' : ''}`}
          onClick={() => setActiveTab('disasters')}
        >
          <Radio size={16} color="var(--color-danger)" />
          <span>Tsunami & Flood Early Warning</span>
        </button>

        <button 
          className={`subtab-btn ${activeTab === 'forecasting' ? 'active' : ''}`}
          onClick={() => setActiveTab('forecasting')}
        >
          <Zap size={16} />
          <span>Predictive Ocean Intelligence</span>
        </button>

        <button 
          className={`subtab-btn ${activeTab === 'formulas' ? 'active' : ''}`}
          onClick={() => setActiveTab('formulas')}
        >
          <Cpu size={16} />
          <span>Algorithm & Formulas</span>
        </button>

        <button 
          className={`subtab-btn ${activeTab === 'report' ? 'active' : ''}`}
          onClick={() => setActiveTab('report')}
        >
          <FileText size={16} />
          <span>Accuracy Text Report</span>
        </button>
      </div>

      {/* TAB 1: ANOMALY PREDICTIONS */}
      {activeTab === 'predictions' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Detected Anomalies in Telemetry Data ({detectedAnomalies.length})</h3>
              <p>Robust median/MAD screening within float and 100 m depth bands. The unitless score is not a probability or independently validated event.</p>
            </div>
            {metrics.confusionMatrix ? <div className="confusion-matrix-mini">
              <span>TP: {metrics.confusionMatrix.truePositives}</span>
              <span>FP: {metrics.confusionMatrix.falsePositives}</span>
              <span>FN: {metrics.confusionMatrix.falseNegatives}</span>
              <span>TN: {metrics.confusionMatrix.trueNegatives}</span>
            </div> : <div className="confusion-matrix-mini">Evaluation metrics: Not evaluated</div>}
          </div>

          {detectedAnomalies.length === 0 ? (
            <div className="empty-state">
              <AlertTriangle size={42} color="var(--color-warning)" />
              <p>No observations crossed the current screening threshold. Some records may be unscored because there is not enough same-depth baseline data; this does not establish that conditions are stable.</p>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="telemetry-table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Source</th>
                    <th>Station / Float ID</th>
                    <th>Observation Time</th>
                    <th>Depth / Pressure</th>
                    <th>Salinity (PSU)</th>
                    <th>O₂ Level</th>
                    <th>Temp (°C)</th>
                    <th>pH</th>
                    <th>Battery</th>
                    <th>Standardized Distance</th>
                    <th>Detected Anomaly Reason</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {detectedAnomalies.map((rec, idx) => {
                    const anomalyScore = Number.isFinite(rec.anomalyScore) ? rec.anomalyScore : rec.ensembleAnomalyScore;

                    return (
                      <tr key={idx} className={rec.severity === 'CRITICAL' ? 'row-critical' : 'row-warning'}>
                        <td>
                          <span className={`badge badge-${rec.severity.toLowerCase()}`}>
                            {rec.severity}
                          </span>
                        </td>
                        <td>
                          <span style={{
                            fontSize: '10px',
                            fontWeight: '700',
                            padding: '2px 6px',
                            borderRadius: '10px',
                            background: String(rec.retrievalSource || rec.source || dataSource).toUpperCase().includes('ARGO') ? 'rgba(0,180,100,0.12)' : 'var(--bg-page)',
                            color: String(rec.retrievalSource || rec.source || dataSource).toUpperCase().includes('ARGO') ? 'var(--color-success)' : 'var(--text-secondary)',
                            border: '1px solid var(--border)'
                          }}>
                            {rec.retrievalSource || String(rec.source || dataSource).toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <strong>{rec.buoyName}</strong>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            {rec.profileId ? `Profile: ${rec.profileId}` : (rec.cycleNumber !== undefined && rec.cycleNumber !== null ? `Cycle ${rec.cycleNumber}` : rec.buoyId)}
                          </div>
                        </td>
                        <td>{new Date(rec.timestamp).toLocaleString()}</td>
                        <td>{Number.isFinite(rec.depth) ? `${rec.depth} m` : 'N/A'} / {Number.isFinite(rec.pressure) ? `${rec.pressure} dbar` : 'N/A'}</td>
                        <td>{rec.salinity !== null && rec.salinity !== undefined ? `${rec.salinity} PSU` : 'N/A'}</td>
                        <td className={rec.oxygenContent !== null && rec.oxygenContent < 4.0 ? 'text-danger font-bold' : ''}>
                          {rec.oxygenContent !== null && rec.oxygenContent !== undefined ? `${rec.oxygenContent} mg/L` : 'N/A'}
                        </td>
                        <td className={rec.temperature !== null && rec.temperature > 15 && rec.depth > 500 ? 'text-warning font-bold' : ''}>
                          {rec.temperature !== null && rec.temperature !== undefined ? `${rec.temperature}°C` : 'N/A'}
                        </td>
                        <td>
                          {rec.ph !== null && rec.ph !== undefined ? rec.ph : 'N/A'}
                        </td>
                        <td className={rec.batteryLevel !== null && rec.batteryLevel < 25 ? 'text-danger font-bold' : ''}>
                          {rec.batteryLevel !== null && rec.batteryLevel !== undefined ? `${rec.batteryLevel}%` : <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>N/A (Argo)</span>}
                        </td>
                        <td>
                          <span className="risk-text" title="Combined robust standardized distance; not a probability">
                            {Number.isFinite(anomalyScore) ? anomalyScore.toFixed(2) : 'Score unavailable'}
                          </span>
                        </td>
                        <td>
                          <div className="tags-container" style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {rec.anomalyTypes && rec.anomalyTypes.length > 0 ? (
                                rec.anomalyTypes.map((tag, tIdx) => (
                                  <span key={tIdx} className="tag-pill">{tag}</span>
                                ))
                              ) : (
                                <span className="tag-pill">{rec.explanation || 'STATISTICAL_DISTRIBUTION_DRIFT'}</span>
                              )}
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.3' }}>
                              {rec.explanation || (rec.anomalyTypes && rec.anomalyTypes.length > 0
                                ? getAnomalyExplanation(rec.anomalyTypes[0])
                                : getAnomalyExplanation('STATISTICAL_DISTRIBUTION_DRIFT'))}
                            </span>
                          </div>
                        </td>
                        <td>
                          <button
                            className="btn-xs btn-sms"
                            onClick={() => handleQuickSMSAlert(rec)}
                            disabled={isSendingSMS}
                            title="Dispatch Twilio SMS Alert"
                          >
                            <Send size={12} />
                            <span>SMS Alert</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'predictions' && evaluatedRecords.length > 0 && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Actual ARGO observations evaluated</h3>
              <p>Showing the latest {recentObservations.length} of {evaluatedRecords.length} evaluated records. Measurements and screening results below come from these same records.</p>
            </div>
          </div>
          <div className="table-responsive">
            <table className="telemetry-table">
              <thead><tr><th>Source</th><th>Float</th><th>Profile time</th><th>Depth (m)</th><th>Pressure (dbar)</th><th>Temperature (°C)</th><th>Salinity (PSU)</th><th>Oxygen (mg/L)</th><th>pH</th><th>QC provenance</th><th>Score</th><th>Screening</th></tr></thead>
              <tbody>{recentObservations.map((record, index) => (
                <tr key={`${record.buoyId}-${record.timestamp}-${record.depth}-${index}`}>
                  <td>{record.retrievalSource || 'ARGOVIS observation in SQLite cache'}</td>
                  <td>{record.buoyId || 'N/A'}</td>
                  <td>{record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A'}</td>
                  <td>{Number.isFinite(record.depth) ? record.depth : 'N/A'}</td>
                  <td>{record.pressure !== null && record.pressure !== undefined ? record.pressure : 'N/A'}</td>
                  <td>{record.temperature !== null && record.temperature !== undefined ? record.temperature : 'N/A'}</td>
                  <td>{record.salinity !== null && record.salinity !== undefined ? record.salinity : 'N/A'}</td>
                  <td>{record.oxygenContent !== null && record.oxygenContent !== undefined ? record.oxygenContent : 'N/A'}</td>
                  <td>{record.ph !== null && record.ph !== undefined ? record.ph : 'N/A'}</td>
                  <td>{record.qualityFlags ? 'Per-level QC available' : 'Not retained in SQLite cache'}</td>
                  <td>{Number.isFinite(record.anomalyScore) ? record.anomalyScore.toFixed(2) : 'N/A'}</td>
                  <td>{record.anomalyScore === null ? 'Unscored' : record.isAnomaly ? 'Flagged for review' : 'No threshold flag'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: TSUNAMI & COASTAL FLOOD EARLY WARNING CENTER */}
      {activeTab === 'disasters' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Radio size={20} color="var(--color-danger)" />
                Tsunami & Coastal Flood Data Availability
              </h3>
              <p>ARGO profiles do not provide bottom-pressure time series, atmospheric pressure, or coastal water levels needed to calculate these risks.</p>
            </div>
          </div>

          <div className="predictions-cards-grid">
            {disasterForecasts.map((d, idx) => (
              <div key={idx} className={`forecast-card glow-card ${d.tsunamiRiskPercentage > 60 ? 'border-critical' : ''}`}>
                <div className="forecast-card-header">
                  <div>
                    <span className="buoy-badge">{d.buoyId}</span>
                    <h4 style={{ margin: '4px 0 0 0', fontSize: '16px' }}>{d.buoyName}</h4>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Seafloor depth: {Number.isFinite(d.oceanDepth) ? `${d.oceanDepth} meters` : 'Not available'}</span>
                  </div>
                  <div className="badge badge-warning">
                    {d.tsunamiThreatLevel}
                  </div>
                </div>

                <div className="disaster-gauges-row">
                  {/* Tsunami Risk Gauge */}
                  <div className="disaster-gauge-box">
                    <div className="gauge-circle" style={{ borderColor: 'var(--border)' }}>
                      <span className="gauge-num">N/A</span>
                      <span className="gauge-lbl">NOT ASSESSABLE</span>
                    </div>
                    <div className="gauge-meta">
                      <span>Wave Velocity: <strong>N/A</strong></span>
                      <span>Coastal ETA: <strong>N/A</strong></span>
                    </div>
                  </div>

                  {/* Coastal Flood Risk Gauge */}
                  <div className="disaster-gauge-box">
                    <div className="gauge-circle" style={{ borderColor: 'var(--border)' }}>
                      <span className="gauge-num">N/A</span>
                      <span className="gauge-lbl">NOT ASSESSABLE</span>
                    </div>
                    <div className="gauge-meta">
                      <span>Assessment: <strong>{d.floodThreatLevel}</strong></span>
                      <span>Pressure deviation: <strong>{Number.isFinite(d.pressureZScore) ? `${d.pressureZScore} σ` : 'N/A'}</strong></span>
                    </div>
                  </div>
                </div>

                <div className="forecast-reasons" style={{ marginTop: '12px' }}>
                  <strong>Hydrodynamic Risk Indicators:</strong>
                  <ul>
                    {d.tsunamiReasons.concat(d.floodReasons).map((r, rIdx) => (
                      <li key={rIdx}>{r}</li>
                    ))}
                  </ul>
                </div>

                <button 
                  className={`btn-primary ${d.tsunamiRiskPercentage > 60 ? 'btn-danger-active' : ''}`}
                  style={{ width: '100%', marginTop: '12px', fontSize: '13px' }}
                  disabled
                  title="ARGO data cannot provide a valid tsunami or flood risk estimate."
                >
                  <Send size={14} />
                  <span>Dispatch Twilio Emergency Tsunami/Flood SMS</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: PREDICTIVE OCEAN INTELLIGENCE */}
      {activeTab === 'forecasting' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Predictive Ocean Intelligence</h3>
              <p>Observed patterns and data sufficiency for oceanographic trend analysis. ARGO profiles do not support conventional weather forecasts.</p>
            </div>
          </div>

          {futurePredictions.length === 0 ? (
            <div className="empty-state">
              <AlertTriangle size={42} color="var(--color-warning)" />
              <p>The local cache is used for anomaly screening. Select a float below to retrieve its current Argovis profile history and test whether a variable supports an oceanographic forecast.</p>
              {coverage && <div className="forecast-reasons">
                <strong>Available data coverage</strong>
                <ul>
                  <li>{coverage.observations + (mlData?.duplicatesRemoved || 0)} ARGO cache rows; {coverage.observations} unique observations used across {coverage.floats} floats and {coverage.distinctProfiles} profiles; {mlData?.duplicatesRemoved || 0} duplicate rows removed.</li>
                  <li>Depth range: {coverage.depthRangeMeters ? `${coverage.depthRangeMeters.min}–${coverage.depthRangeMeters.max} m` : 'N/A'}.</li>
                  <li>Between-profile intervals: {coverage.profileIntervalDays ? `${coverage.profileIntervalDays.min}–${coverage.profileIntervalDays.max} days (median ${coverage.profileIntervalDays.median}, n=${coverage.profileIntervalDays.intervalsCount})` : 'not available'}.</li>
                  {Object.entries(coverage.availableMeasurements || {}).map(([field, count]) => <li key={field}>{field}: {count} available, {coverage.missingMeasurements?.[field] ?? 'N/A'} missing</li>)}
                </ul>
                <p>Time span: {coverage.firstObservation ? new Date(coverage.firstObservation).toLocaleString() : 'N/A'} to {coverage.lastObservation ? new Date(coverage.lastObservation).toLocaleString() : 'N/A'}. Source counts: {Object.entries(coverage.sources || {}).map(([source, count]) => `${source} (${count})`).join(', ') || 'N/A'}.</p>
                {Object.keys(coverage.perFloat || {}).length > 0 && <div className="table-responsive"><table className="telemetry-table"><thead><tr><th>Cached float</th><th>Profiles</th><th>Observation span</th><th>Median gap</th><th>Variables</th><th>Trend candidate</th><th>Forecast candidate</th></tr></thead><tbody>{Object.entries(coverage.perFloat).map(([floatId, item]) => <tr key={floatId}><td>{floatId}</td><td>{item.distinctProfiles}</td><td>{item.firstObservation ? new Date(item.firstObservation).toLocaleDateString() : 'N/A'} – {item.latestObservation ? new Date(item.latestObservation).toLocaleDateString() : 'N/A'}</td><td>{item.medianProfileIntervalDays ?? 'N/A'} days</td><td>{item.availableVariables.join(', ') || 'N/A'}</td><td>{item.trendAnalysisCandidate ? 'Candidate' : 'No'}</td><td title={item.eligibilityNote}>{item.forecastCandidate ? 'Candidate; backtest required' : 'No'}</td></tr>)}</tbody></table></div>}
                <p>Observed anomaly flags are statistical candidates, not developing-event detections. ARGO alone cannot establish rainfall, clouds, cyclones, atmospheric pressure, or conventional weather.</p>
                {mlData?.predictiveOceanIntelligence?.eventAssessments && <p>Event screening: {mlData.predictiveOceanIntelligence.eventAssessments.map(item => item.event).join('; ')} — not assessed because validated, comparable-depth time series are insufficient.</p>}
              </div>}
            </div>
          ) : (
            <div className="predictions-cards-grid">
              {futurePredictions.map((pred, pIdx) => (
                <div key={pIdx} className="forecast-card glow-card">
                  <div className="forecast-card-header">
                    <div>
                      <span className="buoy-badge">{pred.buoyId}</span>
                      <h4 style={{ margin: '4px 0 0 0', fontSize: '16px' }}>{pred.buoyName}</h4>
                    </div>
                    <div className="urgency-badge">
                      +{pred.hoursAhead} Hours Ahead
                    </div>
                  </div>

                  <div className="forecast-risk-gauge">
                    <div className="risk-circle" style={{ borderColor: 'var(--color-warning)' }}>
                      <span className="risk-num">N/A</span>
                      <span className="risk-lbl">Risk probability unavailable</span>
                    </div>
                    <div className="forecast-metrics-list">
                      <div>
                        <span>Forecast O2:</span>
                        <strong className={pred.predictedOxygenContent < 4.0 ? 'text-danger' : ''}>
                          {pred.predictedOxygenContent !== null ? `${pred.predictedOxygenContent} mg/L` : 'N/A'}
                        </strong>
                      </div>
                      <div>
                        <span>Forecast Temp:</span>
                        <strong>{pred.predictedTemperature !== null ? `${pred.predictedTemperature}°C` : 'N/A'}</strong>
                      </div>
                      <div>
                        <span>Forecast Battery:</span>
                        <strong className={pred.predictedBatteryLevel < 20 ? 'text-danger' : ''}>
                          {pred.predictedBatteryLevel !== null ? `${pred.predictedBatteryLevel}%` : 'N/A'}
                        </strong>
                      </div>
                      <div>
                        <span>Expected Time:</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {new Date(pred.forecastTimestamp).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="forecast-reasons">
                    <strong>Primary Failure Triggers:</strong>
                    <ul>
                      {pred.reasons.map((r, rIdx) => (
                        <li key={rIdx}>{r}</li>
                      ))}
                    </ul>
                  </div>

                  <button 
                    className="btn-primary" 
                    style={{ width: '100%', marginTop: '12px', fontSize: '13px' }}
                    onClick={() => handleQuickSMSAlert({
                      buoyName: pred.buoyName,
                      buoyId: pred.buoyId,
                      riskPercentage: pred.forecastRiskPercentage,
                      anomalyTypes: pred.reasons,
                      severity: pred.urgency === 'HIGH_IMMINENT' ? 'CRITICAL' : 'WARNING'
                    })}
                  >
                    <Send size={14} />
                    <span>Dispatch Preventive Twilio SMS Alert</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'forecasting' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Selected float historical analysis</h3>
              <p>Retrieves at most the 36 latest full profiles from the live Argovis API. This request is read-only and does not persist profile data.</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="input-field" value={selectedFloatId} onChange={event => { setSelectedFloatId(event.target.value); setFloatAnalysis(null); }} disabled={floatAnalysisLoading}>
              <option value="">Choose an ARGO float</option>
              {selectableFloats.map(([floatId, item]) => <option key={floatId} value={floatId.replace(/^ARGO-/, '')}>{floatId} · {item.distinctProfiles} cached profiles</option>)}
            </select>
            <button className="btn-primary" type="button" onClick={analyzeSelectedFloat} disabled={!selectedFloatId || floatAnalysisLoading}>
              <Activity size={16} /> {floatAnalysisLoading ? 'Retrieving Argovis history…' : 'Analyze live profile history'}
            </button>
          </div>
          {selectedCoverage && <p className="stat-footer">Cached records: {selectedCoverage.distinctProfiles} profiles, {selectedCoverage.firstObservation ? new Date(selectedCoverage.firstObservation).toLocaleDateString() : 'N/A'} to {selectedCoverage.latestObservation ? new Date(selectedCoverage.latestObservation).toLocaleDateString() : 'N/A'}; median profile gap {selectedCoverage.medianProfileIntervalDays ?? 'N/A'} days. {selectedCoverage.eligibilityNote}</p>}
          {floatAnalysisError && <div className="alert-banner banner-error" role="alert">{floatAnalysisError}</div>}
          {floatAnalysisLoading && <div className="empty-state"><Activity size={30} /><p>Fetching live profile metadata and full measurements. No cached or synthetic fallback is used.</p></div>}
          {selectedHistory && <>
            <div className="forecast-reasons">
              <strong>Source: {floatAnalysis.source} · retrieved {new Date(floatAnalysis.requestedAt).toLocaleString()}</strong>
              <p>Float {floatAnalysis.floatId}: {floatAnalysis.metadataProfilesAvailable} distinct profile records listed by Argovis; fetched {selectedHistory.distinctProfilesRetrieved} full profiles (up to {floatAnalysis.fullProfileLimit} most recent). Older profiles not fetched: {floatAnalysis.olderMetadataProfilesNotFetched}; failed full-profile requests: {floatAnalysis.profileFetchFailures}; duplicate profiles removed: {selectedHistory.duplicateProfilesRemoved}; duplicate pressure levels removed: {selectedHistory.duplicateLevelsRemoved}.</p>
              <p>Profile timestamp range: {selectedHistory.firstProfileTimestamp ? new Date(selectedHistory.firstProfileTimestamp).toLocaleString() : 'N/A'} to {selectedHistory.latestObservationTimestamp ? new Date(selectedHistory.latestObservationTimestamp).toLocaleString() : 'N/A'}. Median sampling gap: {selectedHistory.profileIntervalDays?.median ?? 'N/A'} days. Depth coverage: {selectedHistory.depthRangeMeters ? selectedHistory.depthRangeMeters.min + '–' + selectedHistory.depthRangeMeters.max + ' m' : 'N/A'}.</p>
              <p>Quality control: accepted flags {selectedHistory.qualityControl.acceptedFlags.join(', ')}; bad, missing and estimated flag 8 values are excluded where a QC array exists. Values from profiles with no QC array remain visible as source data but are identified as not QC-screened.</p>
              <p>Trend estimates are descriptive: the float moves between coordinates and may sample different water masses or seasons. They do not establish a local climate trend or marine heatwave.</p>
              <p>Latest vertical profile: temperature gradient {selectedHistory.latestVerticalStructure?.temperatureCPer100m ?? 'N/A'} °C/100 m; salinity gradient {selectedHistory.latestVerticalStructure?.salinityPsuPer100m ?? 'N/A'} PSU/100 m; maximum absolute temperature-gradient stratification proxy {selectedHistory.latestVerticalStructure?.temperatureStratificationProxy ?? 'N/A'} °C/100 m. This is a vertical structure indicator, not a density-derived stability calculation.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0' }}>
              <label htmlFor="analysis-depth-band">Comparable depth band</label>
              <select id="analysis-depth-band" className="input-field" value={selectedDepthBand} onChange={event => setSelectedDepthBand(event.target.value)}>
                {selectedHistory.bands.map(band => <option key={band.depthBand.minMeters} value={String(band.depthBand.minMeters)}>{band.depthBand.minMeters}–{band.depthBand.maxMeters} m</option>)}
              </select>
            </div>
            {currentBand?.fields?.length ? <div className="predictions-cards-grid">
              {currentBand.fields.map(field => <div className="forecast-card glow-card" key={field.variable}>
                <div className="forecast-card-header"><div><h4>{field.label} · {field.depthBand.minMeters}–{field.depthBand.maxMeters} m</h4><span>{field.distinctProfiles} valid profile timestamps · latest {field.latestTimestamp ? new Date(field.latestTimestamp).toLocaleDateString() : 'N/A'}</span></div><span className="badge badge-warning">{field.algorithm}</span></div>
                {field.history.length > 1 && <div style={{ width: '100%', height: 220, marginTop: '12px' }}><ResponsiveContainer><LineChart data={field.history} margin={{ top: 8, right: 12, left: 2, bottom: 18 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="timestamp" tickFormatter={value => new Date(value).toLocaleDateString()} minTickGap={28} /><YAxis width={52} /><Tooltip labelFormatter={value => new Date(value).toLocaleString()} formatter={value => [Number(value).toFixed(4) + ' ' + field.unit, field.label]} /><Line type="monotone" dataKey="value" name={field.label} stroke="var(--color-primary)" dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>}
                <p>{field.trend ? 'Observed trend: ' + field.trend.direction + ', slope ' + field.trend.slopePerDay + ' ' + field.unit + '/day; first-to-latest change ' + field.trend.changeFirstToLatest + ' ' + field.unit + '.' : 'Trend unavailable: at least 3 valid distinct profile timestamps are required.'}</p>
                <p>Latest historical screen: {field.latestValue ?? 'N/A'} {field.unit} · {field.latestHistoricalStatus}{field.historicalRange ? ' (prior 5th–95th percentile: ' + field.historicalRange.lower5th + ' to ' + field.historicalRange.upper95th + ' ' + field.unit + ', n=' + field.historicalRange.sampleCount + ')' : ''}. This is a statistical range screen, not an event probability.</p>
                <div className="forecast-reasons"><strong>Chronological holdout comparison</strong><ul>{[7, 30].map(horizon => <li key={horizon}>{horizon}-day: linear MAE/RMSE {field.validation[horizon].linear.mae === null ? 'N/A' : field.validation[horizon].linear.mae.toFixed(4) + ' / ' + field.validation[horizon].linear.rmse.toFixed(4) + ' ' + field.unit + ' (n=' + field.validation[horizon].linear.count + ')'}; AR(1) MAE/RMSE {field.validation[horizon].ar1.mae === null ? 'N/A' : field.validation[horizon].ar1.mae.toFixed(4) + ' / ' + field.validation[horizon].ar1.rmse.toFixed(4) + ' ' + field.unit + ' (n=' + field.validation[horizon].ar1.count + ')'}; persistence MAE/RMSE {field.validation[horizon].persistence.mae === null ? 'N/A' : field.validation[horizon].persistence.mae.toFixed(4) + ' / ' + field.validation[horizon].persistence.rmse.toFixed(4) + ' ' + field.unit + ' (n=' + field.validation[horizon].persistence.count + ')'}</li>)}</ul></div>
                <div className="forecast-metrics-list">{field.forecasts.map(forecast => <div key={forecast.horizonDays}><span>+{forecast.horizonDays} days:</span><strong>{forecast.supported ? forecast.value + ' ' + field.unit + ' · ' + forecast.algorithm : 'Forecast not supported'}</strong><span>{forecast.supported && forecast.uncertainty ? 'Approx. holdout RMSE interval: ' + forecast.uncertainty.lower + ' to ' + forecast.uncertainty.upper + ' ' + field.unit : forecast.reason}</span><span>Persistence baseline: {forecast.persistenceBaseline === null ? 'N/A' : forecast.persistenceBaseline + ' ' + field.unit}</span></div>)}</div>
              </div>)}
            </div> : <div className="empty-state"><AlertTriangle size={28} /><p>No QC-accepted measurements are available for this depth band.</p></div>}
            <details className="forecast-reasons"><summary>Recent Argovis profile identifiers and timestamps</summary><ul>{selectedHistory.profiles.slice(-12).reverse().map(profile => <li key={profile.profileId}>{profile.profileId} · cycle {profile.cycleNumber ?? 'N/A'} · observation {new Date(profile.timestamp).toLocaleString()} · Argovis updated {profile.argovisUpdatedAt ? new Date(profile.argovisUpdatedAt).toLocaleString() : 'N/A'} · location {profile.coordinates ? profile.coordinates[1] + '° lat, ' + profile.coordinates[0] + '° lon' : 'N/A'} · {profile.levels} unique levels · variables: {profile.variables.join(', ') || 'N/A'} · sources: {profile.source.join(', ') || 'N/A'} · QC arrays: {profile.qualityFlagsAvailable.join(', ') || 'unavailable'}</li>)}</ul></details>
          </>}
        </div>
      )}

      {/* TAB 4: ALGORITHM & MATHEMATICAL FORMULAS */}
      {activeTab === 'formulas' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Mathematical Foundations & Disaster Physics</h3>
              <p>Formal equations governing FloatChat AI's ML Anomaly, Tsunami & Flood Engine</p>
            </div>
          </div>

          <div className="math-formulas-grid">
            <div className="formula-box">
              <div className="formula-title">1. Shallow Water Tsunami Wave Velocity Formula</div>
              <div className="formula-equation">
                {"v = sqrt( g * h )   ==>   v_km/h = sqrt( 9.81 * h ) * 3.6"}
              </div>
              <p className="formula-desc">
                The physics formula is valid when seafloor depth is known, but the app's ARGO profile depth is a sampled water-column level, not bathymetry. This engine does not calculate tsunami speed or coastal ETA.
              </p>
            </div>

            <div className="formula-box">
              <div className="formula-title">2. Hydrostatic Bottom Pressure Differential (Tsunami Triggering)</div>
              <div className="formula-equation">
                {"ΔP = ρ * g * Δh"}
              </div>
              <p className="formula-desc">
                This relation requires seafloor bottom-pressure time series. ARGO profile pressure is measured at changing depths and cannot be used here as a tsunami trigger.
              </p>
            </div>

            <div className="formula-box">
              <div className="formula-title">3. Robust depth-aware anomaly screen</div>
              <div className="formula-equation">
                {"z = (x - median) / (1.4826 × MAD)"}
              </div>
              <p className="formula-desc">
                Uses a float-specific 100 m depth band when it has at least 8 values, otherwise a same-depth regional band when it has at least 12. Insufficient baselines produce no score. The screening threshold has not been independently validated.
              </p>
            </div>

            <div className="formula-box">
              <div className="formula-title">4. Combined screening score</div>
              <div className="formula-equation">
                {"D = sqrt( sum_k z_k^2 ); flag if any |z_k| >= 3.5"}
              </div>
              <p className="formula-desc">
                Combines available feature deviations for ranking only; the decision threshold is per-feature robust z. No covariance matrix, Isolation Forest, calibrated probability, or independent performance estimate is implemented.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: ACCURACY TEXT REPORT VIEW */}
      {activeTab === 'report' && (
        <div className="panel-card">
          <div className="panel-header">
            <div>
              <h3>Generated Technical Accuracy Report</h3>
              <p>Exported automatically to <code>backend/data/ML_ANOMALY_ALGORITHM_ACCURACY_REPORT.txt</code></p>
            </div>
            <button className="btn-primary" onClick={handleDownloadReport}>
              <Download size={16} />
              <span>Download Text File</span>
            </button>
          </div>

          <div className="code-viewer">
            <pre>{reportText || 'Loading report content...'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default MLAnomalyCenter;
