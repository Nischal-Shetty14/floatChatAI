import React, { useEffect, useState } from 'react';
import { Users, Send, ShieldAlert, CheckCircle2, AlertTriangle } from 'lucide-react';
import { authHeaders } from '../utils/authClient';
import { ROLE_LABELS } from '../utils/roles';

const DEFAULT_MESSAGE = 'Coastal emergency alert. Move away from the shore to high ground or a verified shelter now. Do not wait to watch the water.';

export default function AdminPortal() {
  const [users, setUsers] = useState([]);
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [channels, setChannels] = useState({ sms: true, whatsapp: true });
  const [testPhone, setTestPhone] = useState('');
  const [managerForm, setManagerForm] = useState({ fullName: '', username: '', phone: '', password: '' });
  const [feedback, setFeedback] = useState(null);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [userRes, historyRes, statusRes] = await Promise.all([
        fetch('/api/admin/users', { headers: authHeaders() }),
        fetch('/api/admin/broadcasts', { headers: authHeaders() }),
        fetch('/api/status')
      ]);
      if (userRes.ok) setUsers((await userRes.json()).users || []);
      if (historyRes.ok) setHistory((await historyRes.json()).broadcasts || []);
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (err) {
      setFeedback({ type: 'error', text: 'Could not load the admin directory.' });
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedChannels = Object.entries(channels).filter(([, on]) => on).map(([name]) => name);
  const citizens = users.filter((user) => user.role === 'user');

  const sendAlert = async (testOnly) => {
    setFeedback(null);
    setResults([]);
    if (selectedChannels.length === 0) {
      setFeedback({ type: 'error', text: 'Choose SMS, WhatsApp, or both.' });
      return;
    }
    if (testOnly && !testPhone.trim()) {
      setFeedback({ type: 'error', text: 'Enter the mobile number that should receive the test.' });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message,
          channels: selectedChannels,
          testPhone: testOnly ? testPhone.trim() : undefined
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setFeedback({ type: 'error', text: data.error || 'Twilio did not send the alert.' });
        return;
      }
      setResults(data.results || []);
      const failed = data.failed || 0;
      setFeedback({
        type: failed ? 'error' : 'success',
        text: failed
          ? `Twilio accepted ${data.delivered} message(s) and rejected ${failed}. Read the error on each row. Nothing is marked sent unless Twilio accepted it.`
          : `Twilio accepted all ${data.delivered} message(s). Status "queued" or "sent" means Twilio has the message. Check the phone.`
      });
      load();
    } catch {
      setFeedback({ type: 'error', text: 'The server could not be reached.' });
    } finally {
      setBusy(false);
    }
  };

  const addManager = async (event) => {
    event.preventDefault();
    setFeedback(null);
    try {
      const response = await fetch('/api/admin/warehouse-managers', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(managerForm)
      });
      const data = await response.json();
      if (!response.ok) {
        setFeedback({ type: 'error', text: data.error || 'Could not add the warehouse manager.' });
        return;
      }
      setManagerForm({ fullName: '', username: '', phone: '', password: '' });
      setFeedback({ type: 'success', text: `Warehouse manager ${data.user.username} can now sign in.` });
      load();
    } catch {
      setFeedback({ type: 'error', text: 'The server could not be reached.' });
    }
  };

  const toggleChannel = (name) => setChannels((prev) => ({ ...prev, [name]: !prev[name] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid var(--color-danger)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-danger)', fontSize: '12px', fontWeight: 800 }}>
          <ShieldAlert size={16} />
          ADMIN ONLY
        </div>
        <h2 style={{ fontSize: '24px', marginTop: '6px' }}>Users and phone alerts</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', maxWidth: '760px', lineHeight: 1.6 }}>
          Registered citizens are stored in the local SQLite database. This button asks Twilio to deliver the message to every citizen mobile number, by SMS and WhatsApp. A row is successful only when Twilio accepts it.
        </p>
        <div style={{ display: 'flex', gap: '18px', marginTop: '12px', fontSize: '13px' }}>
          <span>SMS: {status?.twilioSmsReady ? 'ready' : 'missing credentials'}</span>
          <span>WhatsApp: {status?.twilioWhatsappReady ? 'ready' : 'missing sender'}</span>
          <span>Gemini chat: {status?.geminiConfigured ? 'key loaded' : 'paste the key in backend/secrets'}</span>
        </div>
      </div>

      {feedback && (
        <div className="glass-panel" style={{ padding: '14px 16px', display: 'flex', gap: '10px', alignItems: 'flex-start', color: feedback.type === 'success' ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {feedback.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span style={{ fontSize: '13px', lineHeight: 1.5 }}>{feedback.text}</span>
        </div>
      )}

      <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Send size={18} /> Alert every registered citizen</h3>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Paste Twilio values in <code>backend/secrets/twilio.json</code> before sending. Trial accounts can SMS only numbers verified in the Twilio console. WhatsApp sandbox numbers must join the sandbox from the WhatsApp app first. This will text {citizens.length} citizen {citizens.length === 1 ? 'number' : 'numbers'}.
        </p>
        <textarea className="input-field" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
        <div style={{ display: 'flex', gap: '16px', fontSize: '14px' }}>
          <label><input type="checkbox" checked={channels.sms} onChange={() => toggleChannel('sms')} /> SMS</label>
          <label><input type="checkbox" checked={channels.whatsapp} onChange={() => toggleChannel('whatsapp')} /> WhatsApp</label>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input-field" style={{ minWidth: '240px' }} placeholder="Test number, e.g. 9876543210" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
          <button className="btn-secondary" type="button" disabled={busy} onClick={() => sendAlert(true)}>Send test to this number</button>
          <button className="btn-primary" type="button" disabled={busy} onClick={() => sendAlert(false)}>
            {busy ? 'Contacting Twilio...' : `Alert all ${citizens.length} citizens`}
          </button>
        </div>
        {results.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                <th style={{ padding: '8px' }}>Name</th>
                <th style={{ padding: '8px' }}>Phone</th>
                <th style={{ padding: '8px' }}>Channel</th>
                <th style={{ padding: '8px' }}>Twilio result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row, index) => (
                <tr key={`${row.phone}-${row.channel}-${index}`} style={{ borderTop: '1px solid var(--border-muted)' }}>
                  <td style={{ padding: '8px' }}>{row.name}</td>
                  <td style={{ padding: '8px' }}>{row.phone}</td>
                  <td style={{ padding: '8px' }}>{row.channel}</td>
                  <td style={{ padding: '8px', color: row.success ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {row.success ? `${row.status} · ${row.sid}` : row.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="glass-panel" style={{ padding: '20px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}><Users size={18} /> Everyone in the database</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
              <th style={{ padding: '8px' }}>Name</th>
              <th style={{ padding: '8px' }}>Login id</th>
              <th style={{ padding: '8px' }}>Mobile</th>
              <th style={{ padding: '8px' }}>Role</th>
              <th style={{ padding: '8px' }}>Registered</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} style={{ borderTop: '1px solid var(--border-muted)' }}>
                <td style={{ padding: '8px' }}>{user.fullName}</td>
                <td style={{ padding: '8px' }}>{user.username}</td>
                <td style={{ padding: '8px' }}>{user.phone}</td>
                <td style={{ padding: '8px' }}>{ROLE_LABELS[user.role] || user.role}</td>
                <td style={{ padding: '8px' }}>{new Date(user.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        <form className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }} onSubmit={addManager}>
          <h3>Add a warehouse manager</h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Their extra screens can be shaped later. This only creates the login.</p>
          <input className="input-field" placeholder="Full name" value={managerForm.fullName} onChange={(e) => setManagerForm({ ...managerForm, fullName: e.target.value })} required />
          <input className="input-field" placeholder="Login id" value={managerForm.username} onChange={(e) => setManagerForm({ ...managerForm, username: e.target.value })} required />
          <input className="input-field" placeholder="Mobile number" value={managerForm.phone} onChange={(e) => setManagerForm({ ...managerForm, phone: e.target.value })} required />
          <input className="input-field" type="password" placeholder="Password (8+ characters)" value={managerForm.password} onChange={(e) => setManagerForm({ ...managerForm, password: e.target.value })} required />
          <button className="btn-secondary" type="submit">Create warehouse login</button>
        </form>

        <div className="glass-panel" style={{ padding: '20px' }}>
          <h3 style={{ marginBottom: '10px' }}>Recent Twilio attempts</h3>
          {history.length === 0 && <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>No alerts have been sent yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px', overflow: 'auto' }}>
            {history.map((item) => (
              <div key={item.id} style={{ fontSize: '12px', borderBottom: '1px solid var(--border-muted)', paddingBottom: '8px' }}>
                <strong>{item.recipientName}</strong> · {item.recipientPhone} · {item.channel} · {item.status}
                {item.errorMessage ? <div style={{ color: 'var(--color-danger)' }}>{item.errorMessage}</div> : null}
                {item.providerSid ? <div style={{ color: 'var(--text-muted)' }}>{item.providerSid}</div> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
