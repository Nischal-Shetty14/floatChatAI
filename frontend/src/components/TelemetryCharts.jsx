import React, { useState, useMemo } from 'react';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ScatterChart, 
  Scatter,
  ZAxis
} from 'recharts';

export default function TelemetryCharts({ data, selectedBuoy, verticalProfile = null }) {
  const [activeChart, setActiveChart] = useState(verticalProfile ? 'vertical-temp' : 'timeseries');

  // Format date helper
  const formatDate = (tickItem) => {
    try {
      const d = new Date(tickItem);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
    } catch {
      return tickItem;
    }
  };

  // Tooltip for timeseries
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div style={{
          background: '#FFFFFF',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '10px 12px',
          boxShadow: 'var(--shadow-md)',
          fontSize: '12px',
          lineHeight: '1.6'
        }}>
          <p style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '5px', borderBottom: '1px solid var(--border)', paddingBottom: '4px' }}>
            {new Date(label).toLocaleString()}
          </p>
          {payload.map((p, idx) => (
            <p key={idx} style={{ color: p.color || p.stroke, margin: '2px 0' }}>
              <span style={{ textTransform: 'capitalize' }}>{p.name}</span>: <strong>{p.value}</strong> {p.unit || ''}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  // Tooltip for vertical profiles
  const VerticalTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      return (
        <div style={{
          background: '#FFFFFF',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '10px 12px',
          boxShadow: 'var(--shadow-md)',
          fontSize: '12px',
          lineHeight: '1.6'
        }}>
          <p style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>
            Depth: <strong>{d.depth !== null ? `${d.depth} m` : 'Surface'}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '6px' }}>({d.pressure} dbar)</span>
          </p>
          {d.temperature !== null && (
            <p style={{ color: '#E07B3A', margin: '2px 0' }}>
              Temperature: <strong>{d.temperature}°C</strong>
            </p>
          )}
          {d.salinity !== null && (
            <p style={{ color: '#7B61C4', margin: '2px 0' }}>
              Salinity: <strong>{d.salinity} PSU</strong>
            </p>
          )}
          {d.oxygen !== null && d.oxygen !== undefined && (
            <p style={{ color: 'var(--color-success)', margin: '2px 0' }}>
              Dissolved O₂: <strong>{d.oxygen} mg/L</strong>
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  // Clean and prepare chronological timeseries data
  const sortedData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    // When multiple depth tiers exist for the same timestamp (e.g. from an Argo profile),
    // pick the surface layer (shallowest depth) for the temporal timeseries
    const surfaceMap = new Map();
    const sorted = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    sorted.forEach(d => {
      const ts = d.timestamp;
      const key = `${d.buoyId || 'B'}_${ts}`;
      if (!surfaceMap.has(key)) {
        surfaceMap.set(key, d);
      } else {
        const existing = surfaceMap.get(key);
        if (d.depth !== null && (existing.depth === null || d.depth < existing.depth)) {
          surfaceMap.set(key, d);
        }
      }
    });
    return Array.from(surfaceMap.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }, [data]);

  // Downsample timeseries data points for smooth performance
  const processedData = useMemo(() => {
    if (sortedData.length <= 120) return sortedData;
    const step = Math.ceil(sortedData.length / 120);
    return sortedData.filter((_, idx) => idx % step === 0);
  }, [sortedData]);

  // Transform vertical profile data for Recharts layout="vertical"
  const verticalData = useMemo(() => {
    if (!verticalProfile || !Array.isArray(verticalProfile.depth) || verticalProfile.depth.length === 0) {
      return [];
    }
    const len = verticalProfile.depth.length;
    const step = Math.max(1, Math.floor(len / 120));
    const pts = [];

    for (let i = 0; i < len; i += step) {
      pts.push({
        depth: verticalProfile.depth[i],
        pressure: verticalProfile.pressure?.[i],
        temperature: verticalProfile.temperature?.[i],
        salinity: verticalProfile.salinity?.[i],
        // Use raw oxygen array from verticalProfile (already converted to mg/L)
        oxygen: verticalProfile.oxygen?.[i] ?? null,
        // ph_in_situ_total from BGC profiles
        ph: verticalProfile.ph?.[i] ?? null
      });
    }
    return pts;
  }, [verticalProfile]);

  const hasVertical = verticalData.length > 0;

  // Derived BGC availability flags from the vertical profile data
  const hasOxygenData = hasVertical && verticalData.some(pt => pt.oxygen !== null && pt.oxygen !== undefined);
  const hasPhData = hasVertical && verticalData.some(pt => pt.ph !== null && pt.ph !== undefined);

  // Check if timeseries has valid oxygen or pH
  const timeseriesHasOxygen = processedData.some(d => d.oxygenContent !== null && d.oxygenContent !== undefined);
  const timeseriesHasPh = processedData.some(d => d.ph !== null && d.ph !== undefined);

  // Auto-switch tab if verticalProfile changes
  React.useEffect(() => {
    if (hasVertical) {
      setActiveChart('vertical-temp');
    }
  }, [hasVertical]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      
      {/* Chart Toggles */}
      <div className="glass-panel" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)' }}>Analysis Mode:</span>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {hasVertical && (
            <>
              <button
                onClick={() => setActiveChart('vertical-temp')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  borderRadius: '20px',
                  border: activeChart === 'vertical-temp' ? 'none' : '1px solid var(--border)',
                  background: activeChart === 'vertical-temp' ? 'var(--color-primary)' : '#FFFFFF',
                  color: activeChart === 'vertical-temp' ? '#FFFFFF' : 'var(--text-secondary)',
                  fontWeight: activeChart === 'vertical-temp' ? '600' : '500',
                  cursor: 'pointer'
                }}
              >
                Temperature Profile (Depth)
              </button>
              <button
                onClick={() => setActiveChart('vertical-psal')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  borderRadius: '20px',
                  border: activeChart === 'vertical-psal' ? 'none' : '1px solid var(--border)',
                  background: activeChart === 'vertical-psal' ? 'var(--color-primary)' : '#FFFFFF',
                  color: activeChart === 'vertical-psal' ? '#FFFFFF' : 'var(--text-secondary)',
                  fontWeight: activeChart === 'vertical-psal' ? '600' : '500',
                  cursor: 'pointer'
                }}
              >
                Salinity Profile (Depth)
              </button>
              {/* BGC: Dissolved Oxygen vs Depth — only shown when data present */}
              {hasOxygenData && (
                <button
                  onClick={() => setActiveChart('vertical-doxy')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '12px',
                    borderRadius: '20px',
                    border: activeChart === 'vertical-doxy' ? 'none' : '1px solid var(--border)',
                    background: activeChart === 'vertical-doxy' ? 'var(--color-success)' : '#FFFFFF',
                    color: activeChart === 'vertical-doxy' ? '#FFFFFF' : 'var(--text-secondary)',
                    fontWeight: activeChart === 'vertical-doxy' ? '600' : '500',
                    cursor: 'pointer'
                  }}
                >
                  O₂ Profile (Depth)
                </button>
              )}
              {/* BGC: pH vs Depth — only shown when data present */}
              {hasPhData && (
                <button
                  onClick={() => setActiveChart('vertical-ph')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '12px',
                    borderRadius: '20px',
                    border: activeChart === 'vertical-ph' ? 'none' : '1px solid var(--border)',
                    background: activeChart === 'vertical-ph' ? 'var(--color-primary)' : '#FFFFFF',
                    color: activeChart === 'vertical-ph' ? '#FFFFFF' : 'var(--text-secondary)',
                    fontWeight: activeChart === 'vertical-ph' ? '600' : '500',
                    cursor: 'pointer'
                  }}
                >
                  pH Profile (Depth)
                </button>
              )}
            </>
          )}

          <button
            onClick={() => setActiveChart('timeseries')}
            style={{
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '20px',
              border: activeChart === 'timeseries' ? 'none' : '1px solid var(--border)',
              background: activeChart === 'timeseries' ? 'var(--color-primary)' : '#FFFFFF',
              color: activeChart === 'timeseries' ? '#FFFFFF' : 'var(--text-secondary)',
              fontWeight: activeChart === 'timeseries' ? '600' : '500',
              cursor: 'pointer'
            }}
          >
            Temporal Trends
          </button>

          <button
            onClick={() => setActiveChart('oxygen-ph')}
            style={{
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '20px',
              border: activeChart === 'oxygen-ph' ? 'none' : '1px solid var(--border)',
              background: activeChart === 'oxygen-ph' ? 'var(--color-primary)' : '#FFFFFF',
              color: activeChart === 'oxygen-ph' ? '#FFFFFF' : 'var(--text-secondary)',
              fontWeight: activeChart === 'oxygen-ph' ? '600' : '500',
              cursor: 'pointer'
            }}
          >
            Biogeochemical (O₂ / pH)
          </button>
        </div>
      </div>

      {/* Chart Viewport */}
      <div className="glass-panel chart-container" style={{ minHeight: '340px' }}>
        
        {/* Mode 1: Vertical Temperature Profile (CTD Style) */}
        {activeChart === 'vertical-temp' && hasVertical && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Vertical Temperature Profile
                  <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)' }}>
                    ({verticalProfile.levelsCount} depth levels sampled)
                  </span>
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Depth (meters, reversed Y-axis) vs In-Situ Temperature (°C) revealing the mixed layer and thermocline
                </p>
              </div>
            </div>

            <div style={{ width: '100%', height: '280px' }}>
              <ResponsiveContainer>
                <LineChart data={verticalData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                  <XAxis
                    type="number"
                    dataKey="temperature"
                    unit="°C"
                    domain={['dataMin - 0.5', 'dataMax + 0.5']}
                    stroke="var(--text-muted)"
                    fontSize={11}
                    label={{ value: 'Water Temperature (°C)', position: 'bottom', offset: 0, fill: '#E07B3A', fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="depth"
                    unit="m"
                    reversed={true}
                    stroke="var(--text-muted)"
                    fontSize={11}
                    label={{ value: 'Depth (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                  />
                  <Tooltip content={<VerticalTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="temperature"
                    name="Temperature"
                    stroke="#E07B3A"
                    strokeWidth={2.2}
                    dot={false}
                    activeDot={{ r: 5, stroke: 'var(--color-primary)', strokeWidth: 1 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}

        {/* Mode 2: Vertical Salinity Profile (CTD Style) */}
        {activeChart === 'vertical-psal' && hasVertical && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Vertical Salinity Profile
                  <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)' }}>
                    ({verticalProfile.levelsCount} depth levels)
                  </span>
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Depth (meters, reversed Y-axis) vs Practical Salinity (PSU) revealing the halocline
                </p>
              </div>
            </div>

            <div style={{ width: '100%', height: '280px' }}>
              <ResponsiveContainer>
                <LineChart data={verticalData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                  <XAxis
                    type="number"
                    dataKey="salinity"
                    unit=" PSU"
                    domain={['dataMin - 0.2', 'dataMax + 0.2']}
                    stroke="var(--text-muted)"
                    fontSize={11}
                    label={{ value: 'Salinity (PSU)', position: 'bottom', offset: 0, fill: '#7B61C4', fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="depth"
                    unit="m"
                    reversed={true}
                    stroke="var(--text-muted)"
                    fontSize={11}
                    label={{ value: 'Depth (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                  />
                  <Tooltip content={<VerticalTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="salinity"
                    name="Salinity"
                    stroke="#7B61C4"
                    strokeWidth={2.2}
                    dot={false}
                    activeDot={{ r: 5, stroke: 'var(--color-primary)', strokeWidth: 1 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}

        {/* Mode 2b: Dissolved Oxygen vs Depth (BGC) */}
        {activeChart === 'vertical-doxy' && hasVertical && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Dissolved Oxygen Profile
                  <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)' }}>
                    (BGC float — {verticalProfile.levelsCount} levels)
                  </span>
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Depth (m, reversed) vs Dissolved O₂ (mg/L, converted from micromole/kg) · Argovis BGC variable: <code>doxy</code>
                </p>
              </div>
            </div>
            {hasOxygenData ? (
              <div style={{ width: '100%', height: '280px' }}>
                <ResponsiveContainer>
                  <LineChart data={verticalData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                    <XAxis
                      type="number"
                      dataKey="oxygen"
                      unit=" mg/L"
                      domain={['dataMin - 0.2', 'dataMax + 0.2']}
                      stroke="var(--text-muted)"
                      fontSize={11}
                      label={{ value: 'Dissolved O₂ (mg/L)', position: 'bottom', offset: 0, fill: 'var(--color-success)', fontSize: 11 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="depth"
                      unit="m"
                      reversed={true}
                      stroke="var(--text-muted)"
                      fontSize={11}
                      label={{ value: 'Depth (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                    />
                    <Tooltip content={<VerticalTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="oxygen"
                      name="Dissolved O₂"
                      stroke="var(--color-success)"
                      strokeWidth={2.2}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '220px', gap: '8px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '28px' }}>🧪</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>No dissolved oxygen measurements on this profile</span>
                <span style={{ fontSize: '11px' }}>This profile does not carry a BGC oxygen sensor, or values were not reported.</span>
              </div>
            )}
          </>
        )}

        {/* Mode 2c: pH vs Depth (BGC) */}
        {activeChart === 'vertical-ph' && hasVertical && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  In-Situ pH Profile
                  <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-muted)' }}>
                    (BGC float — {verticalProfile.levelsCount} levels)
                  </span>
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Depth (m, reversed) vs pH (dimensionless) · Argovis BGC variable: <code>ph_in_situ_total</code>
                </p>
              </div>
            </div>
            {hasPhData ? (
              <div style={{ width: '100%', height: '280px' }}>
                <ResponsiveContainer>
                  <LineChart data={verticalData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                    <XAxis
                      type="number"
                      dataKey="ph"
                      domain={[7.5, 8.5]}
                      stroke="var(--text-muted)"
                      fontSize={11}
                      label={{ value: 'pH (dimensionless)', position: 'bottom', offset: 0, fill: 'var(--color-primary)', fontSize: 11 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="depth"
                      unit="m"
                      reversed={true}
                      stroke="var(--text-muted)"
                      fontSize={11}
                      label={{ value: 'Depth (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const d = payload[0].payload;
                          return (
                            <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', boxShadow: 'var(--shadow-md)', fontSize: '12px' }}>
                              <p style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>Depth: <strong>{d.depth !== null ? `${d.depth} m` : 'Surface'}</strong></p>
                              {d.ph !== null && <p style={{ color: 'var(--color-primary)' }}>pH: <strong>{typeof d.ph === 'number' ? d.ph.toFixed(4) : d.ph}</strong></p>}
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="ph"
                      name="pH"
                      stroke="var(--color-primary)"
                      strokeWidth={2.2}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '220px', gap: '8px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '28px' }}>🧪</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>No pH measurements on this profile</span>
                <span style={{ fontSize: '11px' }}>This float does not carry a pH sensor, or values were not reported.</span>
              </div>
            )}
          </>
        )}

        {/* Mode 3: Timeseries Temporal Trends */}
        {activeChart === 'timeseries' && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title">Water Temperature &amp; Salinity Over Time</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  {processedData.length > 0 
                    ? `Displaying ${processedData.length} observations from ${new Date(processedData[0].timestamp).toLocaleDateString()} to ${new Date(processedData[processedData.length - 1].timestamp).toLocaleDateString()}`
                    : 'Correlating thermal dynamics with salinity patterns across observation timestamps'}
                </p>
              </div>
            </div>
            
            {processedData.length > 0 ? (
              <div style={{ width: '100%', height: '280px' }}>
                <ResponsiveContainer>
                  <LineChart data={processedData} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                    <XAxis 
                      dataKey="timestamp" 
                      tickFormatter={formatDate} 
                      stroke="var(--text-muted)" 
                      fontSize={10}
                    />
                    <YAxis 
                      yAxisId="left" 
                      stroke="#E07B3A" 
                      label={{ value: 'Temp (°C)', angle: -90, position: 'insideLeft', style: { fill: '#E07B3A', fontSize: 11, fontWeight: 500 } }}
                      fontSize={11}
                    />
                    <YAxis 
                      yAxisId="right" 
                      orientation="right" 
                      stroke="#7B61C4" 
                      label={{ value: 'Salinity (PSU)', angle: 90, position: 'insideRight', style: { fill: '#7B61C4', fontSize: 11, fontWeight: 500 } }}
                      fontSize={11}
                      domain={['dataMin - 0.5', 'dataMax + 0.5']}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px', color: 'var(--text-secondary)' }} />
                    <Line 
                      yAxisId="left" 
                      type="monotone" 
                      dataKey="temperature" 
                      name="Temperature" 
                      stroke="#E07B3A" 
                      strokeWidth={2} 
                      unit="°C"
                      dot={false}
                      activeDot={{ r: 5, stroke: 'var(--color-primary)', strokeWidth: 1 }}
                    />
                    <Line 
                      yAxisId="right" 
                      type="monotone" 
                      dataKey="salinity" 
                      name="Salinity" 
                      stroke="#7B61C4" 
                      strokeWidth={2} 
                      unit=" PSU"
                      dot={false}
                      activeDot={{ r: 5, stroke: 'var(--color-primary)', strokeWidth: 1 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '220px', gap: '8px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '28px' }}>📈</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>No multi-cycle temporal records available for this station yet</span>
                <span style={{ fontSize: '11px' }}>
                  {hasVertical 
                    ? 'This Argo float’s comprehensive CTD depth profile is available in the Temperature and Salinity Profile tabs above.' 
                    : 'Select "All Stations" or select an active float to view its profile.'}
                </span>
              </div>
            )}
          </>
        )}

        {/* Mode 4: Biogeochemical O2 / pH */}
        {activeChart === 'oxygen-ph' && (
          <>
            <div className="chart-header">
              <div>
                <h3 className="chart-title">Biogeochemical (O₂ / pH) Observations</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Monitoring dissolved oxygen content (mg/L) and pH across depth &amp; observation cycles (Missing sensors remain null)
                </p>
              </div>
            </div>
            
            {timeseriesHasOxygen || timeseriesHasPh ? (
              <div style={{ width: '100%', height: '280px' }}>
                <ResponsiveContainer>
                  <LineChart data={processedData} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                    <XAxis 
                      dataKey="timestamp" 
                      tickFormatter={formatDate} 
                      stroke="var(--text-muted)" 
                      fontSize={10}
                    />
                    <YAxis 
                      yAxisId="left" 
                      stroke="var(--color-success)" 
                      label={{ value: 'Oxygen (mg/L)', angle: -90, position: 'insideLeft', style: { fill: 'var(--color-success)', fontSize: 11, fontWeight: 500 } }}
                      fontSize={11}
                    />
                    <YAxis 
                      yAxisId="right" 
                      orientation="right" 
                      stroke="var(--color-primary)" 
                      label={{ value: 'pH', angle: 90, position: 'insideRight', style: { fill: 'var(--color-primary)', fontSize: 11, fontWeight: 500 } }}
                      fontSize={11}
                      domain={[7.0, 9.0]}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Line 
                      yAxisId="left" 
                      type="monotone" 
                      dataKey="oxygenContent" 
                      name="Dissolved O₂" 
                      stroke="var(--color-success)" 
                      strokeWidth={2} 
                      unit=" mg/L"
                      dot={false}
                    />
                    <Line 
                      yAxisId="right" 
                      type="monotone" 
                      dataKey="ph" 
                      name="pH Value" 
                      stroke="var(--color-primary)" 
                      strokeWidth={2} 
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (hasOxygenData || hasPhData) ? (
              /* If vertical profile has BGC measurements, display vertical depth profile */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--color-success)', fontWeight: '600', padding: '4px 8px', background: 'rgba(0,180,100,0.08)', borderRadius: '6px' }}>
                  ✓ BGC Vertical Profile Active: {hasOxygenData ? 'Dissolved O₂ (doxy) ' : ''}{hasPhData ? '· In-Situ pH (ph_in_situ_total)' : ''}
                </div>
                <div style={{ width: '100%', height: '260px' }}>
                  <ResponsiveContainer>
                    <LineChart data={verticalData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(220,234,241,0.8)" />
                      {hasOxygenData && (
                        <XAxis
                          type="number"
                          dataKey="oxygen"
                          unit=" mg/L"
                          stroke="var(--color-success)"
                          fontSize={11}
                          label={{ value: 'Dissolved O₂ (mg/L)', position: 'bottom', offset: 0, fill: 'var(--color-success)', fontSize: 11 }}
                        />
                      )}
                      {hasPhData && !hasOxygenData && (
                        <XAxis
                          type="number"
                          dataKey="ph"
                          domain={[7.5, 8.5]}
                          stroke="var(--color-primary)"
                          fontSize={11}
                          label={{ value: 'pH', position: 'bottom', offset: 0, fill: 'var(--color-primary)', fontSize: 11 }}
                        />
                      )}
                      <YAxis
                        type="number"
                        dataKey="depth"
                        unit="m"
                        reversed={true}
                        stroke="var(--text-muted)"
                        fontSize={11}
                        label={{ value: 'Depth (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                      />
                      <Tooltip content={<VerticalTooltip />} />
                      {hasOxygenData && (
                        <Line
                          type="monotone"
                          dataKey="oxygen"
                          name="Dissolved O₂"
                          stroke="var(--color-success)"
                          strokeWidth={2.2}
                          dot={false}
                          activeDot={{ r: 5 }}
                        />
                      )}
                      {hasPhData && (
                        <Line
                          type="monotone"
                          dataKey="ph"
                          name="pH"
                          stroke="var(--color-primary)"
                          strokeWidth={2.2}
                          dot={false}
                          activeDot={{ r: 5 }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '220px', gap: '8px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '28px' }}>🧪</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>No Biogeochemical (O₂ / pH) sensors equipped</span>
                <span style={{ fontSize: '11px', maxWidth: '420px', textAlign: 'center' }}>
                  This platform is a Core Argo float measuring standard CTD parameters (Conductivity, Temperature, Depth). Biogeochemical channels (doxy, ph_in_situ_total) remain strictly null without fabrication.
                </span>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
