import React, { useState } from 'react';
import {
  LayoutDashboard, UploadCloud, RefreshCw, Info,
  Database, Brain, PhoneCall, Activity, Compass,
  AlertTriangle, Building2, Radio, Users, ShieldAlert,
  LogOut, Waves, Key, Lock, Server, ChevronDown, ChevronRight
} from 'lucide-react';
import { authHeaders } from '../utils/authClient';
import { ROLE_LABELS } from '../utils/roles';

export default function Sidebar({
  activeTab,
  setActiveTab,
  onResetDb,
  isResetting,
  apiKey,
  setApiKey,
  isMongoConnected,
  alertCount,
  activeSOSCount,
  allowedTabs = [],
  currentUser,
  onLogout
}) {
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [passwordNote, setPasswordNote] = useState('');
  const [geminiReady, setGeminiReady] = useState(null);

  const can = (tab) => allowedTabs.includes(tab);
  const isAdmin = currentUser?.role === 'admin';

  const handlePasswordChange = async (event) => {
    event.preventDefault();
    setPasswordNote('');
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(passwordForm)
      });
      const data = await response.json();
      if (!response.ok) {
        setPasswordNote(data.error || 'Could not change the password.');
        return;
      }
      setPasswordForm({ currentPassword: '', newPassword: '' });
      setPasswordNote('Password updated successfully.');
    } catch {
      setPasswordNote('The server could not be reached.');
    }
  };

  const NavItem = ({ tab, icon: Icon, label, badge, badgeColor, iconColor }) => {
    const isActive = activeTab === tab;
    return (
      <div
        className={`nav-item ${isActive ? 'active' : ''}`}
        onClick={() => setActiveTab(tab)}
      >
        <Icon size={16} color={isActive ? 'var(--color-secondary)' : (iconColor || 'rgba(255,255,255,0.5)')} />
        <span style={{ flex: 1 }}>{label}</span>
        {badge > 0 && (
          <span style={{
            background: badgeColor || 'var(--color-danger)',
            color: 'white',
            fontSize: '10px',
            fontWeight: '700',
            padding: '2px 6px',
            borderRadius: '20px',
            minWidth: '20px',
            textAlign: 'center'
          }}>
            {badge}
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">🌊</div>
        <div>
          <div className="sidebar-logo-text">FloatChat AI</div>
          <div className="sidebar-logo-sub">Ocean Intelligence</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">

        {/* Ocean Monitoring */}
        <div className="sidebar-section-label">Ocean Monitoring</div>

        <NavItem tab="dashboard" icon={Waves} label="Buoy Telemetry" badge={alertCount} />
        {can('ml-anomaly') && (
          <NavItem tab="ml-anomaly" icon={Brain} label="ML Anomaly Detection"
            badge={0}
            iconColor="rgba(82,182,217,0.7)"
          />
        )}

        {/* Disaster Management */}
        <div className="sidebar-section-label">Disaster Management</div>

        <NavItem tab="disaster-alerts" icon={Compass} label="Alerts & Safe Navigation" iconColor="rgba(255,255,255,0.5)" />
        <NavItem tab="emergency-sos" icon={AlertTriangle} label="Emergency SOS" badge={activeSOSCount} badgeColor="var(--color-danger)" iconColor="rgba(181,44,58,0.7)" />
        <NavItem tab="shelter-resources" icon={Building2} label="Smart Shelters" iconColor="rgba(29,138,106,0.7)" />
        <NavItem tab="family-safety" icon={Users} label="Family Safety" />

        {/* Operations */}
        <div className="sidebar-section-label">Operations</div>

        {can('rescue-command') && (
          <NavItem tab="rescue-command" icon={ShieldAlert} label="Live Rescue Command" iconColor="rgba(181,44,58,0.6)" />
        )}
        {can('incidents') && (
          <NavItem tab="incidents" icon={Activity} label="Incident Command" />
        )}
        <NavItem tab="offline-mesh" icon={Radio} label="Offline Connectivity"
          badge={0} iconColor="rgba(201,122,24,0.7)"
        />
        {can('sms-alerts') && (
          <NavItem tab="sms-alerts" icon={PhoneCall} label="SMS Alerts" />
        )}
        {can('upload') && (
          <NavItem tab="upload" icon={UploadCloud} label="Upload Data" />
        )}
        {can('admin-portal') && (
          <NavItem tab="admin-portal" icon={Users} label="User Management" iconColor="rgba(82,182,217,0.7)" />
        )}
        <NavItem tab="about" icon={Info} label="About & Docs" />

      </nav>

      {/* Bottom Settings Panel */}
      <div className="settings-section">
        <div className="settings-title">System Configuration</div>

        {/* DB Status Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
          <Server size={13} color="rgba(22,138,173,0.8)" />
          <span>
            Storage:&nbsp;
            <span style={{ color: 'rgba(82,182,217,0.9)', fontWeight: '600' }}>SQLite</span>
          </span>
        </div>

        {/* Current user */}
        {currentUser && (
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>{currentUser.fullName}</div>
            <div>{ROLE_LABELS[currentUser.role] || currentUser.role}</div>
          </div>
        )}

        {/* API Key (admin only) */}
        {isAdmin && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button
              className="btn-secondary"
              onClick={() => setShowKeyInput(!showKeyInput)}
            >
              <Key size={13} />
              <span style={{ flex: 1, textAlign: 'left' }}>Gemini API Status</span>
              {showKeyInput ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {showKeyInput && (
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', lineHeight: 1.5 }}>
                API key is configured via <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: '3px' }}>GEMINI_API_KEY</code> in <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: '3px' }}>backend/.env</code>.
              </div>
            )}
          </div>
        )}

        {/* Reset DB */}
        {isAdmin && (
          <button
            className="btn-secondary"
            onClick={onResetDb}
            disabled={isResetting}
          >
            <RefreshCw size={13} className={isResetting ? 'spinner' : ''} />
            <span>{isResetting ? 'Resetting...' : 'Reset Default Data'}</span>
          </button>
        )}

        {/* Change Password */}
        <button
          className="btn-secondary"
          onClick={() => setShowPasswordForm(open => !open)}
        >
          <Lock size={13} />
          <span>Change Password</span>
          {showPasswordForm ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        {showPasswordForm && (
          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input
              className="input-field"
              type="password"
              placeholder="Current password"
              value={passwordForm.currentPassword}
              onChange={e => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
              style={{ fontSize: '12px', padding: '7px 10px' }}
            />
            <input
              className="input-field"
              type="password"
              placeholder="New password"
              value={passwordForm.newPassword}
              onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
              style={{ fontSize: '12px', padding: '7px 10px' }}
            />
            <button className="btn-primary" type="submit" style={{ justifyContent: 'center', fontSize: '12px', padding: '7px' }}>
              Save Password
            </button>
            {passwordNote && (
              <div style={{ fontSize: '11px', color: passwordNote.includes('success') ? 'rgba(29,138,106,0.9)' : 'rgba(181,44,58,0.9)' }}>
                {passwordNote}
              </div>
            )}
          </form>
        )}

        {/* Logout */}
        <button className="btn-secondary" onClick={onLogout}>
          <LogOut size={13} />
          <span>Log Out</span>
        </button>

        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.2)', textAlign: 'center', marginTop: '4px' }}>
          FloatChat AI Enterprise v2.1
        </div>
      </div>
    </aside>
  );
}
