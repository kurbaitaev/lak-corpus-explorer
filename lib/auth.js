'use strict';

// Account authentication + identity resolution.
// The legacy reviewer-passphrase session (cookie `reviewer_session`) is
// preserved untouched and maps to the administrator role; contributor
// accounts use a separate signed cookie `lak_session`.

const crypto = require('crypto');

const SESSION_SECRET  = process.env.SESSION_SECRET;
const ACCOUNT_COOKIE  = 'lak_session';
const REVIEWER_COOKIE = 'reviewer_session';
const COOKIE_MAX_AGE  = 30 * 24 * 3600; // 30 days, matches legacy session

const ROLES        = ['contributor', 'trusted_validator', 'verified_expert', 'administrator'];
const TRUSTED_PLUS = ['trusted_validator', 'verified_expert', 'administrator'];
const EXPERT_PLUS  = ['verified_expert', 'administrator'];

function sign(p) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
}

function makeCookieValue(obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${p}.${sign(p)}`;
}

function readSignedCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(/;\s*/).find(c => c.startsWith(name + '='));
  if (!match) return null;
  const val = decodeURIComponent(match.slice(name.length + 1));
  const dot = val.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = val.slice(0, dot);
  const sig = val.slice(dot + 1);
  const expect = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
}

function readAccountSession(req) {
  const s = readSignedCookie(req, ACCOUNT_COOKIE);
  return s && typeof s.aid === 'string' && s.aid ? s : null;
}

// Same algorithm as the legacy reviewer session in server.js (preserved).
function readReviewerSession(req) {
  const s = readSignedCookie(req, REVIEWER_COOKIE);
  return s && typeof s.name === 'string' && s.name ? s : null;
}

function setAccountCookie(res, account) {
  const value = makeCookieValue({ aid: account.id, name: account.display_name, role: account.role });
  res.setHeader('Set-Cookie',
    `${ACCOUNT_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
}

function clearAccountCookie(res) {
  res.setHeader('Set-Cookie', `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Resolve the caller's identity. Account sessions win when both exist
// (contributor actions need an account id); a legacy reviewer session maps
// to the administrator role.
function getIdentity(req) {
  const account = readAccountSession(req);
  if (account) {
    return { type: 'account', id: account.aid, name: account.name, role: account.role };
  }
  const reviewer = readReviewerSession(req);
  if (reviewer) {
    return { type: 'reviewer', id: null, name: reviewer.name, role: 'administrator' };
  }
  return null;
}

// scrypt password hashing (built-in, no native deps)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

// ── Middleware factories (need the pool for fresh role checks) ──
function makeMiddleware(pool) {
  async function freshRole(contributorId) {
    const r = await pool.query('SELECT role FROM contributors WHERE id = $1', [contributorId]);
    return r.rows[0] ? r.rows[0].role : null;
  }

  function requireAccount(req, res, next) {
    const identity = getIdentity(req);
    if (!identity || identity.type !== 'account') {
      return res.status(401).json({
        error: 'A free contributor account is required for validation. Register or log in first.',
      });
    }
    req.identity = identity;
    next();
  }

  function requireRole(roles) {
    return async (req, res, next) => {
      const identity = getIdentity(req);
      if (!identity) {
        return res.status(401).json({ error: 'Login required.' });
      }
      let role = identity.role;
      if (identity.type === 'account') {
        // Re-check the role from the DB so grants/revocations apply immediately.
        role = await freshRole(identity.id);
        if (!role) return res.status(401).json({ error: 'Account not found.' });
        identity.role = role;
      }
      if (!roles.includes(role)) {
        return res.status(403).json({
          error: `This action requires one of these roles: ${roles.join(', ')}.`,
        });
      }
      req.identity = identity;
      next();
    };
  }

  // Simple in-memory IP rate limiter for auth endpoints.
  function makeRateLimiter(max, windowMs, message) {
    const hits = new Map();
    setInterval(() => {
      const cutoff = Date.now() - windowMs;
      for (const [k, arr] of hits) {
        const kept = arr.filter(t => t > cutoff);
        if (kept.length) hits.set(k, kept); else hits.delete(k);
      }
    }, windowMs).unref();
    return (req, res, next) => {
      const key = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const arr = (hits.get(key) || []).filter(t => t > now - windowMs);
      if (arr.length >= max) {
        return res.status(429).json({ error: message || 'Too many attempts. Please wait and try again.' });
      }
      arr.push(now);
      hits.set(key, arr);
      next();
    };
  }

  return { requireAccount, requireRole, makeRateLimiter };
}

module.exports = {
  ROLES, TRUSTED_PLUS, EXPERT_PLUS,
  readAccountSession, readReviewerSession,
  setAccountCookie, clearAccountCookie,
  getIdentity, hashPassword, verifyPassword,
  makeMiddleware,
};
