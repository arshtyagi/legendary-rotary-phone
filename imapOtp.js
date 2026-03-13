'use strict';

const { ImapFlow } = require('imapflow');
const logger = require('./utils/logger');

const IMAP_CONFIG = {
  host:   'imap.gmail.com',
  port:   993,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  logger: false,           // silence imapflow's internal logger
  tls: { rejectUnauthorized: true },
};

// OTP patterns: 6-digit numeric codes from Apollo emails
const OTP_PATTERNS = [
  /(?:verification|confirmation|one.?time|otp|code)[^\d]{0,40}(\d{6})/i,
  /(?:enter|use|your)[\s\S]{0,30}(\d{6})[\s\S]{0,30}(?:to|code|verify)/i,
  /\b(\d{6})\b/,           // fallback: any standalone 6-digit number
];

/**
 * Extract a 6-digit OTP from email body text.
 */
function extractOtp(text) {
  for (const pattern of OTP_PATTERNS) {
    const m = text.match(pattern);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Wait for a new OTP email from Apollo in the Gmail inbox.
 * Polls until the code arrives or timeout is reached.
 *
 * @param {string} apolloEmail  The Apollo account email we logged in with
 * @param {number} timeoutMs    Max wait time in ms (default 90s)
 * @param {number} pollIntervalMs
 * @returns {Promise<string>} 6-digit OTP string
 */
async function waitForOtp(apolloEmail, timeoutMs = 90_000, pollIntervalMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  const sinceDate = new Date(Date.now() - 120_000); // look back 2 min to catch race conditions

  logger.info('Waiting for OTP email', { apolloEmail });

  while (Date.now() < deadline) {
    const otp = await fetchLatestOtp(apolloEmail, sinceDate);
    if (otp) {
      logger.info('OTP received successfully');
      return otp;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`OTP timeout after ${timeoutMs}ms for ${apolloEmail}`);
}

/**
 * Connect to Gmail via IMAP and fetch the latest Apollo OTP email.
 */
async function fetchLatestOtp(apolloEmail, sinceDate) {
  const client = new ImapFlow(IMAP_CONFIG);

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Search for Apollo emails received since sinceDate
    // Apollo sends from: notifications@apollo.io or similar
    const uids = await client.search({
      since: sinceDate,
      or: [
        { from: 'apollo.io' },
        { subject: 'verification' },
        { subject: 'confirm' },
        { subject: 'sign in' },
      ],
    });

    if (!uids?.length) return null;

    // Process newest emails first
    const sortedUids = [...uids].sort((a, b) => b - a);

    for (const uid of sortedUids.slice(0, 5)) {
      try {
        const msg = await client.fetchOne(uid, { bodyStructure: true, envelope: true, source: true });
        if (!msg) continue;

        const rawBody = msg.source?.toString('utf8') ?? '';

        // Optional: confirm this email is for the right Apollo account
        if (apolloEmail && !rawBody.toLowerCase().includes(apolloEmail.toLowerCase())) {
          // If forwarded, the To: header may differ — try envelope too
          const toAddr = msg.envelope?.to?.[0]?.address ?? '';
          if (toAddr && !toAddr.toLowerCase().includes(apolloEmail.split('@')[0].toLowerCase())) {
            continue;
          }
        }

        const otp = extractOtp(rawBody);
        if (otp) return otp;
      } catch (err) {
        logger.warn('Error parsing email', { uid, err: err.message });
      }
    }

    return null;
  } catch (err) {
    logger.error('IMAP error', { message: err.message });
    return null;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

module.exports = { waitForOtp, fetchLatestOtp };
