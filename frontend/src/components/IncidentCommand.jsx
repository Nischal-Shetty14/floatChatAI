import React, { useState, useEffect } from 'react';
import { ShieldAlert, Play, Square, AlertTriangle, CheckCircle2, Send, Activity, Flame, Droplets, Zap, Clock, ListChecks, Radio } from 'lucide-react';
import { authHeaders } from '../utils/authClient';

function IncidentCommand({ telemetryData, onRefreshTelemetry }) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [latestTick, setLatestTick] = useState(null);
  const [incidents, setIncidents] = useState([
    {
      id: 'INC-2026-TSUNAMI-01',
      title: 'Tsunami Early Warning: Submarine Pressure Surge',
      buoyId: 'FC-ATL-02',
      buoyName: 'Atlantic Trench-Link',
      severity: 'CRITICAL',
      status: 'OPEN',
      timestamp: new Date().toISOString(),
      detectedValue: '+145 dbar Abyssal Hydrostatic Pressure Delta',
      threshold: 'Pressure Δ > 3.0 σ',
      mlRiskScore: 96,
      remediationSteps: [
        'Automated Twilio Tsunami Emergency SMS Alert dispatched to Coastal Disaster Management Authority.',
        'Issue immediate Coastal Evacuation Sirens for Sector 4 (Estimated Wave Arrival: 35 mins).',
        'Trigger Deep-Sea Bottom Pressure Recorder high-frequency sampling (1 Hz).'
      ]
    },
    {
      id: 'INC-2026-0891',
      title: 'Deep-Sea Hypoxia Critical Event',
      buoyId: 'FC-PAC-01',
      buoyName: 'Pacific Deep-Shift',
      severity: 'CRITICAL',
      status: 'OPEN',
      timestamp: new Date(Date.now() - 1800000).toISOString(),
      detectedValue: '2.4 mg/L Dissolved O2',
      threshold: '< 2.8 mg/L',
      mlRiskScore: 84,
      remediationSteps: [
        'Dispatch automated SMS notification to Pacific Marine Station chief.',
        'Trigger Autonomous Underwater Vehicle (AUV-4) for localized CTD profiling.',
        'Recalibrate optical oxygen fluorescence transducer baseline.'
      ]
    },
    {
      id: 'INC-2026-0892',
      title: 'Polar Beacon Solar Power Degradation',
      buoyId: 'FC-ARC-04',
      buoyName: 'Arctic Drift-Beacon',
      severity: 'WARNING',
      status: 'INVESTIGATING',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      detectedValue: '14.5% Battery Level',
      threshold: '< 20.0%',
      mlRiskScore: 68,
      remediationSteps: [
        'Switch internal microcontroller to ultra-low power telemetry ping profile (12h -> 24h).',
        'Schedule icebreaker support vessel battery exchange during Q3 arctic patrol.',
        'Verify solar charging sub-array cell output.'
      ]
    }
  ]);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [feedback, setFeedback] = useState(null);

  // Streaming Live Feed Loop
  useEffect(() => {
    let interval = null;
    if (isStreaming) {
      interval = setInterval(async () => {
        try {
          const res = await fetch('/api/stream/tick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              buoyId: 'FC-PAC-01',
              injectAnomaly: Math.random() < 0.2
            })
          });

          if (res.ok) {
            const data = await res.json();
            setLatestTick(data);
            if (onRefreshTelemetry) onRefreshTelemetry();

            if (data.disasterInfo && data.disasterInfo.tsunamiRiskPercentage > 70) {
              const newInc = {
                id: `INC-TSUNAMI-${Math.floor(1000 + Math.random() * 9000)}`,
                title: `TSUNAMI EMERGENCY WARNING: ${data.latestEvaluatedRecord.buoyName}`,
                buoyId: data.latestEvaluatedRecord.buoyId,
                buoyName: data.latestEvaluatedRecord.buoyName,
                severity: 'CRITICAL',
                status: 'OPEN',
                timestamp: new Date().toISOString(),
                detectedValue: `Abyssal Surge (${data.latestEvaluatedRecord.pressure} dbar). Speed: ${data.disasterInfo.waveVelocityKph} km/h`,
                threshold: 'Tsunami Risk > 70%',
                mlRiskScore: data.disasterInfo.tsunamiRiskPercentage,
                remediationSteps: [
                  'Automated Twilio Tsunami Emergency SMS Alert dispatched.',
                  `Coastal ETA: ${data.disasterInfo.coastalEtaMinutes} minutes. Activate Harbor Tide Gates.`,
                  'Notify National Tsunami Warning Center (NTWC).'
                ]
              };
              setIncidents(prev => [newInc, ...prev]);
            }
          }
        } catch (err) {
          console.error('Error during streaming tick:', err);
        }
      }, 3000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isStreaming, onRefreshTelemetry]);

  // Synthetic Event Triggers
  const handleInjectTsunami = async () => {
    try {
      const res = await fetch('/api/stream/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buoyId: 'FC-ATL-02',
          injectTsunami: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        setLatestTick(data);
        if (onRefreshTelemetry) onRefreshTelemetry();

        const tsunInc = {
          id: `INC-TSUNAMI-${Math.floor(1000 + Math.random() * 9000)}`,
          title: `TSUNAMI EMERGENCY WARNING: ${data.newRecord.buoyName}`,
          buoyId: data.newRecord.buoyId,
          buoyName: data.newRecord.buoyName,
          severity: 'CRITICAL',
          status: 'OPEN',
          timestamp: new Date().toISOString(),
          detectedValue: `Abyssal Hydrostatic Surge (+145 dbar). Wave Speed: ${data.disasterInfo?.waveVelocityKph || 560} km/h`,
          threshold: 'Tsunami Pressure Delta > 3.5 σ',
          mlRiskScore: 98,
          remediationSteps: [
            'Twilio Emergency Tsunami SMS Alert dispatched to coastal defense.',
            `Predicted Coastal Wave Impact: ${data.disasterInfo?.coastalEtaMinutes || 38} minutes.`,
            'Execute immediate coastal evacuation protocol.'
          ]
        };
        setIncidents(prev => [tsunInc, ...prev]);

        setFeedback({ type: 'success', text: '🌊 SYNTHETIC TSUNAMI WAVE EVENT INJECTED! Hydrostatic pressure surge detected. Wave speed & coastal ETA calculated.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleInjectFlood = async () => {
    try {
      const res = await fetch('/api/stream/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buoyId: 'FC-IND-03',
          injectFlood: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        setLatestTick(data);
        if (onRefreshTelemetry) onRefreshTelemetry();

        const floodInc = {
          id: `INC-FLOOD-${Math.floor(1000 + Math.random() * 9000)}`,
          title: `COASTAL FLOOD & STORM SURGE EMERGENCY: ${data.newRecord.buoyName}`,
          buoyId: data.newRecord.buoyId,
          buoyName: data.newRecord.buoyName,
          severity: 'CRITICAL',
          status: 'OPEN',
          timestamp: new Date().toISOString(),
          detectedValue: `Shallow Sea Level Swell (+48 dbar surge)`,
          threshold: 'Flood Hazard > 80%',
          mlRiskScore: 88,
          remediationSteps: [
            'Twilio Coastal Flood Emergency SMS Alert dispatched.',
            'Deploy automated flood barrier shields in low-lying harbors.',
            'Issue flash flood warning for coastal residential sectors.'
          ]
        };
        setIncidents(prev => [floodInc, ...prev]);

        setFeedback({ type: 'success', text: '🌧️ SYNTHETIC COASTAL FLOOD SURGE INJECTED! Storm surge elevation & flood hazard index evaluated.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleInjectAnomaly = async () => {
    try {
      const res = await fetch('/api/stream/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buoyId: 'FC-PAC-01',
          injectAnomaly: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        setLatestTick(data);
        if (onRefreshTelemetry) onRefreshTelemetry();
        setFeedback({ type: 'success', text: 'Synthetic Anomaly Packet injected into live stream! ML engine flagged high risk and triggered alert.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateStatus = (id, newStatus) => {
    setIncidents(incidents.map(inc => inc.id === id ? { ...inc, status: newStatus } : inc));
  };

  const handleDispatchSMSForIncident = async (inc) => {
    try {
      const msg = `EMERGENCY DISASTER ALERT ${inc.id} [${inc.buoyName}]: ${inc.title} - ${inc.detectedValue}. Risk Score: ${inc.mlRiskScore}%. Immediate action required!`;
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: msg,
          buoyName: inc.buoyName,
          severity: inc.severity,
          liveOnly: true
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'success', text: `SMS Emergency Alert dispatched to technicians! (ID: ${data.sid})` });
      } else {
        setFeedback({ type: 'error', text: `SMS Alert Notice: ${data.error || 'Check Twilio setup'}` });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: 'Failed to dispatch SMS' });
    }
  };

  const filteredIncidents = incidents.filter(inc => {
    if (filterStatus === 'ALL') return true;
    return inc.status === filterStatus;
  });

  return (
    <div className="tab-container">
      {/* Header */}
      <div className="section-header glow-box">
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div className="icon-badge" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>
            <Activity size={28} />
          </div>
          <div>
            <h1 className="gradient-title" style={{ fontSize: '24px', margin: 0 }}>
              Ocean Telemetry & Disaster Incident Response Command
            </h1>
            <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0 0', fontSize: '14px' }}>
              Real-World Automated Tsunami & Flood Mitigation, Live Stream Simulator, & Technician Escalations
            </p>
          </div>
        </div>

        {/* Live Stream Controller & Disaster Injections */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button 
            className={`btn-primary ${isStreaming ? 'btn-danger-active' : ''}`}
            onClick={() => setIsStreaming(!isStreaming)}
          >
            {isStreaming ? <Square size={16} /> : <Play size={16} />}
            <span>{isStreaming ? 'Stop Live Feed' : 'Start Live Telemetry Feed'}</span>
          </button>

          <button className="btn-secondary" style={{ borderColor: 'rgba(239, 68, 68, 0.4)', color: '#f87171' }} onClick={handleInjectTsunami}>
            <Radio size={14} color="#f87171" />
            <span>Inject Tsunami Surge</span>
          </button>

          <button className="btn-secondary" style={{ borderColor: 'rgba(59, 130, 246, 0.4)', color: '#60a5fa' }} onClick={handleInjectFlood}>
            <Droplets size={14} color="#60a5fa" />
            <span>Inject Coastal Flood Surge</span>
          </button>

          <button className="btn-secondary" onClick={handleInjectAnomaly}>
            <Zap size={14} color="var(--color-warning)" />
            <span>Inject Anomaly</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className={`alert-banner ${feedback.type === 'success' ? 'banner-success' : 'banner-error'}`}>
          {feedback.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{feedback.text}</span>
          <button onClick={() => setFeedback(null)} className="close-btn">×</button>
        </div>
      )}

      {/* Live Stream Ticker Bar */}
      {isStreaming && (
        <div className="live-stream-ticker glow-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Radio size={20} color="var(--color-danger)" style={{ animation: 'pulse-beacon 1s infinite' }} />
            <strong>LIVE DISASTER MONITORING ACTIVE</strong>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>(Polling bottom pressure transducers every 3s)</span>
          </div>

          {latestTick?.newRecord && (
            <div className="tick-data-pill">
              <span>Station: <strong>{latestTick.newRecord.buoyName}</strong></span>
              <span>Pressure: <strong>{latestTick.newRecord.pressure} dbar</strong></span>
              <span>O2: <strong>{latestTick.newRecord.oxygenContent} mg/L</strong></span>
              <span>Temp: <strong>{latestTick.newRecord.temperature}°C</strong></span>
              <span className={`badge badge-${latestTick.latestEvaluatedRecord?.severity?.toLowerCase() || 'normal'}`}>
                ML Risk: {latestTick.latestEvaluatedRecord?.riskPercentage}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Filter Bar & Stats */}
      <div className="incidents-control-bar">
        <div className="filter-buttons">
          <button 
            className={`filter-btn ${filterStatus === 'ALL' ? 'active' : ''}`}
            onClick={() => setFilterStatus('ALL')}
          >
            All Incidents ({incidents.length})
          </button>
          <button 
            className={`filter-btn ${filterStatus === 'OPEN' ? 'active' : ''}`}
            onClick={() => setFilterStatus('OPEN')}
          >
            Open ({incidents.filter(i => i.status === 'OPEN').length})
          </button>
          <button 
            className={`filter-btn ${filterStatus === 'INVESTIGATING' ? 'active' : ''}`}
            onClick={() => setFilterStatus('INVESTIGATING')}
          >
            Investigating ({incidents.filter(i => i.status === 'INVESTIGATING').length})
          </button>
          <button 
            className={`filter-btn ${filterStatus === 'RESOLVED' ? 'active' : ''}`}
            onClick={() => setFilterStatus('RESOLVED')}
          >
            Resolved ({incidents.filter(i => i.status === 'RESOLVED').length})
          </button>
        </div>
      </div>

      {/* Incidents List */}
      <div className="incidents-list">
        {filteredIncidents.length === 0 ? (
          <div className="panel-card empty-state">
            <CheckCircle2 size={42} color="var(--color-success)" />
            <p>No incidents match the selected filter status.</p>
          </div>
        ) : (
          filteredIncidents.map((inc) => (
            <div key={inc.id} className={`incident-card ${inc.severity === 'CRITICAL' ? 'border-critical' : 'border-warning'}`}>
              <div className="incident-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className={`badge badge-${inc.severity.toLowerCase()}`}>{inc.severity}</span>
                  <span className="incident-id">{inc.id}</span>
                  <h3 style={{ margin: 0, fontSize: '18px' }}>{inc.title}</h3>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <select 
                    className="form-select status-select"
                    value={inc.status}
                    onChange={(e) => handleUpdateStatus(inc.id, e.target.value)}
                  >
                    <option value="OPEN">🔴 OPEN</option>
                    <option value="INVESTIGATING">🟡 INVESTIGATING</option>
                    <option value="RESOLVED">🟢 RESOLVED</option>
                  </select>

                  <button 
                    className="btn-primary btn-sm"
                    onClick={() => handleDispatchSMSForIncident(inc)}
                  >
                    <Send size={14} />
                    <span>Alert Disaster Response Team</span>
                  </button>
                </div>
              </div>

              <div className="incident-details-grid">
                <div>
                  <span className="detail-lbl">Target Sensor Buoy:</span>
                  <strong>{inc.buoyName} ({inc.buoyId})</strong>
                </div>

                <div>
                  <span className="detail-lbl">Telemetry Metric Exception:</span>
                  <strong className="text-danger">{inc.detectedValue}</strong>
                </div>

                <div>
                  <span className="detail-lbl">Disaster ML Risk Score:</span>
                  <span className="risk-pill">{inc.mlRiskScore}% Risk</span>
                </div>

                <div>
                  <span className="detail-lbl">Logged Timestamp:</span>
                  <span>{new Date(inc.timestamp).toLocaleString()}</span>
                </div>
              </div>

              {/* Remediation Action Protocol */}
              <div className="remediation-box">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: 'var(--color-primary)', fontWeight: '600', fontSize: '13px' }}>
                  <ListChecks size={16} />
                  <span>RECOMMENDED EMERGENCY DISASTER MITIGATION PROTOCOL</span>
                </div>
                <ul>
                  {inc.remediationSteps.map((step, sIdx) => (
                    <li key={sIdx}>{step}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default IncidentCommand;
