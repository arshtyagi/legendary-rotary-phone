'use strict';

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { HttpsProxyAgent } = require('https-proxy-agent');

function createHttpClient(proxyUrl = null) {
  const jar = new CookieJar();
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

  const instance = axios.create({
    timeout: 30_000,
    maxRedirects: 10,
    proxy: false,
    ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Manually inject cookies from jar into every request
  instance.interceptors.request.use(async cfg => {
    if (!cfg.headers['Referer']) cfg.headers['Referer'] = 'https://app.apollo.io/';
    try {
      const url = cfg.url?.startsWith('http') ? cfg.url : `https://app.apollo.io${cfg.url}`;
      const cookieString = await jar.getCookieString(url);
      if (cookieString) {
        // Merge with any manually set Cookie header
        const existing = cfg.headers['Cookie'] || cfg.headers['cookie'] || '';
        cfg.headers['Cookie'] = existing
          ? `${existing}; ${cookieString}`
          : cookieString;
      }
    } catch { /* ignore */ }
    return cfg;
  });

  // Manually store Set-Cookie headers from every response into jar
  instance.interceptors.response.use(async resp => {
    try {
      const setCookie = resp.headers['set-cookie'];
      if (setCookie) {
        const url = resp.config?.url?.startsWith('http')
          ? resp.config.url
          : `https://app.apollo.io${resp.config?.url}`;
        for (const cookie of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
          await jar.setCookie(cookie, url).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    return resp;
  }, async err => {
    try {
      const setCookie = err.response?.headers?.['set-cookie'];
      if (setCookie) {
        const url = err.response?.config?.url?.startsWith('http')
          ? err.response.config.url
          : `https://app.apollo.io${err.response?.config?.url}`;
        for (const cookie of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
          await jar.setCookie(cookie, url).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    return Promise.reject(err);
  });

  return { client: instance, jar };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function serializeJar(jar) {
  return JSON.stringify(await jar.serialize());
}

async function deserializeJar(serialized) {
  return CookieJar.deserialize(JSON.parse(serialized));
}

module.exports = { createHttpClient, serializeJar, deserializeJar, sleep };
