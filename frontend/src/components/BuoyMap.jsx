import React, { useState } from 'react';
import { Battery, Compass, AlertCircle, Navigation, Radio, Waves } from 'lucide-react';

export default function BuoyMap({ buoys, selectedBuoy, onSelectBuoy, telemetryData, selectedFloatTrajectory = [] }) {
  const [hoveredBuoy, setHoveredBuoy] = useState(null);

  // Map latitude/longitude to SVG viewport (X: 0 to 400, Y: 0 to 200)
  // longitude: -180 to 180, latitude: -90 to 90
  const getXY = (lat, lng) => {
    if (lat === null || lat === undefined || lng === null || lng === undefined) {
      return { x: 200, y: 100 };
    }
    const x = ((Number(lng) + 180) / 360) * 400;
    const y = ((90 - Number(lat)) / 180) * 200;
    return { x, y };
  };

  // Get current readings for each buoy (most recent record)
  const buoyReadings = React.useMemo(() => {
    const readings = {};
    if (Array.isArray(telemetryData)) {
      telemetryData.forEach(d => {
        if (!readings[d.buoyId] || new Date(d.timestamp) > new Date(readings[d.buoyId].timestamp)) {
          readings[d.buoyId] = d;
        }
      });
    }
    return readings;
  }, [telemetryData]);

  // Assess buoy health status
  const getBuoyStatus = (buoy) => {
    if (buoy.isArgo) return 'argo';
    const data = buoyReadings[buoy.id];
    if (!data) return 'active';
    if (data.oxygenContent !== null && data.oxygenContent < 4.0) return 'danger';
    if ((data.batteryLevel !== null && data.batteryLevel < 25) || (data.temperature !== null && data.temperature > 24.0)) return 'warning';
    return 'active';
  };

  // Build drift trajectory points for SVG polyline if available
  const trajectoryPoints = React.useMemo(() => {
    if (!Array.isArray(selectedFloatTrajectory) || selectedFloatTrajectory.length < 2) return '';
    return selectedFloatTrajectory
      .filter(pt => pt.latitude !== null && pt.longitude !== null)
      .map(pt => {
        const { x, y } = getXY(pt.latitude, pt.longitude);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [selectedFloatTrajectory]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
      {/* Interactive Map Canvas */}
      <div className="map-viewport" style={{ position: 'relative', overflow: 'hidden' }}>
        <svg viewBox="0 0 400 200" className="map-svg" style={{ width: '100%', height: '100%' }}>
          {/* Latitude/Longitude Dotted Grid Lines */}
          <line x1="0" y1="50" x2="400" y2="50" className="map-grid-line" strokeDasharray="2,2" />
          <line x1="0" y1="100" x2="400" y2="100" className="map-grid-line" strokeDasharray="2,2" />
          <line x1="0" y1="150" x2="400" y2="150" className="map-grid-line" strokeDasharray="2,2" />

          <line x1="100" y1="0" x2="100" y2="200" className="map-grid-line" strokeDasharray="2,2" />
          <line x1="200" y1="0" x2="200" y2="200" className="map-grid-line" strokeDasharray="2,2" />
          <line x1="300" y1="0" x2="300" y2="200" className="map-grid-line" strokeDasharray="2,2" />

          {/* Grid Labels */}
          <text x="5" y="98" fill="var(--text-muted)" fontSize="6" opacity="0.6">Equator 0°</text>
          <text x="195" y="195" fill="var(--text-muted)" fontSize="6" opacity="0.6" textAnchor="middle">Prime Meridian 0°</text>
          <text x="270" y="70" fill="rgba(22,138,173,0.35)" fontSize="7" fontWeight="bold">INDIAN OCEAN</text>

          {/* Landmass Outlines */}
          <path d="M 20 20 Q 40 10, 50 30 T 80 40 T 110 20 L 120 80 Q 90 90, 70 80 T 30 70 Z" className="map-islands" opacity="0.35" />
          <path d="M 310 110 Q 340 100, 360 120 T 380 150 L 350 170 Q 320 160, 310 130 Z" className="map-islands" opacity="0.35" />
          <path d="M 220 30 Q 250 40, 270 20 T 290 50 L 260 80 Q 240 60, 220 50 Z" className="map-islands" opacity="0.35" />
          {/* Indian Subcontinent coastline approximation */}
          <path d="M 270 50 Q 285 75, 290 95 Q 295 85, 305 75 Z" className="map-islands" opacity="0.45" />

          {/* Render Historical Drift Trajectory if selected */}
          {trajectoryPoints && (
            <polyline
              points={trajectoryPoints}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth="1.2"
              strokeDasharray="3,2"
              opacity="0.8"
            />
          )}

          {/* Render Float / Buoy Markers */}
          {buoys.map(b => {
            const { x, y } = getXY(b.lat, b.lng);
            const status = getBuoyStatus(b);
            const isSelected = selectedBuoy === b.id || selectedBuoy === `ARGO-${b.id}` || selectedBuoy === b.floatId;
            const currentTemp = buoyReadings[b.id]?.temperature ?? b.latestTemp ?? 'N/A';
            const currentO2 = buoyReadings[b.id]?.oxygenContent ?? 'N/A';

            let pulseColor = b.isArgo ? '#0077b6' : 'var(--color-primary)';
            if (status === 'warning') pulseColor = 'var(--color-warning)';
            if (status === 'danger') pulseColor = 'var(--color-danger)';

            return (
              <g
                key={b.id}
                className="buoy-node"
                onClick={() => onSelectBuoy(b.id)}
                onMouseEnter={() => setHoveredBuoy({
                  ...b,
                  status,
                  currentTemp,
                  currentO2,
                  x,
                  y
                })}
                onMouseLeave={() => setHoveredBuoy(null)}
              >
                {/* Glowing Outer Beacon Ring */}
                <circle
                  cx={x}
                  cy={y}
                  r={isSelected ? 10 : (b.isArgo ? 5.5 : 7)}
                  fill="none"
                  stroke={isSelected ? '#0077b6' : pulseColor}
                  strokeWidth={isSelected ? '2' : '1.2'}
                  opacity={isSelected ? 0.95 : 0.6}
                  style={{ transformOrigin: `${x}px ${y}px` }}
                >
                  <animate attributeName="r" values="3;11;3" dur="2.4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.8;0.15;0.8" dur="2.4s" repeatCount="indefinite" />
                </circle>

                {/* Inner Anchor Node — Argo floats are cyan circles, Sentinel buoys are solid teal */}
                <circle
                  cx={x}
                  cy={y}
                  r={isSelected ? 4.5 : 3.2}
                  fill={b.isArgo ? '#0096c7' : pulseColor}
                  stroke="#ffffff"
                  strokeWidth="0.9"
                />

                {/* Marker Label on selection or hover */}
                {isSelected && (
                  <text
                    x={x}
                    y={y - 9}
                    fill="var(--text-primary)"
                    fontSize="7"
                    fontWeight="700"
                    textAnchor="middle"
                  >
                    {b.floatId || b.id}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Hover Tooltip display */}
        {hoveredBuoy && (
          <div
            className="buoy-tooltip"
            style={{
              left: `${Math.min(Math.max(10, hoveredBuoy.x - 40), 220)}px`,
              top: `${Math.min(hoveredBuoy.y + 12, 120)}px`,
              background: '#FFFFFF',
              boxShadow: 'var(--shadow-md)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 12px',
              zIndex: 20
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{
                fontSize: '10px',
                fontWeight: '700',
                padding: '1px 6px',
                borderRadius: '10px',
                background: hoveredBuoy.isArgo ? 'rgba(0,180,216,0.15)' : 'var(--color-primary-light)',
                color: hoveredBuoy.isArgo ? '#0077b6' : 'var(--color-primary)'
              }}>
                {hoveredBuoy.isArgo ? 'ARGO FLOAT' : 'FIXED BUOY'}
              </span>
              <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-primary)' }}>
                {hoveredBuoy.floatId || hoveredBuoy.id}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', color: 'var(--text-secondary)', fontSize: '11px' }}>
              <span>Location: <strong>{Number(hoveredBuoy.lat).toFixed(2)}°, {Number(hoveredBuoy.lng).toFixed(2)}°</strong></span>
              {hoveredBuoy.latestCycle !== undefined && (
                <span>Cycle: <strong>Cycle {hoveredBuoy.latestCycle}</strong> ({hoveredBuoy.cycleCount || 1} available)</span>
              )}
              {hoveredBuoy.timestamp && (
                <span>Observed: <strong>{new Date(hoveredBuoy.timestamp).toLocaleDateString()}</strong></span>
              )}
              {hoveredBuoy.currentTemp !== 'N/A' && (
                <span>Temp: <strong style={{ color: '#E07B3A' }}>{hoveredBuoy.currentTemp}°C</strong></span>
              )}
              {hoveredBuoy.availableVariables && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  Sensors: {hoveredBuoy.availableVariables.slice(0, 3).join(', ')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mini Beacons & Floats List panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '180px', overflowY: 'auto' }}>
        {buoys.slice(0, 15).map(b => {
          const status = getBuoyStatus(b);
          const isSelected = selectedBuoy === b.id || selectedBuoy === `ARGO-${b.id}` || selectedBuoy === b.floatId;

          return (
            <div
              key={b.id}
              className={`map-buoy-item ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectBuoy(isSelected ? 'ALL' : b.id)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid var(--color-primary)' : '1px solid var(--border)',
                background: isSelected ? 'var(--color-primary-light)' : '#FFFFFF',
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: b.isArgo ? '#0096c7' : 'var(--color-primary)',
                  display: 'inline-block'
                }} />
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-primary)' }}>
                    {b.name || `Float ${b.floatId || b.id}`}
                  </span>
                  <span style={{ fontSize: '9.5px', color: 'var(--text-muted)' }}>
                    {b.isArgo ? `Cycle ${b.latestCycle || 1}` : 'Fixed Station'} · {Number(b.lat).toFixed(1)}°, {Number(b.lng).toFixed(1)}°
                  </span>
                </div>
              </div>

              <span style={{
                fontSize: '10px',
                fontWeight: '600',
                padding: '1px 5px',
                borderRadius: '8px',
                background: b.isArgo ? 'rgba(0,150,199,0.1)' : 'var(--bg-page)',
                color: b.isArgo ? '#0077b6' : 'var(--text-secondary)'
              }}>
                {b.isArgo ? 'ARGO' : 'BUOY'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
