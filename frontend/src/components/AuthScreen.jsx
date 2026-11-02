import React, { useState } from 'react';
import { saveSession } from '../utils/authClient';
import { Waves } from 'lucide-react';

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

  const FieldLabel = ({ children }) => (
    <span style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px', display: 'block' }}>
      {children}
    </span>
  );

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(160deg, #C8E8F5 0%, #EBF4FA 40%, #F0F7FB 100%)',
      padding: '24px'
    }}>
      <div style={{
        width: 'min(480px, 100%)',
        background: '#FFFFFF',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: '0 16px 48px rgba(18,48,71,0.12)',
        padding: '36px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '4px' }}>
          <div style={{
            width: '52px',
            height: '52px',
            background: 'var(--color-primary)',
            borderRadius: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 14px',
            fontSize: '26px'
          }}>🌊</div>
          <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
            FloatChat AI
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Ocean Intelligence &amp; Emergency Management Platform
          </div>
        </div>

        {/* Mode switcher */}
        <div style={{
          display: 'flex',
          background: 'var(--bg-page)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '4px',
          gap: '4px'
        }}>
          {['login', 'register'].map(m => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(''); }}
              style={{
                flex: 1,
                padding: '8px',
                borderRadius: '7px',
                border: 'none',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'var(--transition)',
                background: mode === m ? '#FFFFFF' : 'transparent',
                color: mode === m ? 'var(--color-primary)' : 'var(--text-secondary)',
                boxShadow: mode === m ? 'var(--shadow-sm)' : 'none'
              }}
            >
              {m === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {mode === 'register' && (
            <>
              <div>
                <FieldLabel>Full name</FieldLabel>
                <input
                  className="input-field"
                  placeholder="Your full name"
                  value={registerForm.fullName}
                  onChange={e => setRegisterForm({ ...registerForm, fullName: e.target.value })}
                  required
                />
              </div>
              <div>
                <FieldLabel>Mobile number for alerts</FieldLabel>
                <input
                  className="input-field"
                  placeholder="9876543210 or +919876543210"
                  value={registerForm.phone}
                  onChange={e => setRegisterForm({ ...registerForm, phone: e.target.value })}
                  required
                />
              </div>
            </>
          )}

          <div>
            <FieldLabel>Login ID</FieldLabel>
            <input
              className="input-field"
              autoComplete="username"
              placeholder="Username"
              value={mode === 'login' ? loginForm.username : registerForm.username}
              onChange={e => mode === 'login'
                ? setLoginForm({ ...loginForm, username: e.target.value })
                : setRegisterForm({ ...registerForm, username: e.target.value })}
              required
            />
          </div>

          <div>
            <FieldLabel>Password</FieldLabel>
            <input
              className="input-field"
              type="password"
              placeholder="Enter your password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={mode === 'login' ? loginForm.password : registerForm.password}
              onChange={e => mode === 'login'
                ? setLoginForm({ ...loginForm, password: e.target.value })
                : setRegisterForm({ ...registerForm, password: e.target.value })}
              required
            />
          </div>

          {mode === 'register' && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
              A 10-digit Indian number is stored as +91. This is the number admin alerts will text. Warehouse manager accounts are created by the admin.
            </p>
          )}

          {error && (
            <div style={{ 
              padding: '10px 12px', 
              background: 'var(--color-danger-bg)', 
              border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-danger)', 
              fontSize: '13px', 
              lineHeight: 1.5 
            }}>
              {error}
            </div>
          )}

          <button className="btn-primary" type="submit" disabled={busy} style={{ justifyContent: 'center', width: '100%', padding: '11px' }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {/* Seeded accounts */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '5px', fontSize: '12px' }}>Demo accounts</div>
          <div>Admin — <strong>admin</strong> / <strong>FloatChatAdmin@2026</strong></div>
          <div>Warehouse — <strong>warehouse</strong> / <strong>FloatChatWarehouse@2026</strong></div>
        </div>
      </div>
    </div>
  );
}
