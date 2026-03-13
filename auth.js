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
    // Step 1: Load login page
    logger.info('Loading login page', { accountId });
    await page.goto(`${APOLLO_BASE}/#/login`, { waitUntil: 'networkidle', timeout: 60_000 });
    await sleep(2000);

    // Step 2: Fill form
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    await page.waitForSelector(emailSel, { timeout: 30_000 });
    await page.fill(emailSel, email);
    await sleep(300);
    await page.waitForSelector('input[type="password"]', { timeout: 10_000 });
    await page.fill('input[type="password"]', password);
    await sleep(300);

    // Step 3: Click login — multiple methods
    logger.info('Clicking Log In', { accountId });

    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Log In');
      if (btn) { btn.click(); return true; }
      return false;
    });
    await sleep(2000);

    if (page.url().includes('/login') && !page.url().includes('/ato/')) {
      await page.focus('input[type="password"]');
      await page.keyboard.press('Enter');
      await sleep(2000);
    }

    if (page.url().includes('/login') && !page.url().includes('/ato/')) {
      const btn = await page.$('button:has-text("Log In")');
      if (btn) {
        const box = await btn.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await sleep(2000);
    }

    logger.info('After click', { url: page.url(), clicked });

    // Step 4: Wait up to 30s for OTP page or home page
    logger.info('Waiting for OTP or home page', { accountId });
    const startWait = Date.now();
    while (Date.now() - startWait < 30_000) {
      await sleep(1000);
      const url = page.url();
      if (url.includes('/ato/') || url.includes('verify')) {
        logger.info('OTP page detected', { url });
        break;
      }
      if (!url.includes('/login')) {
        logger.info('Home page detected', { url });
        break;
      }
    }

    const urlAfterWait = page.url();
    logger.info('URL after wait', { url: urlAfterWait });

    // Step 5: Handle OTP if needed
    if (urlAfterWait.includes('/ato/') || urlAfterWait.includes('verify')) {
      logger.info('OTP required — fetching from Gmail', { accountId });
      const otp = await waitForOtp(email);
      logger.info('OTP received — submitting', { accountId });

      const otpSel = 'input[placeholder*="code" i], input[name*="otp" i], input[placeholder*="otp" i], input[type="tel"], input[inputmode="numeric"]';
      await page.waitForSelector(otpSel, { timeout: 15_000 });
      await page.fill(otpSel, otp);
      await sleep(500);
      await page.click('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Continue")');
      logger.info('OTP submitted — waiting for home page', { accountId });

      // Wait for redirect to home
      await page.waitForURL(
        url => !url.includes('/login') && !url.includes('/ato/') && !url.includes('verify'),
        { timeout: 60_000 }
      ).catch(() => logger.warn('Post-OTP redirect timeout'));

      await sleep(2000);
      logger.info('Post-OTP URL', { url: page.url() });
    }

    // Step 6: Verify we are logged in
    const finalUrl = page.url();
    logger.info('Final login URL', { url: finalUrl, accountId });

    if (finalUrl.includes('/login') && !finalUrl.includes('/ato/')) {
      throw new Error('Login failed — still on login page after all attempts');
    }

    // Step 7: Extract cookies
    const browserCookies = await context.cookies();
    logger.info('Cookies extracted', { count: browserCookies.length });
    const cookieHeader = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Step 8: Get CSRF token
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

    logger.info('✅ Login complete', { accountId, url: finalUrl });
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
