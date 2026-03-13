'use strict';

const { chromium } = require('playwright');
const { createHttpClient, sleep } = require('./utils/httpClient');
const { waitForOtp } = require('./imapOtp');
const logger = require('./utils/logger');

const APOLLO_BASE = process.env.APOLLO_HOST || 'https://app.apollo.io';
const PROXY_URL   = process.env.PROXY_URL   || null;

function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: u.username || undefined, password: u.password || undefined };
  } catch { return undefined; }
}

async function loginToApollo(account) {
  const { email, password, accountId } = account;
  logger.info('Starting Apollo login via Playwright', { accountId });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  });

  const context = await browser.newContext({
    ...(parseProxy(PROXY_URL) ? { proxy: parseProxy(PROXY_URL) } : {}),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  page.on('framenavigated', f => { if (f === page.mainFrame()) logger.info('Nav', { url: f.url() }); });

  try {
    logger.info('Loading login page', { accountId });
    await page.goto(`${APOLLO_BASE}/#/login`, { waitUntil: 'networkidle', timeout: 60_000 });
    await sleep(1500);

    // Fill email
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    await page.waitForSelector(emailSel, { timeout: 30_000 });
    await page.fill(emailSel, email);
    await sleep(300);

    // Fill password
    await page.waitForSelector('input[type="password"]', { timeout: 10_000 });
    await page.fill('input[type="password"]', password);
    await sleep(300);

    // Click login — try multiple methods
    logger.info('Clicking Log In', { accountId });
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Log In');
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clicked) {
      await page.focus('input[type="password"]');
      await page.keyboard.press('Enter');
    }

    logger.info('Waiting for post-login navigation', { accountId });

    // Wait up to 3 min for redirect
    await page.waitForURL(url => !url.includes('/login'), { timeout: 180_000 })
      .catch(() => logger.warn('No redirect yet — checking for OTP'));

    await sleep(1000);
    logger.info('Post-login URL', { url: page.url() });

    // OTP check
    const otpVisible = await page.isVisible('input[placeholder*="code" i], input[name*="otp" i], input[placeholder*="otp" i]').catch(() => false);
    if (otpVisible) {
      logger.info('OTP required — fetching from Gmail', { accountId });
      const otp = await waitForOtp(email);
      logger.info('OTP received — submitting', { accountId });
      await page.fill('input[placeholder*="code" i], input[name*="otp" i], input[placeholder*="otp" i]', otp);
      await page.click('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit")');
      await sleep(2000);
      await page.waitForURL(url => !url.includes('/login'), { timeout: 60_000 }).catch(() => {});
      logger.info('OTP submitted', { accountId });
    }

    logger.info('Login complete', { url: page.url(), accountId });

    // Extract cookies
    const browserCookies = await context.cookies();
    logger.info('Cookies extracted', { count: browserCookies.length });
    const cookieHeader = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Get CSRF token
    let csrfToken = null;
    try {
      const resp = await page.evaluate(async (base) => {
        const r = await fetch(`${base}/api/v1/auth/ping`, { credentials: 'include', headers: { Accept: 'application/json' } });
        return { csrf: r.headers.get('x-csrf-token'), status: r.status, body: await r.json().catch(() => null) };
      }, APOLLO_BASE);
      csrfToken = resp.csrf || resp.body?.csrf_token || null;
      logger.info('CSRF', { status: resp.status, hasCsrf: !!csrfToken });
    } catch (err) {
      logger.warn('Ping failed', { err: err.message });
    }

    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    const { client, jar } = createHttpClient(PROXY_URL);
    for (const c of browserCookies) {
      await jar.setCookie(`${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path || '/'}`, APOLLO_BASE).catch(() => {});
    }

    return {
      accountId,
      cookieHeader,
      headers: {
        'Content-Type':       'application/json',
        'Accept':             '*/*',
        'Origin':             APOLLO_BASE,
        'Referer':            `${APOLLO_BASE}/`,
        'User-Agent':         userAgent,
        'x-referer-host':     'app.apollo.io',
        'x-accept-language':  'en',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      jar,
      client,
      createdAt: Date.now(),
    };

  } finally {
    await browser.close();
  }
}

module.exports = { loginToApollo };
