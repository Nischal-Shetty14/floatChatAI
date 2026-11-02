import React, { useState } from 'react';
import { 
  LayoutDashboard, UploadCloud, RefreshCw, Key, Info, 
  Database, Brain, PhoneCall, Activity, Compass, 
  AlertTriangle, Building2, Radio, Users, ShieldAlert, LogOut
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
  const can = (tab) => allowedTabs.includes(tab);
  const isAdmin = currentUser?.role === 'admin';

  const handleKeyChange = (e) => {
    const key = e.target.value;
    setApiKey(key);
    localStorage.setItem('floatchat_gemini_key', key);
  };

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
      setPasswordNote('Password updated.');
    } catch {
      setPasswordNote('The server could not be reached.');
    }
  };

  return (
    <div className="sidebar">
      <div>
        <div className="logo-section">
          <span className="logo-icon">🌊</span>
          <span className="logo-text gradient-text">FloatChat AI</span>
        </div>

        <nav className="nav-menu">
          {/* Section: Disaster Management Core */}
          <div style={{ fontSize: '10px', fontWeight: '800', color: 'var(--color-primary)', letterSpacing: '1px', padding: '8px 12px 4px 12px', textTransform: 'uppercase' }}>
            Disaster Management
          </div>

          <div 
            className={`nav-item ${activeTab === 'disaster-alerts' ? 'active' : ''}`}
            onClick={() => setActiveTab('disaster-alerts')}
          >
            <Compass size={18} color="var(--color-primary)" />
            <span>Alerts & Safe Nav</span>
            <span className="nav-tag" style={{ background: 'rgba(255, 71, 114, 0.2)', color: 'var(--color-danger)' }}>LIVE</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'emergency-sos' ? 'active' : ''}`}
            onClick={() => setActiveTab('emergency-sos')}
          >
            <AlertTriangle size={18} color="var(--color-danger)" />
            <span>Emergency SOS</span>
            {activeSOSCount > 0 && (
              <span className="alert-count-badge" style={{ background: 'var(--color-danger)' }}>{activeSOSCount}</span>
            )}
          </div>

          <div 
            className={`nav-item ${activeTab === 'shelter-resources' ? 'active' : ''}`}
            onClick={() => setActiveTab('shelter-resources')}
          >
            <Building2 size={18} color="var(--color-success)" />
            <span>Smart Shelters & AI</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'offline-mesh' ? 'active' : ''}`}
            onClick={() => setActiveTab('offline-mesh')}
          >
            <Radio size={18} color="var(--color-warning)" />
            <span>Offline P2P Mesh</span>
            <span className="nav-tag" style={{ background: 'rgba(245, 166, 35, 0.2)', color: 'var(--color-warning)' }}>P2P</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'family-safety' ? 'active' : ''}`}
            onClick={() => setActiveTab('family-safety')}
          >
            <Users size={18} color="var(--color-secondary)" />
            <span>Family Safety Check</span>
          </div>

          {can('rescue-command') && (
          <div 
            className={`nav-item ${activeTab === 'rescue-command' ? 'active' : ''}`}
            onClick={() => setActiveTab('rescue-command')}
          >
            <ShieldAlert size={18} color="#ff7fa1" />
            <span>Live Rescue Command</span>
          </div>
          )}

          {/* Section: Ocean Telemetry & ML */}
          <div style={{ fontSize: '10px', fontWeight: '800', color: 'var(--text-muted)', letterSpacing: '1px', padding: '14px 12px 4px 12px', textTransform: 'uppercase' }}>
            Ocean Telemetry
          </div>

          <div 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            <span>Buoy Telemetry</span>
            {alertCount > 0 && (
              <span className="alert-count-badge">{alertCount}</span>
            )}
          </div>

          {can('ml-anomaly') && (
          <div 
            className={`nav-item ${activeTab === 'ml-anomaly' ? 'active' : ''}`}
            onClick={() => setActiveTab('ml-anomaly')}
          >
            <Brain size={18} />
            <span>ML Anomaly Engine</span>
            <span className="nav-tag nav-tag-ml">ML</span>
          </div>
          )}

          {can('sms-alerts') && (
          <div 
            className={`nav-item ${activeTab === 'sms-alerts' ? 'active' : ''}`}
            onClick={() => setActiveTab('sms-alerts')}
          >
            <PhoneCall size={18} />
            <span>Twilio SMS Alerts</span>
          </div>
          )}

          {can('incidents') && (
          <div 
            className={`nav-item ${activeTab === 'incidents' ? 'active' : ''}`}
            onClick={() => setActiveTab('incidents')}
          >
            <Activity size={18} />
            <span>Incident Command</span>
          </div>
          )}

          {can('upload') && (
          <div 
            className={`nav-item ${activeTab === 'upload' ? 'active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            <UploadCloud size={18} />
            <span>Upload Data</span>
          </div>
          )}

          {can('admin-portal') && (
          <div 
            className={`nav-item ${activeTab === 'admin-portal' ? 'active' : ''}`}
            onClick={() => setActiveTab('admin-portal')}
          >
            <Users size={18} color="var(--color-primary)" />
            <span>Users & Phone Alerts</span>
          </div>
          )}

          <div 
            className={`nav-item ${activeTab === 'about' ? 'active' : ''}`}
            onClick={() => setActiveTab('about')}
          >
            <Info size={18} />
            <span>About & Docs</span>
          </div>
        </nav>
      </div>

      <div className="settings-section">
        <div className="settings-title">System Configuration</div>
        
        {/* DB Connection Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <Database size={14} color={isMongoConnected ? 'var(--color-success)' : 'var(--color-warning)'} />
          <span>
            Storage: {isMongoConnected ? (
              <span style={{ color: 'var(--color-success)', fontWeight: '600' }}>MongoDB</span>
            ) : (
              <span style={{ color: 'var(--color-warning)', fontWeight: '600' }}>Local JSON</span>
            )}
          </span>
        </div>

        {currentUser && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{currentUser.fullName}</div>
            <div>{ROLE_LABELS[currentUser.role] || currentUser.role}</div>
          </div>
        )}

        {isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <button 
            className="btn-secondary" 
            style={{ padding: '8px 12px', fontSize: '12px', justifyContent: 'center', width: '100%' }}
            onClick={() => setShowKeyInput(!showKeyInput)}
          >
            <Key size={14} />
            <span>{apiKey ? 'API Key Configured' : 'Configure Gemini Key'}</span>
          </button>
          
          {showKeyInput && (
            <input 
              type="password"
              className="input-field"
              placeholder="Paste Gemini API Key..."
              value={apiKey}
              onChange={handleKeyChange}
              style={{ fontSize: '11px', padding: '6px 10px', marginTop: '4px' }}
            />
          )}
        </div>
        )}

        {isAdmin && (
        <button 
          className="btn-secondary" 
          style={{ 
            padding: '8px 12px', 
            fontSize: '12px', 
            justifyContent: 'center', 
            width: '100%',
            borderColor: 'rgba(255, 71, 114, 0.2)',
            color: 'rgba(255, 255, 255, 0.9)'
          }}
          onClick={onResetDb}
          disabled={isResetting}
        >
          <RefreshCw size={14} className={isResetting ? 'spinner' : ''} />
          <span>{isResetting ? 'Resetting...' : 'Reset Default Data'}</span>
        </button>
        )}

        <button
          className="btn-secondary"
          style={{ padding: '8px 12px', fontSize: '12px', justifyContent: 'center', width: '100%' }}
          onClick={() => setShowPasswordForm((open) => !open)}
        >
          Change password
        </button>
        {showPasswordForm && (
          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input className="input-field" type="password" placeholder="Current password" value={passwordForm.currentPassword} onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} style={{ fontSize: '11px', padding: '6px 10px' }} />
            <input className="input-field" type="password" placeholder="New password" value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} style={{ fontSize: '11px', padding: '6px 10px' }} />
            <button className="btn-primary" type="submit" style={{ justifyContent: 'center', fontSize: '12px' }}>Save password</button>
            {passwordNote && <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{passwordNote}</div>}
          </form>
        )}
        <button
          className="btn-secondary"
          style={{ padding: '8px 12px', fontSize: '12px', justifyContent: 'center', width: '100%' }}
          onClick={onLogout}
        >
          <LogOut size={14} />
          <span>Log out</span>
        </button>

        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '10px' }}>
          FloatChat AI Enterprise v2.0
        </div>
      </div>
    </div>
  );
}
