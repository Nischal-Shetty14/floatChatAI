import React, { useState, useEffect, useMemo, useCallback } from 'react';
import TelemetryCharts from './TelemetryCharts';
import BuoyMap from './BuoyMap';
import {
  Thermometer, Droplets, Waves, Compass, Activity,
  AlertTriangle, ShieldAlert, RefreshCw, Radio,
  Database, Globe, Clock, Layers, Filter, CheckCircle2
} from 'lucide-react';

export default function Dashboard({ telemetryData = [], selectedBuoy, setSelectedBuoy }) {
  // Argovis Integration States
  const [argoStatus, setArgoStatus] = useState(null);
  const [argoOverview, setArgoOverview] = useState(null);
  const [argoFloats, setArgoFloats] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [activeVerticalProfile, setActiveVerticalProfile] = useState(null);
  const [isLoadingArgo, setIsLoadingArgo] = useState(false);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [argoError, setArgoError] = useState(null);
  const [filterType, setFilterType] = useState('ALL'); // 'ALL' | 'ARGO' | 'BUOYS'

  // Extra telemetry observations fetched dynamically for selected Argo profiles
  const [extraObservations, setExtraObservations] = useState([]);

  // 1. Fetch Argovis Status, Overview & Discovered Regional Floats
  const fetchArgoData = useCallback(async (forceRefresh = false) => {
    setIsLoadingArgo(true);
    setArgoError(null);
    try {
      const [statusRes, overviewRes, floatsRes] = await Promise.all([
        fetch('/api/argo/status'),
        fetch(`/api/argo/overview${forceRefresh ? '?refresh=true' : ''}`),
        fetch(`/api/argo/floats?limit=40${forceRefresh ? '&refresh=true' : ''}`)
      ]);

      if (statusRes.ok) {
        const sData = await statusRes.json();
        setArgoStatus(sData);
      }
      if (overviewRes.ok) {
        const oData = await overviewRes.json();
        if (oData.success && oData.data) {
          setArgoOverview(oData.data);
        }
      }
      if (floatsRes.ok) {
        const fData = await floatsRes.json();
        if (fData.uniqueFloats && Array.isArray(fData.uniqueFloats)) {
          setArgoFloats(fData.uniqueFloats);
        }
      }
    } catch (err) {
      console.warn('Argovis fetch error:', err.message);
      setArgoError('Using local fallback dataset while connecting to Argovis.');
    } finally {
      setIsLoadingArgo(false);
    }
  }, []);

  useEffect(() => {
    fetchArgoData();
  }, [fetchArgoData]);

  // 2. Fetch Vertical Profile when an Argo Float is selected
  const fetchSelectedProfile = useCallback(async (profileId) => {
    if (!profileId) {
      setActiveVerticalProfile(null);
      return;
    }
    setIsLoadingProfile(true);
    try {
      // data=all retrieves all sensors (core CTD + BGC doxy / ph_in_situ_total) present on this profile
      const res = await fetch(`/api/argo/profile/${encodeURIComponent(profileId)}?data=all`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (data.verticalProfile) {
            setActiveVerticalProfile(data.verticalProfile);
          }
          if (Array.isArray(data.observations) && data.observations.length > 0) {
            setExtraObservations(prev => {
              const map = new Map();
              prev.forEach(item => map.set(`${item.buoyId}_${item.timestamp}_${item.depth}`, item));
              data.observations.forEach(item => map.set(`${item.buoyId}_${item.timestamp}_${item.depth}`, item));
              return Array.from(map.values());
            });
          }
        }
      }
    } catch (err) {
      console.warn('Error fetching vertical profile:', err);
    } finally {
      setIsLoadingProfile(false);
    }
  }, []);

  // 3. Build combined stations list (Local baseline buoys + Real Argovis Floats)
  const allStations = useMemo(() => {
    const list = [];
    const seen = new Set();

    // Add real Argovis Floats
    argoFloats.forEach(f => {
      const id = `ARGO-${f.floatId}`;
      seen.add(id);
      list.push({
        id,
        floatId: f.floatId,
        name: f.floatName,
        lat: f.latestLatitude,
        lng: f.latestLongitude,
        isArgo: true,
        latestCycle: f.latestCycle,
        cycleCount: f.cycleCount,
        cycles: f.cycles || [],
        latestProfileId: f.latestProfileId,
        timestamp: f.latestTimestamp,
        availableVariables: f.availableVariables || []
      });
    });

    // Add Local Sentinel Baseline Buoys
    telemetryData.forEach(item => {
      if (!seen.has(item.buoyId)) {
        seen.add(item.buoyId);
        list.push({
          id: item.buoyId,
          floatId: item.buoyId,
          name: item.buoyName,
          lat: item.latitude,
          lng: item.longitude,
          isArgo: false,
          latestCycle: 1,
          cycleCount: 1,
          cycles: [],
          timestamp: item.timestamp,
          availableVariables: ['pressure', 'temperature', 'salinity', 'oxygenContent', 'ph']
        });
      }
    });

    return list;
  }, [argoFloats, telemetryData]);

  // Filtered stations based on tab filter
  const displayedStations = useMemo(() => {
    if (filterType === 'ARGO') return allStations.filter(s => s.isArgo);
    if (filterType === 'BUOYS') return allStations.filter(s => !s.isArgo);
    return allStations;
  }, [allStations, filterType]);

  // Identify currently selected float details
  const activeStation = useMemo(() => {
    if (!selectedBuoy || selectedBuoy === 'ALL') return null;
    return allStations.find(s => s.id === selectedBuoy || s.floatId === selectedBuoy || `ARGO-${s.floatId}` === selectedBuoy) || null;
  }, [allStations, selectedBuoy]);

  // Auto-fetch profile when active station changes to an Argo float
  // Clears previous profile immediately so stale measurements from an old float are never displayed
  useEffect(() => {
    if (activeStation && activeStation.isArgo) {
      setActiveVerticalProfile(null);
      const profId = selectedCycleId || activeStation.latestProfileId;
      fetchSelectedProfile(profId);
    } else {
      setActiveVerticalProfile(null);
    }
  }, [activeStation?.id, selectedCycleId, fetchSelectedProfile]);

  // Reset selected cycle when station changes
  useEffect(() => {
    if (activeStation) {
      setSelectedCycleId(activeStation.latestProfileId || '');
    }
  }, [activeStation?.id]);

  // Combined telemetry records (baseline stored + dynamically retrieved profile levels)
  const allTelemetryObservations = useMemo(() => {
    const combined = [...telemetryData, ...extraObservations];
    const seen = new Set();
    return combined.filter(d => {
      const key = `${d.buoyId}_${d.timestamp}_${d.depth}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [telemetryData, extraObservations]);

  // Filter telemetry observations for timeseries charts
  const filteredTelemetry = useMemo(() => {
    if (!selectedBuoy || selectedBuoy === 'ALL') return allTelemetryObservations;
    const targetBuoyId = activeStation?.id || selectedBuoy;
    const targetFloatId = activeStation?.floatId;
    return allTelemetryObservations.filter(d => 
      d.buoyId === targetBuoyId || 
      d.buoyId === `ARGO-${targetFloatId}` ||
      d.buoyId === targetFloatId ||
      d.buoyId?.includes(targetFloatId)
    );
  }, [allTelemetryObservations, selectedBuoy, activeStation]);

  // Compute aggregate KPI statistics
  const stats = useMemo(() => {
    // If vertical profile is active, compute from vertical profile
    if (activeVerticalProfile && activeVerticalProfile.temperature?.length > 0) {
      const temps = activeVerticalProfile.temperature.filter(t => t !== null && !isNaN(t));
      const psals = activeVerticalProfile.salinity.filter(s => s !== null && !isNaN(s));
      const oxygens = (activeVerticalProfile.oxygen || []).filter(o => o !== null && !isNaN(o));
      const avgT = temps.length > 0 ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(2) : 'N/A';
      const avgS = psals.length > 0 ? (psals.reduce((a, b) => a + b, 0) / psals.length).toFixed(2) : 'N/A';
      const avgO = oxygens.length > 0 ? (oxygens.reduce((a, b) => a + b, 0) / oxygens.length).toFixed(2) : 'N/A';
      const maxD = activeVerticalProfile.depth ? Math.max(...activeVerticalProfile.depth.filter(Boolean)).toFixed(0) : '0';
      const maxP = activeVerticalProfile.pressure ? Math.max(...activeVerticalProfile.pressure.filter(Boolean)).toFixed(0) : '0';

      return {
        temp: avgT,
        surfaceTemp: activeVerticalProfile.temperature[0] !== null ? Number(activeVerticalProfile.temperature[0]).toFixed(2) : avgT,
        salinity: avgS,
        oxygen: avgO,
        pressure: maxP,
        ph: activeVerticalProfile.ph?.[0] ? Number(activeVerticalProfile.ph[0]).toFixed(2) : 'N/A',
        depth: maxD,
        levelsCount: activeVerticalProfile.levelsCount || 0
      };
    }

    if (filteredTelemetry.length === 0) {
      return { temp: '0.00', surfaceTemp: '0.00', salinity: '0.00', oxygen: '0.00', pressure: '0', ph: '0.00', depth: '0', levelsCount: 0 };
    }

    let tempSum = 0, salinitySum = 0, oxygenSum = 0, pressureSum = 0, phSum = 0, depthSum = 0;
    filteredTelemetry.forEach(d => {
      tempSum += d.temperature || 0;
      salinitySum += d.salinity || 0;
      oxygenSum += d.oxygenContent || 0;
      pressureSum += d.pressure || 0;
      phSum += d.ph || 0;
      depthSum += d.depth || 0;
    });

    const len = filteredTelemetry.length;
    return {
      temp: (tempSum / len).toFixed(2),
      surfaceTemp: (tempSum / len).toFixed(2),
      salinity: (salinitySum / len).toFixed(2),
      oxygen: (oxygenSum / len).toFixed(2),
      pressure: (pressureSum / len).toFixed(0),
      ph: (phSum / len).toFixed(2),
      depth: (depthSum / len).toFixed(0),
      levelsCount: len
    };
  }, [activeVerticalProfile, filteredTelemetry]);

  // Alerts computation
  const alerts = useMemo(() => {
    const list = [];
    const recent = {};
    telemetryData.forEach(d => {
      if (!recent[d.buoyId] || new Date(d.timestamp) > new Date(recent[d.buoyId].timestamp)) {
        recent[d.buoyId] = d;
      }
    });

    Object.values(recent).forEach(d => {
      if (d.oxygenContent !== null && d.oxygenContent < 4.0) {
        list.push({
          id: `o2-${d.buoyId}`,
          buoyId: d.buoyId,
          buoyName: d.buoyName,
          type: 'danger',
          message: `Hypoxia Warning: Dissolved oxygen low (${d.oxygenContent} mg/L) at depth ${d.depth}m.`,
          timestamp: d.timestamp
        });
      }
      if (d.temperature !== null && d.temperature > 24.0 && d.depth > 50) {
        list.push({
          id: `temp-${d.buoyId}`,
          buoyId: d.buoyId,
          buoyName: d.buoyName,
          type: 'warning',
          message: `Thermal Anomaly: Subsurface temperature warm (${d.temperature}°C).`,
          timestamp: d.timestamp
        });
      }
      if (d.ph !== null && (d.ph < 7.8 || d.ph > 8.5)) {
        list.push({
          id: `ph-${d.buoyId}`,
          buoyId: d.buoyId,
          buoyName: d.buoyName,
          type: 'warning',
          message: `Acidification Alert: Abnormal ocean pH level (${d.ph}).`,
          timestamp: d.timestamp
        });
      }
    });

    return list;
  }, [telemetryData]);

  const isLive = argoStatus?.isAvailable === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      
      {/* ─── Top Ocean Monitoring Banner & Argovis Connection Status ─── */}
      <div style={{
        background: '#FFFFFF',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        boxShadow: 'var(--shadow-sm)'
      }}>
        {/* Title & Description */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 className="page-title" style={{ margin: 0, fontSize: '18px' }}>
              Oceanographic Telemetry &amp; ARGO Float Network
            </h1>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Real-time research float discovery &amp; CTD vertical profile observations across the Indian Ocean Basin
          </span>
        </div>

        {/* Live Status Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Live Connection Pill */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 12px',
            borderRadius: '20px',
            background: isLive ? 'var(--color-success-bg)' : 'var(--color-warning-bg)',
            border: `1px solid ${isLive ? 'var(--color-success-border)' : 'var(--color-warning-border)'}`,
            fontSize: '11px',
            fontWeight: '700',
            color: isLive ? 'var(--color-success)' : 'var(--color-warning)'
          }}>
            <span style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: isLive ? 'var(--color-success)' : 'var(--color-warning)',
              display: 'inline-block',
              animation: isLive ? 'pulse-dot 2s infinite' : 'none'
            }} />
            <span>{isLive ? 'LIVE ARGOVIS API CONNECTION' : 'USING CACHED DATA / LOCAL BASELINE'}</span>
          </div>

          {/* Observation Freshness Pill */}
          {activeStation?.timestamp && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: '5px 11px',
              borderRadius: '20px',
              background: 'var(--bg-page)',
              border: '1px solid var(--border)',
              fontSize: '11px',
              color: 'var(--text-secondary)'
            }}>
              <Clock size={12} color="var(--color-primary)" />
              <span>Observed: <strong>{new Date(activeStation.timestamp).toUTCString().slice(5, 22)} UTC</strong></span>
            </div>
          )}

          {/* Sync Button */}
          <button
            onClick={() => fetchArgoData(true)}
            disabled={isLoadingArgo}
            className="btn-secondary"
            style={{ padding: '6px 12px', fontSize: '12px' }}
            title="Synchronize fresh Argovis observations"
          >
            <RefreshCw size={12} className={isLoadingArgo ? 'spinner' : ''} />
            <span>{isLoadingArgo ? 'Syncing...' : 'Sync Data'}</span>
          </button>
        </div>
      </div>

      {/* ─── Global Argovis Stats vs Regional Query Counts ─── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '12px'
      }}>
        {/* Global Dataset Box */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="section-label">Global Argovis Dataset</span>
            <Globe size={13} color="var(--color-primary)" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' }}>
            {argoOverview?.totalProfiles ? (argoOverview.totalProfiles / 1000000).toFixed(2) + 'M' : '3.91M'}
            <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)', marginLeft: '4px' }}>profiles</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Core: {argoOverview?.nCore?.toLocaleString() || '3.43M'} · BGC: {argoOverview?.nBGC?.toLocaleString() || '413K'}
          </div>
        </div>

        {/* Regional Floats Discovered */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="section-label">Regional Query Floats</span>
            <Compass size={13} color="var(--color-secondary)" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' }}>
            {argoFloats.length}
            <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)', marginLeft: '4px' }}>active floats</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Bounding Box: Indian Ocean [40°E–120°E]
          </div>
        </div>

        {/* Selected Platform Details */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="section-label">Selected Platform</span>
            <Radio size={13} color="var(--color-primary)" />
          </div>
          <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {activeStation?.name || 'All Stations Aggregated'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {activeStation?.isArgo ? `Latest Cycle: ${activeStation.latestCycle} (${activeStation.cycleCount} cycles)` : 'Fixed Coastal Sentinel'}
          </div>
        </div>

        {/* Available Measurement Variables */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="section-label">Sensors Equipped</span>
            <Activity size={13} color="var(--color-success)" />
          </div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', marginTop: '2px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {activeStation?.availableVariables?.length > 0
              ? (() => {
                  // Map Argovis internal names to readable labels
                  const labelMap = {
                    pressure: 'P', temperature: 'T', salinity: 'S',
                    doxy: 'O₂ (BGC)', ph_in_situ_total: 'pH (BGC)',
                    chla: 'Chl-a', nitrate: 'NO₃', bbp700: 'BBP',
                    oxygenContent: 'O₂', ph: 'pH'
                  };
                  const priorityVars = ['pressure', 'temperature', 'salinity', 'doxy', 'ph_in_situ_total', 'chla', 'nitrate'];
                  const vars = activeStation.availableVariables
                    .filter(v => !v.endsWith('_argoqc') && !v.endsWith('_sfile') && !v.endsWith('_adjusted') && !v.endsWith('_qc') && !v.endsWith('_fluorescence'))
                    .sort((a, b) => {
                      const ai = priorityVars.indexOf(a), bi = priorityVars.indexOf(b);
                      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                    });
                  return vars.map(v => (
                    <span key={v} style={{
                      fontSize: '10px', padding: '1px 6px', borderRadius: '10px',
                      background: (v === 'doxy' || v === 'ph_in_situ_total') ? 'rgba(0,180,100,0.12)' : 'var(--bg-page)',
                      color: (v === 'doxy' || v === 'ph_in_situ_total') ? 'var(--color-success)' : 'var(--text-secondary)',
                      border: '1px solid var(--border)', fontWeight: '600'
                    }}>
                      {labelMap[v] || v}
                    </span>
                  ));
                })()
              : <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Select a float to see sensors</span>}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {activeStation?.isArgo
              ? (activeVerticalProfile?.hasOxygen || activeVerticalProfile?.hasPh
                  ? '✓ BGC sensors confirmed on this profile'
                  : 'Core Argo float — CTD only (no BGC sensors)')
              : 'Fixed buoy — local sensors'}
          </div>
        </div>
      </div>

      {/* ─── Platform Filters & Station Selector Bar ─── */}
      <div style={{
        background: '#FFFFFF',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        boxShadow: 'var(--shadow-sm)'
      }}>
        {/* Left Filter Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginRight: '4px' }}>
            Category:
          </span>
          {[
            { key: 'ALL', label: `All Stations (${allStations.length})` },
            { key: 'ARGO', label: `Argo Research Floats (${argoFloats.length})` },
            { key: 'BUOYS', label: `Fixed Buoys (${telemetryData.length > 0 ? 4 : 0})` }
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilterType(key)}
              style={{
                padding: '5px 12px',
                fontSize: '12px',
                borderRadius: '20px',
                border: filterType === key ? 'none' : '1px solid var(--border)',
                background: filterType === key ? 'var(--color-primary)' : 'transparent',
                color: filterType === key ? '#FFFFFF' : 'var(--text-secondary)',
                fontWeight: filterType === key ? '600' : '500',
                cursor: 'pointer'
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Right Station & Cycle Selectors */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Station dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)' }}>Station:</span>
            <select
              className="input-field"
              value={selectedBuoy}
              onChange={e => setSelectedBuoy(e.target.value)}
              style={{ width: 'auto', minWidth: '220px', padding: '6px 10px', fontSize: '12.5px' }}
            >
              <option value="ALL">All Stations (Aggregated View)</option>
              {displayedStations.map(s => (
                <option key={s.id} value={s.id}>
                  {s.isArgo ? `🌊 Float ${s.floatId} (Cycle ${s.latestCycle})` : `⚓ ${s.name} (${s.id})`}
                </option>
              ))}
            </select>
          </div>

          {/* Historical Cycle selector (when Argo float is active) */}
          {activeStation && activeStation.isArgo && activeStation.cycles?.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)' }}>Cycle:</span>
              <select
                className="input-field"
                value={selectedCycleId}
                onChange={e => setSelectedCycleId(e.target.value)}
                style={{ width: 'auto', padding: '6px 10px', fontSize: '12.5px' }}
              >
                {activeStation.cycles.map(c => (
                  <option key={c.profileId} value={c.profileId}>
                    Cycle {c.cycle} ({new Date(c.timestamp).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* ─── Metric KPI Cards Grid ─── */}
      <div className="metrics-grid">
        <div className="metric-card temp">
          <div className="metric-header">
            <span>Water Temperature</span>
            <Thermometer size={16} color="#E07B3A" />
          </div>
          <div className="metric-value">
            {stats.surfaceTemp}<span className="metric-unit"> °C</span>
          </div>
          <div className="metric-trend">
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              {activeVerticalProfile ? `Surface reading (Avg: ${stats.temp}°C)` : 'Average temperature reading'}
            </span>
          </div>
        </div>

        <div className="metric-card salinity">
          <div className="metric-header">
            <span>Practical Salinity</span>
            <Droplets size={16} color="#7B61C4" />
          </div>
          <div className="metric-value">
            {stats.salinity}<span className="metric-unit"> PSU</span>
          </div>
          <div className="metric-trend">
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              Practical Salinity Unit (UNESCO scale)
            </span>
          </div>
        </div>

        <div className="metric-card oxygen">
          <div className="metric-header">
            <span>Dissolved Oxygen</span>
            <Waves size={16} color="var(--color-success)" />
          </div>
          <div className="metric-value">
            {stats.oxygen !== 'N/A' ? stats.oxygen : 'Null'}
            {stats.oxygen !== 'N/A' && <span className="metric-unit"> mg/L</span>}
          </div>
          <div className="metric-trend">
            {stats.oxygen === 'N/A' ? (
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Sensor not fitted on this float</span>
            ) : parseFloat(stats.oxygen) < 5.0 ? (
              <span className="trend-down" style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px' }}>
                <AlertTriangle size={11} /> Hypoxic condition
              </span>
            ) : (
              <span className="trend-up" style={{ fontSize: '11px' }}>Optimal oxygenation</span>
            )}
          </div>
        </div>

        <div className="metric-card pressure">
          <div className="metric-header">
            <span>Max Depth &amp; Pressure</span>
            <Compass size={16} color="var(--color-secondary)" />
          </div>
          <div className="metric-value" style={{ fontSize: '22px' }}>
            {stats.depth}<span className="metric-unit">m</span>
            <span style={{ margin: '0 6px', color: 'var(--text-muted)', fontSize: '16px' }}>·</span>
            {stats.pressure}<span className="metric-unit"> dbar</span>
          </div>
          <div className="metric-trend">
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              {stats.levelsCount > 0 ? `${stats.levelsCount} depth tiers sampled` : 'Hydrostatic equilibrium'}
            </span>
          </div>
        </div>
      </div>

      {/* ─── Ocean Visualizations & Map Section ─── */}
      <div className="dashboard-grid">
        {/* Left Side: CTD Vertical Profiles & Time-Series Charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <TelemetryCharts
            data={filteredTelemetry}
            selectedBuoy={selectedBuoy}
            verticalProfile={activeVerticalProfile}
          />
        </div>

        {/* Right Side: Map & Station Alerts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Beacon & Float Map */}
          <div className="glass-panel map-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h3 className="chart-title" style={{ margin: 0 }}>
                Ocean Research Station Map
              </h3>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {displayedStations.length} markers shown
              </span>
            </div>

            <BuoyMap
              buoys={displayedStations}
              selectedBuoy={selectedBuoy}
              onSelectBuoy={setSelectedBuoy}
              telemetryData={telemetryData}
              selectedFloatTrajectory={activeStation?.cycles || []}
            />
          </div>

          {/* Active Anomalies & Observations Panel */}
          <div className="glass-panel" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <ShieldAlert size={16} color="var(--color-danger)" />
              <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
                Oceanographic Anomalies &amp; Status
              </h3>
              {alerts.length > 0 && (
                <span className="alert-count-badge" style={{ marginLeft: 'auto' }}>{alerts.length}</span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
              {alerts.length === 0 ? (
                <div style={{
                  padding: '14px',
                  textAlign: 'center',
                  color: 'var(--color-success)',
                  fontSize: '12px',
                  background: 'var(--color-success-bg)',
                  border: '1px solid var(--color-success-border)',
                  borderRadius: 'var(--radius-md)'
                }}>
                  <CheckCircle2 size={15} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
                  All monitored stations reporting nominal oceanographic bounds
                </div>
              ) : (
                alerts.map(alert => (
                  <div
                    key={alert.id}
                    onClick={() => setSelectedBuoy(alert.buoyId)}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-md)',
                      background: alert.type === 'danger' ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)',
                      border: `1px solid ${alert.type === 'danger' ? 'var(--color-danger-border)' : 'var(--color-warning-border)'}`,
                      cursor: 'pointer'
                    }}
                  >
                    <AlertTriangle size={13} color={alert.type === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)'} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                      <strong style={{ fontSize: '11.5px', color: 'var(--text-primary)' }}>
                        {alert.buoyName} ({alert.buoyId})
                      </strong>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{alert.message}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
