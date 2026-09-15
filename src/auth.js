'use strict';

/**
 * Account authentication and CSRF protection.
 *
 * The application keeps no server-side session store: on a successful login it
 * issues an HttpOnly cookie holding a signed payload (admin e-mail, CSRF token
 * and expiry) using HMAC-SHA256 with SESSION_SECRET. Sessions survive restarts
 * as long as the secret does.
 *
 * Credentials come from the environment, mirroring the reference project:
 *   ADMIN_LOGIN=admin@example.com,editor@example.com
 *   ADMIN_PASSWORD=a-password,scrypt$<saltHex>$<hashHex>
 * Both lists are comma separated and index aligned. Passwords are accepted
 * either as plain text or as a scrypt hash produced by `npm run hash-password`.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'criminalmap_session';
const LOGIN_CSRF_COOKIE = 'criminalmap_csrf';
const LOGIN_CSRF_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LIFETIME_MINUTES = 720;
const SESSION_SECRET_MIN_LENGTH = 16;

let ephemeralSecret = null;

const AUTH_METHODS = ['account'];

/**
 * Split a comma separated environment variable into a trimmed list.
 *
 * @param {string|undefined} value
 * @returns {string[]}
 */
function parseList(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** @returns {string} the active authentication method ("account"). */
function currentMethod() {
  const method = String(process.env.AUTH_METHOD || 'account').trim().toLowerCase();
  return AUTH_METHODS.includes(method) ? method : 'account';
}

/** @returns {boolean} */
function isAccount() {
  return currentMethod() === 'account';
}

/**
 * Normalize an e-mail address for storage and comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

/**
 * Configured credential pairs.
 *
 * @returns {Array<{login: string, password: string}>}
 */
function accounts() {
  const logins = parseList(process.env.ADMIN_LOGIN);
  const passwords = parseList(process.env.ADMIN_PASSWORD);

  return logins.map((login, index) => ({
    login: normalizeEmail(login),
    password: String(passwords[index] || ''),
  }));
}

/** @returns {boolean} whether at least one usable credential pair exists. */
function credentialsConfigured() {
  return accounts().some((account) => account.login !== '' && account.password !== '');
}

/**
 * Read the session signing secret. When SESSION_SECRET is missing, an ephemeral
 * random secret is generated so the app still boots; every restart then
 * invalidates existing sessions.
 *
 * @returns {string}
 */
function secret() {
  const configured = String(process.env.SESSION_SECRET || '').trim();

  if (configured.length > 0) {
    if (configured.length < SESSION_SECRET_MIN_LENGTH) {
      console.warn(
        `[auth] SESSION_SECRET is shorter than ${SESSION_SECRET_MIN_LENGTH} characters; use a longer random value.`
      );
    }

    return configured;
  }

  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[auth] SESSION_SECRET is not set — using a temporary random secret. Admin sessions are dropped on every restart.'
    );
  }

  return ephemeralSecret;
}

/** @returns {number} the session lifetime in milliseconds. */
function lifetimeMs() {
  const minutes = Number.parseInt(process.env.SESSION_LIFETIME, 10);
  const safeMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_LIFETIME_MINUTES;
  return safeMinutes * 60 * 1000;
}

/**
 * @param {string|Buffer} value
 * @returns {string} the base64url encoding of the value.
 */
function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * @param {string} payload base64url payload to sign.
 * @returns {string} the base64url HMAC-SHA256 signature.
 */
function sign(payload) {
  return base64url(crypto.createHmac('sha256', secret()).update(payload).digest());
}

/**
 * Verify a "payload.signature" token.
 *
 * @param {string} token
 * @returns {Object|null} the decoded payload, or null when invalid/expired.
 */
function verifyToken(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const separator = token.lastIndexOf('.');

  if (separator <= 0) {
    return null;
  }

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));

    if (!decoded || typeof decoded !== 'object') {
      return null;
    }

    if (typeof decoded.exp !== 'number' || decoded.exp <= Date.now()) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

/**
 * Parse the request Cookie header into a plain object.
 *
 * @param {import('express').Request} req
 * @returns {Object<string, string>}
 */
function cookies(req) {
  const header = req.headers && req.headers.cookie;
  const result = {};

  if (typeof header !== 'string' || header === '') {
    return result;
  }

  header.split(';').forEach((pair) => {
    const index = pair.indexOf('=');

    if (index < 0) {
      return;
    }

    const name = pair.slice(0, index).trim();
    const rawValue = pair.slice(index + 1).trim();

    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  });

  return result;
}

/**
 * @param {import('express').Request} req
 * @returns {boolean} whether cookies may be flagged Secure.
 */
