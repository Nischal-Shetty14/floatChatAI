import React, { useState } from 'react';
import { saveSession } from '../utils/authClient';

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [registerForm, setRegisterForm] = useState({
    fullName: '',
    username: '',
    phone: '',
    password: ''
  });

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const isLogin = mode === 'login';
      const response = await fetch(isLogin ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isLogin ? loginForm : registerForm)
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Could not sign you in.');
        return;
      }
      const session = { token: data.token, user: data.user };
      saveSession(session);
      onAuthenticated(session);
    } catch {
      setError('The FloatChat server is not reachable. Start it with npm run dev.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px' }}>
      <div className="glass-panel" style={{ width: 'min(520px, 100%)', padding: '28px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div>
          <div className="logo-section" style={{ marginBottom: '8px' }}>
            <span className="logo-icon">🌊</span>
            <span className="logo-text gradient-text">FloatChat AI</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
            Sign in to the coastal alert console. Citizens register with the mobile number that should receive SMS and WhatsApp alerts.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className={mode === 'login' ? 'btn-primary' : 'btn-secondary'} onClick={() => { setMode('login'); setError(''); }}>
            Sign in
          </button>
          <button type="button" className={mode === 'register' ? 'btn-primary' : 'btn-secondary'} onClick={() => { setMode('register'); setError(''); }}>
            Register as citizen
          </button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {mode === 'register' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                Full name
                <input className="input-field" value={registerForm.fullName} onChange={(e) => setRegisterForm({ ...registerForm, fullName: e.target.value })} required />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                Mobile number for alerts
                <input className="input-field" placeholder="9876543210 or +919876543210" value={registerForm.phone} onChange={(e) => setRegisterForm({ ...registerForm, phone: e.target.value })} required />
              </label>
            </>
          )}

          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Login id
            <input
              className="input-field"
              autoComplete="username"
              value={mode === 'login' ? loginForm.username : registerForm.username}
              onChange={(e) => mode === 'login'
                ? setLoginForm({ ...loginForm, username: e.target.value })
                : setRegisterForm({ ...registerForm, username: e.target.value })}
              required
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Password
            <input
              className="input-field"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={mode === 'login' ? loginForm.password : registerForm.password}
              onChange={(e) => mode === 'login'
                ? setLoginForm({ ...loginForm, password: e.target.value })
                : setRegisterForm({ ...registerForm, password: e.target.value })}
              required
            />
          </label>

          {mode === 'register' && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              A 10-digit Indian number is stored as +91. This is the number the admin alert will text and WhatsApp. Warehouse managers are added by the admin, not from this form.
            </p>
          )}

          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '13px', lineHeight: 1.5 }}>{error}</div>
          )}

          <button className="btn-primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy ? 'Please wait...' : mode === 'login' ? 'Enter console' : 'Create citizen account'}
          </button>
        </form>

        <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: '14px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Seeded accounts</div>
          <div>Admin — login id <strong>admin</strong> — password <strong>FloatChatAdmin@2026</strong></div>
          <div>Warehouse manager — login id <strong>warehouse</strong> — password <strong>FloatChatWarehouse@2026</strong></div>
          <div style={{ marginTop: '6px' }}>Only one admin exists. Change the password from the sidebar after you sign in.</div>
        </div>
      </div>
    </div>
  );
}
