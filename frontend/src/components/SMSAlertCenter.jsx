import React, { useState, useEffect } from 'react';
import { Send, PhoneCall, Settings, CheckCircle2, AlertTriangle, ShieldAlert, History, Key, Check } from 'lucide-react';
import { authHeaders } from '../utils/authClient';

function SMSAlertCenter() {
  const [config, setConfig] = useState({
    accountSid: '',
    authToken: '',
    fromNumber: '',
    recipientPhone: ''
  });
  const [configStatus, setConfigStatus] = useState(null);
  const [smsLogs, setSmsLogs] = useState([]);
  const [testMessage, setTestMessage] = useState('FloatChat AI Alert Test: Ocean Buoy FC-PAC-01 reporting normal operation.');
  const [testRecipient, setTestRecipient] = useState('');
  const [selectedBuoy, setSelectedBuoy] = useState('FC-PAC-01');
  const [selectedSeverity, setSelectedSeverity] = useState('CRITICAL');
  const [isSending, setIsSending] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Automated Alert Rule Toggles
  const [autoSendOnRisk, setAutoSendOnRisk] = useState(true);
  const [autoSendOnHypoxia, setAutoSendOnHypoxia] = useState(true);
  const [autoSendOnBattery, setAutoSendOnBattery] = useState(true);

  // Fetch Twilio config status
  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/sms/config', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setConfigStatus(data);
        if (data.recipientPhone && data.recipientPhone !== 'NOT_SET') {
          setTestRecipient(data.recipientPhone);
        }
      }
    } catch (err) {
      console.error('Error fetching SMS config:', err);
    }
  };

  // Fetch SMS audit logs
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/sms/logs', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSmsLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Error fetching SMS logs:', err);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetchLogs();
  }, []);

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setIsSavingConfig(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/sms/config', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.success) {
        setConfigStatus(data.status);
        setFeedback({ type: 'success', text: 'Twilio Configuration saved successfully!' });
      } else {
        setFeedback({ type: 'error', text: 'Failed to update Twilio configuration.' });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: 'Error saving settings.' });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSendTestSMS = async (e) => {
    e.preventDefault();
    if (!testMessage.trim()) return;

    setIsSending(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          to: testRecipient || undefined,
          message: testMessage,
          buoyName: selectedBuoy,
          severity: selectedSeverity,
          liveOnly: true
        })
      });

      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: 'success',
          text: `SMS Dispatched Successfully! Mode: ${data.mode} | SID: ${data.sid}`
        });
        fetchLogs();
      } else {
        setFeedback({
          type: 'error',
          text: `SMS Notice: ${data.error || 'Check Twilio credentials or phone formatting'}`
        });
        fetchLogs();
      }
    } catch (err) {
      setFeedback({ type: 'error', text: 'Error dispatching SMS request to server.' });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="tab-container">
      {/* Header */}
      <div className="section-header glow-box">
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div className="icon-badge" style={{ background: 'rgba(236, 72, 153, 0.15)', color: '#ec4899' }}>
            <PhoneCall size={28} />
          </div>
          <div>
            <h1 className="gradient-title" style={{ fontSize: '24px', margin: 0 }}>
              Twilio SMS Messaging Alert System
            </h1>
            <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0 0', fontSize: '14px' }}>
              Instant Cellular & Sandbox Alert Dispatcher for Ocean Telemetry Emergencies
            </p>
          </div>
        </div>

        <div className="status-pill-badge">
          <span className={`dot ${configStatus?.isConfigured ? 'dot-active' : 'dot-sim'}`}></span>
          <span>{configStatus?.isConfigured ? 'Twilio SMS credentials active' : 'Twilio not configured — messages are not sent'}</span>
        </div>
      </div>

      {feedback && (
        <div className={`alert-banner ${feedback.type === 'success' ? 'banner-success' : 'banner-error'}`}>
          {feedback.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{feedback.text}</span>
          <button onClick={() => setFeedback(null)} className="close-btn">×</button>
        </div>
      )}

      <div className="two-column-layout">
        {/* Left Column: Configuration & Dispatcher */}
        <div className="column-left">
          {/* Quick SMS Dispatcher Card */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Send size={18} color="var(--color-primary)" />
                Send Instant SMS Alert
              </h3>
            </div>

            <form onSubmit={handleSendTestSMS} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label className="form-label">Recipient Phone Number (E.164 Format)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="+1234567890 (or leave empty to use saved default)"
                  value={testRecipient}
                  onChange={(e) => setTestRecipient(e.target.value)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="form-label">Target Buoy Station</label>
                  <select 
                    className="form-select"
                    value={selectedBuoy}
                    onChange={(e) => setSelectedBuoy(e.target.value)}
                  >
                    <option value="FC-PAC-01">Pacific Deep-Shift (FC-PAC-01)</option>
                    <option value="FC-ATL-02">Atlantic Trench-Link (FC-ATL-02)</option>
                    <option value="FC-IND-03">Indian Current-Buoy (FC-IND-03)</option>
                    <option value="FC-ARC-04">Arctic Drift-Beacon (FC-ARC-04)</option>
                  </select>
                </div>

                <div>
                  <label className="form-label">Alert Severity Level</label>
                  <select 
                    className="form-select"
                    value={selectedSeverity}
                    onChange={(e) => setSelectedSeverity(e.target.value)}
                  >
                    <option value="CRITICAL">CRITICAL (Emergency)</option>
                    <option value="WARNING">WARNING (High Risk)</option>
                    <option value="INFO">INFO (Status Update)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="form-label">SMS Alert Body Text</label>
                <textarea 
                  className="form-textarea" 
                  rows={3}
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                />
              </div>

              <button type="submit" className="btn-primary" disabled={isSending}>
                <Send size={16} />
                <span>{isSending ? 'Dispatching SMS...' : 'Dispatch SMS Alert via Twilio'}</span>
              </button>
            </form>
          </div>

          {/* Twilio Credentials Configuration Card */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Key size={18} color="var(--color-warning)" />
                Twilio Account Settings (Free Subscription Compatible)
              </h3>
            </div>

            <form onSubmit={handleSaveConfig} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label className="form-label">Twilio Account SID</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={config.accountSid}
                  onChange={(e) => setConfig({ ...config, accountSid: e.target.value })}
                />
                <span className="form-hint">Current: {configStatus?.accountSidMasked}</span>
              </div>

              <div>
                <label className="form-label">Twilio Auth Token</label>
                <input 
                  type="password" 
                  className="form-input" 
                  placeholder="••••••••••••••••••••••••••••••••"
                  value={config.authToken}
                  onChange={(e) => setConfig({ ...config, authToken: e.target.value })}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="form-label">Twilio Phone Number (From)</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    placeholder="+18005550199"
                    value={config.fromNumber}
                    onChange={(e) => setConfig({ ...config, fromNumber: e.target.value })}
                  />
                </div>
                <div>
                  <label className="form-label">Default Alert Recipient (To)</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    placeholder="+1234567890"
                    value={config.recipientPhone}
                    onChange={(e) => setConfig({ ...config, recipientPhone: e.target.value })}
                  />
                </div>
              </div>

              <button type="submit" className="btn-secondary" disabled={isSavingConfig}>
                <Settings size={16} />
                <span>Save Twilio Credentials</span>
              </button>
            </form>
          </div>
        </div>

        {/* Right Column: Automated Rules & Dispatch Audit Logs */}
        <div className="column-right">
          {/* Automated Rule Toggles */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldAlert size={18} color="var(--color-danger)" />
                Automated SMS Alert Rules
              </h3>
            </div>

            <div className="rules-list">
              <label className="rule-item">
                <input 
                  type="checkbox" 
                  checked={autoSendOnRisk} 
                  onChange={(e) => setAutoSendOnRisk(e.target.checked)} 
                />
                <div>
                  <strong>High ML Risk Score (&gt; 75%)</strong>
                  <p>Auto-dispatch SMS when ensemble ML model flags critical anomaly</p>
                </div>
              </label>

              <label className="rule-item">
                <input 
                  type="checkbox" 
                  checked={autoSendOnHypoxia} 
                  onChange={(e) => setAutoSendOnHypoxia(e.target.checked)} 
                />
                <div>
                  <strong>Deep-Sea Hypoxia (&lt; 4.0 mg/L O2)</strong>
                  <p>Auto-dispatch SMS when dissolved oxygen falls below hypoxia threshold</p>
                </div>
              </label>

              <label className="rule-item">
                <input 
                  type="checkbox" 
                  checked={autoSendOnBattery} 
                  onChange={(e) => setAutoSendOnBattery(e.target.checked)} 
                />
                <div>
                  <strong>Buoy Battery Exhaustion (&lt; 20%)</strong>
                  <p>Auto-dispatch SMS when solar charging falls below emergency reserve</p>
                </div>
              </label>
            </div>
          </div>

          {/* Dispatch Audit Logs */}
          <div className="panel-card" style={{ flex: 1 }}>
            <div className="panel-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <History size={18} color="var(--color-info)" />
                Twilio SMS Dispatch Audit Logs ({smsLogs.length})
              </h3>
            </div>

            {smsLogs.length === 0 ? (
              <div className="empty-state">
                <History size={36} color="var(--text-secondary)" />
                <p>No SMS dispatch logs recorded yet. Try sending a test message above!</p>
              </div>
            ) : (
              <div className="sms-log-list">
                {smsLogs.map((log) => (
                  <div key={log.id} className="sms-log-card">
                    <div className="sms-log-header">
                      <span className={`status-tag ${log.status === 'DELIVERED' ? 'tag-delivered' : 'tag-simulated'}`}>
                        {log.status}
                      </span>
                      <span className="sms-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
                    </div>

                    <div className="sms-log-body">
                      {log.message}
                    </div>

                    <div className="sms-log-footer">
                      <span>To: <strong>{log.recipient}</strong></span>
                      <span>Mode: <code>{log.mode}</code></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SMSAlertCenter;