function secureCookies(req) {
  const forced = String(process.env.SESSION_SECURE_COOKIE || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(forced) || req.secure === true;
}


/**
 * Hash a password with scrypt using a fresh random salt.
 *
 * @param {string} password
 * @returns {string} "scrypt$<saltHex>$<hashHex>"
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a password against a stored plain text or scrypt value.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || stored === '') {
    return false;
  }

  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');

    if (parts.length !== 3) {
      return false;
    }

    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');

    if (salt.length === 0 || expected.length === 0) {
      return false;
    }

    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  const actual = Buffer.from(String(password));
  const expected = Buffer.from(stored);

  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Check an e-mail/password pair against the configured ADMIN_* lists.
 *
 * @param {string} email
 * @param {string} password
 * @returns {boolean}
 */
function verifyCredentials(email, password) {
  const normalized = normalizeEmail(email);
  const list = accounts();

  for (let index = 0; index < list.length; index += 1) {
    if (list[index].login !== normalized) {
      continue;
    }

    if (list[index].password === '') {
      return false;
    }

    return verifyPassword(password, list[index].password);
  }

  return false;
}

/**
 * Issue an admin session cookie.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} email
 * @returns {Object} the signed session payload.
 */
function issueSession(req, res, email) {
  const payload = {
    email: normalizeEmail(email),
    csrf: crypto.randomBytes(24).toString('hex'),
    exp: Date.now() + lifetimeMs(),
  };
  const encoded = base64url(JSON.stringify(payload));

  res.cookie(SESSION_COOKIE, `${encoded}.${sign(encoded)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/',
    maxAge: lifetimeMs(),
  });

  return payload;
}

/**
 * Read and validate the admin session from the request cookies.
 *
 * @param {import('express').Request} req
 * @returns {Object|null}
 */
function readSession(req) {
  return verifyToken(cookies(req)[SESSION_COOKIE]);
}

/**
 * Remove the admin session cookie.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', secure: secureCookies(req) });
}

/**
 * @param {import('express').Request} req
 * @returns {boolean} whether the request carries a valid admin session.
 */
function isAdmin(req) {
  return Boolean(req.admin);
}

/**
 * Populate req.admin for every request (null when not signed in).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function attachSession(req, res, next) {
  req.admin = readSession(req);
  next();
}

/**
 * @param {import('express').Request} req
 * @returns {string} the CSRF token bound to the current session.
 */
function csrfToken(req) {
  return req.admin && typeof req.admin.csrf === 'string' ? req.admin.csrf : '';
}

/**
 * @param {import('express').Request} req
 * @returns {boolean} true for JSON/API requests.
 */
function wantsJson(req) {
  if (typeof req.path === 'string' && req.path.startsWith('/api/')) {
    return true;
  }

  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

/**
 * Protect admin-only routes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function requireAdmin(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }

  if (wantsJson(req)) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const target = typeof req.originalUrl === 'string' ? req.originalUrl : '/admin';
  return res.redirect(`/auth/login?next=${encodeURIComponent(target)}`);
}

/**
 * Validate the CSRF token of a state-changing admin request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function requireCsrf(req, res, next) {
  const submitted = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
  const expected = csrfToken(req);

  if (expected === '' || submitted.length !== expected.length) {
    return res.status(403).send('Invalid or missing CSRF token. Reload the page and try again.');
  }

  if (!crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
    return res.status(403).send('Invalid or missing CSRF token. Reload the page and try again.');
  }

  return next();
}

/**
 * Issue a short lived CSRF token for the login form (no session exists yet).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {string} the token to embed in the form.
 */
function issueLoginCsrf(req, res) {
  const payload = { csrf: crypto.randomBytes(24).toString('hex'), exp: Date.now() + LOGIN_CSRF_TTL_MS };
  const encoded = base64url(JSON.stringify(payload));

  res.cookie(LOGIN_CSRF_COOKIE, `${encoded}.${sign(encoded)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/',
    maxAge: LOGIN_CSRF_TTL_MS,
  });

  return payload.csrf;
}

/**
 * Validate the login form CSRF token.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function verifyLoginCsrf(req) {
  const payload = verifyToken(cookies(req)[LOGIN_CSRF_COOKIE]);
  const submitted = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';

  if (!payload || typeof payload.csrf !== 'string' || submitted.length === 0) {
    return false;
  }

  if (submitted.length !== payload.csrf.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(payload.csrf));
}

/**
 * Remove the login CSRF cookie.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function clearLoginCsrf(req, res) {
  res.clearCookie(LOGIN_CSRF_COOKIE, { path: '/', sameSite: 'lax', secure: secureCookies(req) });
}

module.exports = {
  LOGIN_CSRF_COOKIE,
  SESSION_COOKIE,
  accounts,
  attachSession,
  clearLoginCsrf,
  clearSession,
  credentialsConfigured,
  csrfToken,
  currentMethod,
  hashPassword,
  isAccount,
  isAdmin,
  issueLoginCsrf,
  issueSession,
  normalizeEmail,
  readSession,
  requireAdmin,
  requireCsrf,
  secureCookies,
  verifyCredentials,
  verifyLoginCsrf,
  verifyPassword,
  wantsJson,
};

