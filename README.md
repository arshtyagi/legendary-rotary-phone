# Apollo API Service

A high-performance, production-ready Node.js API that logs into Apollo.io, maintains persistent sessions, and returns lead counts for search URLs — with sub-second response times after sessions are warmed.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        server.js                         │
│            Express API  ·  POST /leads/count             │
└────────────────────────┬─────────────────────────────────┘
                         │
            ┌────────────▼────────────┐
            │     apolloSearch.js     │  parses URL → API call → count
            └────────────┬────────────┘
                         │  getValidSession()
            ┌────────────▼────────────┐
            │    sessionManager.js    │  pool of 4 sessions, staggered logins
            └────────────┬────────────┘
                         │  loginToApollo()
            ┌────────────▼────────────┐
            │        auth.js          │  full login flow
            └──────┬─────────┬────────┘
                   │         │
       ┌───────────▼──┐  ┌───▼─────────────┐
       │  imapOtp.js  │  │ captchaSolver.js │
       │  Gmail IMAP  │  │  CapSolver API   │
       └──────────────┘  └─────────────────┘
```

---

## Features

| Feature | Detail |
|---|---|
| **Session pool** | Up to 4 Apollo accounts, round-robin rotation |
| **Staggered logins** | 20-min intervals so sessions never expire together |
| **Auto-refresh** | Sessions renewed 5 min before expiry |
| **OTP via IMAP** | Gmail app-password, polls every 5 s, 90 s timeout |
| **Captcha solving** | Cloudflare Turnstile + hCaptcha via CapSolver |
| **Retry logic** | 401/403 → invalidate + re-login + retry (3 attempts) |
| **Rate-limit guard** | Configurable delay between calls per session |
| **Keep-alive HTTP** | Shared agents, no TCP handshake per request |
| **Response time** | < 1 s after sessions are warm |
| **Zero secrets in logs** | Passwords, cookies, tokens are all redacted |

---

## Quick Start

### 1. Install dependencies

```bash
cd apollo-api
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required values:

```env
APOLLO_EMAILS=acct1@example.com,acct2@example.com
APOLLO_PASSWORDS=pass1,pass2
GMAIL_USER=yourInbox@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
CAPSOLVER_API_KEY=CAP-xxxxxxxxxxxx
```

### 3. Start the server

```bash
npm start
```

On startup, the service will:
1. Log in Account 1 immediately
2. Log in Account 2 after 20 min
3. Log in Account 3 after 40 min
4. Log in Account 4 after 60 min

---

## API Reference

### `POST /leads/count`

Returns the total number of matching contacts for an Apollo search URL.

**Request**
```json
{
  "apollo_url": "https://app.apollo.io/#/people?personTitles[]=CEO&personLocations[]=United%20States"
}
```

**Response**
```json
{
  "lead_count": 12456
}
```

**Error response**
```json
{
  "error": "Failed to retrieve lead count",
  "detail": "..."
}
```

---

### `GET /health`

Returns session pool status.

```json
{
  "status": "ok",
  "sessions": [
    {
      "accountId": "account_1",
      "status": "alive",
      "ttlMs": 3241000,
      "loginInProgress": false
    }
  ],
  "uptime": 3600
}
```

---

### `GET /sessions`

Alias for `/health` sessions data.

---

## Supported URL Filters

The URL parser extracts these Apollo filter parameters:

| URL param | API field |
|---|---|
| `personTitles[]` | `person_titles` |
| `personLocations[]` | `person_locations` |
| `organizationLocations[]` | `organization_locations` |
| `organizationNumEmployeesRanges[]` | `organization_num_employees_ranges` |
| `organizationIndustryTagIds[]` | `organization_industry_tag_ids` |
| `personSeniorities[]` | `person_seniorities` |
| `contactEmailStatusV2[]` | `contact_email_status_v2` |
| `currentTechnology[]` | `currently_using_any_of_technology_uids` |
| `q` / `qOrganizationName` | `q_keywords` |

---

## Gmail Setup

1. Enable IMAP in Gmail Settings → Forwarding and POP/IMAP
2. Create an **App Password** (Google Account → Security → 2-Step Verification → App Passwords)
3. Forward all 4 Apollo account emails to this single Gmail inbox
4. Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`

---

## Proxy Configuration

To use a static IP (recommended to reduce OTP triggers):

```env
PROXY_URL=http://user:pass@static.proxy.host:8080
# or SOCKS5:
PROXY_URL=socks5://user:pass@static.proxy.host:1080
```

Leave blank for direct connection.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APOLLO_EMAILS` | — | Comma-separated account emails |
| `APOLLO_PASSWORDS` | — | Comma-separated passwords (order-matched) |
| `GMAIL_USER` | — | Gmail inbox address |
| `GMAIL_APP_PASSWORD` | — | Gmail app password |
| `CAPSOLVER_API_KEY` | — | CapSolver.com API key |
| `APOLLO_TURNSTILE_SITE_KEY` | `0x4AA...` | Turnstile site key (verify in DevTools) |
| `PROXY_URL` | `""` | Optional proxy URL |
| `SESSION_TTL_MS` | `3600000` | Session lifetime (1 hour) |
| `SESSION_REFRESH_BUFFER_MS` | `300000` | Refresh 5 min before expiry |
| `LOGIN_STAGGER_INTERVAL_MS` | `1200000` | 20 min between account logins |
| `API_CALL_DELAY_MS` | `300` | Min ms between Apollo API calls per session |
| `PORT` | `3000` | HTTP server port |

---

## File Structure

```
apollo-api/
├── server.js          # Express server, routes, bootstrap
├── sessionManager.js  # Session pool, staggered login, health checks
├── auth.js            # Apollo login flow (with captcha + OTP)
├── imapOtp.js         # Gmail IMAP OTP reader
├── captchaSolver.js   # CapSolver Turnstile/hCaptcha/reCAPTCHA
├── apolloSearch.js    # Apollo API call + retry logic
├── utils/
│   ├── httpClient.js  # Axios + cookie jar + keep-alive agents
│   ├── urlParser.js   # Apollo frontend URL → API payload
│   └── logger.js      # Winston logger with credential redaction
├── .env.example
├── package.json
└── README.md
```

---

## Notes

- **Apollo API endpoints** may change. If `401` persists after re-login, inspect the network tab in your browser to confirm the correct endpoint and payload shape.
- **Turnstile site key** — verify the current value in browser DevTools on `app.apollo.io/login`.
- **OTP emails** — Apollo sends from `notifications@apollo.io`. The IMAP search is broad enough to catch rebrands.
- **Session warm-up** — the first request after a cold start may take 10–30 seconds while the first login completes. Subsequent requests are < 1 second.
