import React, { useState } from 'react';
import {
  AlertTriangle, Wifi, WifiOff, Volume2, VolumeX, ShieldAlert
} from 'lucide-react';
import { startEmergencySiren, stopEmergencySiren } from '../utils/audioSiren';

const SEVERITY_COLORS = {
  CRITICAL:  { bg: 'var(--color-danger-bg)',  border: 'var(--color-danger-border)',  text: 'var(--color-danger)',  dot: 'var(--color-danger)' },
  HIGH:      { bg: 'var(--color-warning-bg)', border: 'var(--color-warning-border)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  MODERATE:  { bg: 'var(--color-warning-bg)', border: 'var(--color-warning-border)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  LOW:       { bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', text: 'var(--color-success)', dot: 'var(--color-success)' },
  NORMAL:    { bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', text: 'var(--color-success)', dot: 'var(--color-success)' },
};

const SCENARIO_OPTIONS = [
  { value: 'tsunami',    label: 'Tsunami Warning (8.4M Subduction)',   severity: 'CRITICAL' },
  { value: 'cyclone',    label: 'Supercyclone Vardah II (195 km/h)',    severity: 'CRITICAL' },
  { value: 'flood',      label: 'Monsoonal Flash Flood (+2.1m)',         severity: 'HIGH' },
  { value: 'earthquake', label: '7.6M Subduction Earthquake',           severity: 'CRITICAL' },
  { value: 'normal',     label: 'All Clear — Routine Monitoring',        severity: 'NORMAL' },
];

export default function DisasterTopBar({
  disasterScenario,
  allScenarios,
  onSwitchScenario,
  isOfflineMode,
  onToggleOfflineMode,
  onOpenSOS,
  activeTab,
  setActiveTab
}) {
  const [isSirenActive, setIsSirenActive] = useState(false);

  const toggleSiren = () => {
    if (isSirenActive) {
      stopEmergencySiren();
      setIsSirenActive(false);
    } else {
      startEmergencySiren();
      setIsSirenActive(true);
    }
  };

  const severity = disasterScenario?.severity || 'NORMAL';
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.NORMAL;
  const isEmergency = ['CRITICAL', 'HIGH'].includes(severity);

  const currentKey = allScenarios?.find(s => s.name === disasterScenario?.name)?.key || 'normal';

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      flexWrap: 'wrap',
      boxShadow: 'var(--shadow-sm)',
      position: 'sticky',
      top: '0',
      zIndex: 40,
    }}>

      {/* Left — Scenario status and selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {/* Status badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          padding: '5px 12px',
          borderRadius: '20px',
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          flexShrink: 0
        }}>
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: colors.dot,
            display: 'inline-block',
            animation: isEmergency ? 'pulse-dot 1.6s infinite' : 'none',
            flexShrink: 0
          }} />
          <span style={{ fontSize: '11px', fontWeight: '700', color: colors.text, letterSpacing: '0.3px' }}>
            {disasterScenario?.isLiveIncident
              ? 'LIVE DETECTED INCIDENT'
              : (currentKey !== 'normal' ? 'SIMULATED SCENARIO' : 'ROUTINE MONITORING')}
          </span>
        </div>

        {/* Scenario selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: '500' }}>Scenario:</span>
          <select
            value={currentKey}
            onChange={e => onSwitchScenario && onSwitchScenario(e.target.value)}
            style={{
              fontSize: '13px',
              fontWeight: '600',
              padding: '5px 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: '#FFFFFF',
              color: 'var(--text-primary)',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            {SCENARIO_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Active incident name */}
        {disasterScenario?.name && (
          <span style={{
            fontSize: '13px',
            fontWeight: '600',
            color: isEmergency ? colors.text : 'var(--text-secondary)',
            maxWidth: '300px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {disasterScenario.name}
          </span>
        )}
      </div>

      {/* Right — connectivity, siren, SOS */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>

        {/* Connectivity toggle */}
        <button
          onClick={onToggleOfflineMode}
          title={isOfflineMode ? 'P2P Mesh Mode — No cloud connectivity' : 'Online — Cloud connected'}
          className="connectivity-pill"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '5px 11px',
            borderRadius: '20px',
            background: isOfflineMode ? 'var(--color-warning-bg)' : 'var(--color-success-bg)',
            border: isOfflineMode ? '1px solid var(--color-warning-border)' : '1px solid var(--color-success-border)',
            color: isOfflineMode ? 'var(--color-warning)' : 'var(--color-success)',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          {isOfflineMode ? <WifiOff size={13} /> : <Wifi size={13} />}
          <span>{isOfflineMode ? 'Mesh Mode' : 'Online'}</span>
        </button>

        {/* Siren */}
        <button
          onClick={toggleSiren}
          title={isSirenActive ? 'Stop acoustic alarm' : 'Activate acoustic alarm'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '34px',
            height: '34px',
            borderRadius: 'var(--radius-md)',
            background: isSirenActive ? 'var(--color-danger-bg)' : '#FFFFFF',
            border: isSirenActive ? '1px solid var(--color-danger-border)' : '1px solid var(--border)',
            color: isSirenActive ? 'var(--color-danger)' : 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'var(--transition)',
          }}
        >
          {isSirenActive ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>

        {/* SOS Button */}
        <button
          onClick={() => {
            setActiveTab('emergency-sos');
            onOpenSOS && onOpenSOS();
          }}
          className="sos-compact-btn"
        >
          <AlertTriangle size={14} />
          <span>SOS</span>
        </button>
      </div>
    </div>
  );
}
