'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { ProxyAgent } = require('proxy-agent');
const http = require('http');
const https = require('https');

// ─── Shared keep-alive agents (reused across requests for speed) ──────────────
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, rejectUnauthorized: true });

/**
 * Build a cookiejar-enabled axios instance.
 * Each session gets its own jar so cookies stay isolated.
 *
 * @param {string|null} proxyUrl  Optional proxy URL
 * @returns {{ client: AxiosInstance, jar: CookieJar }}
 */
function createHttpClient(proxyUrl = null) {
  const jar = new CookieJar();

  let agent = null;
  if (proxyUrl) {
    agent = new ProxyAgent(proxyUrl);
  }

  const instance = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 30_000,
      maxRedirects: 10,
      httpAgent:  agent || httpAgent,
      httpsAgent: agent || httpsAgent,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    })
  );

  // ── Global request interceptor: inject dynamic headers ────────────────────
  instance.interceptors.request.use(config => {
    if (!config.headers['Referer']) {
      config.headers['Referer'] = 'https://app.apollo.io/';
    }
    return config;
  });

  return { client: instance, jar };
}

/**
 * Serialize a CookieJar to a plain string for storage.
 */
async function serializeJar(jar) {
  return JSON.stringify(await jar.serialize());
}

/**
 * Deserialize a previously serialized jar string.
 */
async function deserializeJar(serialized) {
  const jar = await CookieJar.deserialize(JSON.parse(serialized));
  return jar;
}

/**
 * Simple sleep helper.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { createHttpClient, serializeJar, deserializeJar, sleep };
