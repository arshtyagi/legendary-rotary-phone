'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  sessionManager.js
 *
 *  Responsibilities
 *  ────────────────
 *  • Maintains a pool of up to 4 Apollo account sessions.
 *  • Staggers logins 20 minutes apart so sessions never expire simultaneously.
 *  • Returns a healthy session via getValidSession() with < 1 ms overhead
 *    once sessions are warm (no login per request).
 *  • Auto-refreshes sessions 5 minutes before TTL expiry.
 *  • On 401/403 from Apollo it invalidates & re-logins transparently.
 *  • Rotates accounts in round-robin to distribute load / rate-limit risk.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { loginToApollo }  = require('./auth');
const logger             = require('./utils/logger');
const { sleep }          = require('./utils/httpClient');

const SESSION_TTL_MS          = Number(process.env.SESSION_TTL_MS)           || 3_600_000; // 1 h
const SESSION_REFRESH_BUFFER  = Number(process.env.SESSION_REFRESH_BUFFER_MS) || 300_000;  // 5 min
const LOGIN_STAGGER_INTERVAL  = Number(process.env.LOGIN_STAGGER_INTERVAL_MS) || 1_200_000; // 20 min
const HEALTH_CHECK_INTERVAL   = 60_000; // check session health every 1 min

// ── Load accounts from .env ───────────────────────────────────────────────────
function loadAccounts() {
  const emails    = (process.env.APOLLO_EMAILS    || '').split(',').map(s => s.trim()).filter(Boolean);
  const passwords = (process.env.APOLLO_PASSWORDS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!emails.length) throw new Error('No APOLLO_EMAILS defined in .env');

  return emails.map((email, i) => ({
    email,
    password:  passwords[i] || '',
    accountId: `account_${i + 1}`,
  }));
}

// ── Session store ─────────────────────────────────────────────────────────────
// Map<accountId, SessionData | null>
const sessions = new Map();
let accounts   = [];
let rrIndex    = 0; // round-robin pointer

// Tracks which accounts are currently logging in (prevents duplicate logins)
const loginInProgress = new Map(); // accountId → Promise<SessionData>

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bootstrap the session manager.
 * • Loads accounts.
 * • Initiates staggered logins.
 * • Starts background health-check loop.
 */
async function init() {
  accounts = loadAccounts();
  logger.info(`SessionManager: loaded ${accounts.length} account(s)`);

  // Kick off first login immediately, rest staggered
  for (let i = 0; i < accounts.length; i++) {
    if (i === 0) {
      _loginAccount(accounts[0]).catch(err =>
        logger.error('Initial login failed', { account: accounts[0].accountId, err: err.message })
      );
    } else {
      const delay = i * LOGIN_STAGGER_INTERVAL;
      setTimeout(() => {
        _loginAccount(accounts[i]).catch(err =>
          logger.error('Staggered login failed', { account: accounts[i].accountId, err: err.message })
        );
      }, delay);
      logger.info(`Account ${accounts[i].accountId} scheduled to login in ${delay / 60_000} min`);
    }
  }

  // Background health-check
  setInterval(_healthCheck, HEALTH_CHECK_INTERVAL).unref();
}

/**
 * Return a valid session object ready to use for an API call.
 * Blocks (briefly) only if no sessions are available yet — otherwise returns immediately.
 *
 * @returns {Promise<{ cookieHeader: string, headers: object, accountId: string, client: AxiosInstance }>}
 */
async function getValidSession() {
  // Fast-path: find a live session in round-robin order
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const acc     = accounts[rrIndex % accounts.length];
    rrIndex++;
    const session = sessions.get(acc.accountId);

    if (session && _isAlive(session)) {
      return _toPublic(session);
    }
  }

  // No ready session — wait for any login in progress
  const inProgress = [...loginInProgress.values()];
  if (inProgress.length) {
    logger.warn('No ready session — waiting for login in progress');
    const session = await inProgress[0];
    return _toPublic(session);
  }

  // All sessions expired or never started — trigger emergency login
  logger.warn('All sessions expired — triggering emergency re-login');
  const acc     = accounts[rrIndex % accounts.length];
  const session = await _loginAccount(acc);
  return _toPublic(session);
}

/**
 * Mark a session as invalid (called after receiving 401/403 from Apollo).
 * Triggers an async re-login for that account.
 *
 * @param {string} accountId
 */
function invalidateSession(accountId) {
  logger.warn('Invalidating session', { accountId });
  sessions.delete(accountId);

  const acc = accounts.find(a => a.accountId === accountId);
  if (acc) {
    _loginAccount(acc).catch(err =>
      logger.error('Re-login after invalidation failed', { accountId, err: err.message })
    );
  }
}

/**
 * Return current session health metrics (for monitoring).
 */
function getMetrics() {
  const now = Date.now();
  return accounts.map(acc => {
    const s   = sessions.get(acc.accountId);
    const ttl = s ? Math.max(0, SESSION_TTL_MS - (now - s.createdAt)) : 0;
    return {
      accountId: acc.accountId,
      status:    s ? (_isAlive(s) ? 'alive' : 'expired') : 'none',
      ttlMs:     ttl,
      loginInProgress: loginInProgress.has(acc.accountId),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _isAlive(session) {
  return (Date.now() - session.createdAt) < SESSION_TTL_MS;
}

function _isNearExpiry(session) {
  return (Date.now() - session.createdAt) >= (SESSION_TTL_MS - SESSION_REFRESH_BUFFER);
}

function _toPublic(session) {
  return {
    cookieHeader: session.cookieHeader,
    headers:      session.headers,
    accountId:    session.accountId,
    client:       session.client,
  };
}

async function _loginAccount(acc) {
  // De-duplicate concurrent login attempts for the same account
  if (loginInProgress.has(acc.accountId)) {
    return loginInProgress.get(acc.accountId);
  }

  const promise = (async () => {
    const MAX_RETRIES = 3;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const session = await loginToApollo(acc);
        sessions.set(acc.accountId, session);
        logger.info('Session stored', { accountId: acc.accountId });

        // Schedule proactive refresh before expiry
        const refreshIn = SESSION_TTL_MS - SESSION_REFRESH_BUFFER;
        setTimeout(() => _proactiveRefresh(acc), refreshIn).unref();

        return session;
      } catch (err) {
        lastErr = err;
        logger.error('Login attempt failed', { accountId: acc.accountId, attempt, err: err.message, stack: err.stack });
        if (attempt < MAX_RETRIES) await sleep(5_000 * attempt);
      }
    }

    throw lastErr;
  })();

  loginInProgress.set(acc.accountId, promise);
  promise.finally(() => loginInProgress.delete(acc.accountId));

  return promise;
}

async function _proactiveRefresh(acc) {
  const session = sessions.get(acc.accountId);
  if (!session || !_isNearExpiry(session)) return; // already refreshed elsewhere

  logger.info('Proactive session refresh', { accountId: acc.accountId });
  _loginAccount(acc).catch(err =>
    logger.error('Proactive refresh failed', { accountId: acc.accountId, err: err.message })
  );
}

async function _healthCheck() {
  for (const acc of accounts) {
    const session = sessions.get(acc.accountId);
    if (!session) continue;

    if (_isNearExpiry(session) && !loginInProgress.has(acc.accountId)) {
      logger.info('Health check: session near expiry — refreshing', { accountId: acc.accountId });
      _loginAccount(acc).catch(err =>
        logger.error('Health-check refresh failed', { accountId: acc.accountId, err: err.message })
      );
    }
  }
}

module.exports = { init, getValidSession, invalidateSession, getMetrics };
