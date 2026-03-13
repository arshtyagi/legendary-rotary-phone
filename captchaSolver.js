'use strict';

const axios = require('axios');
const logger = require('./utils/logger');

const CAPSOLVER_BASE  = 'https://api.capsolver.com';
const API_KEY         = process.env.CAPSOLVER_API_KEY;
const POLL_INTERVAL   = 3_000;  // ms between balance / status checks
const MAX_WAIT        = 120_000; // 2 min max solve time

/**
 * Solve a Cloudflare Turnstile challenge.
 *
 * @param {string} pageUrl   Page where Turnstile appears
 * @param {string} siteKey   Turnstile site key
 * @returns {Promise<string>} The cfTurnstileResponse token
 */
async function solveTurnstile(pageUrl, siteKey) {
  logger.info('Requesting Turnstile solve', { pageUrl });

  const taskId = await createTask({
    type:    'AntiTurnstileTaskProxyLess',
    websiteURL: pageUrl,
    websiteKey:  siteKey,
    metadata: { action: 'managed' },
  });

  return await pollForResult(taskId);
}

/**
 * Solve an hCaptcha challenge.
 */
async function solveHCaptcha(pageUrl, siteKey) {
  logger.info('Requesting hCaptcha solve', { pageUrl });

  const taskId = await createTask({
    type:        'HCaptchaTaskProxyLess',
    websiteURL:  pageUrl,
    websiteKey:  siteKey,
  });

  const result = await pollForResult(taskId);
  return result; // returns { gRecaptchaResponse, ... }
}

/**
 * Solve a reCAPTCHA v2 challenge.
 */
async function solveRecaptchaV2(pageUrl, siteKey) {
  logger.info('Requesting reCAPTCHA v2 solve', { pageUrl });

  const taskId = await createTask({
    type:        'ReCaptchaV2TaskProxyLess',
    websiteURL:  pageUrl,
    websiteKey:  siteKey,
  });

  return await pollForResult(taskId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function createTask(task) {
  const resp = await axios.post(`${CAPSOLVER_BASE}/createTask`, {
    clientKey: API_KEY,
    task,
  }, { timeout: 15_000 });

  const data = resp.data;

  if (data.errorId !== 0) {
    throw new Error(`CapSolver createTask error [${data.errorCode}]: ${data.errorDescription}`);
  }

  logger.info('CapSolver task created', { taskId: data.taskId });
  return data.taskId;
}

async function pollForResult(taskId) {
  const deadline = Date.now() + MAX_WAIT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const resp = await axios.post(`${CAPSOLVER_BASE}/getTaskResult`, {
      clientKey: API_KEY,
      taskId,
    }, { timeout: 15_000 });

    const data = resp.data;

    if (data.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult error [${data.errorCode}]: ${data.errorDescription}`);
    }

    if (data.status === 'ready') {
      logger.info('CapSolver task solved');
      return data.solution?.token
        ?? data.solution?.gRecaptchaResponse
        ?? data.solution;
    }

    if (data.status === 'failed') {
      throw new Error('CapSolver task failed');
    }

    // status === 'processing' — keep polling
  }

  throw new Error(`CapSolver timeout after ${MAX_WAIT}ms for task ${taskId}`);
}

/**
 * Detect whether an Axios response body contains a Cloudflare / captcha challenge.
 * Returns: 'turnstile' | 'hcaptcha' | 'recaptcha' | null
 */
function detectChallenge(responseData) {
  const body = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData ?? '');

  if (/cf-turnstile|turnstile\.cloudflare\.com/i.test(body))  return 'turnstile';
  if (/hcaptcha\.com\/captcha/i.test(body))                   return 'hcaptcha';
  if (/google\.com\/recaptcha/i.test(body))                   return 'recaptcha';
  return null;
}

module.exports = { solveTurnstile, solveHCaptcha, solveRecaptchaV2, detectChallenge };
