import crypto from 'crypto';
import { authenticate, changePassword, getPublicUserById } from './db.js';
import { getSessionSecret } from './secrets.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signToken(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    role: user.role,
    exp: Date.now() + TOKEN_TTL_MS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.sub || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Please log in again.' });
  const user = getPublicUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'This account is no longer available.' });
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'You do not have access to this.' });
      }
      next();
    });
  };
}

export { authenticate, changePassword };
