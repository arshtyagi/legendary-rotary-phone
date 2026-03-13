'use strict';

const https = require('https');
const { getValidSession, invalidateSession } = require('./sessionManager');
const logger = require('./utils/logger');

const API_CALL_DELAY = Number(process.env.API_CALL_DELAY_MS) || 300;
const lastCallTime   = new Map();

// ─────────────────────────────────────────────────────────────────────────────
//  URL Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseApolloUrl(rawUrl) {
  let queryString = '';
  const hashIdx = rawUrl.indexOf('#');
  if (hashIdx !== -1) {
    const afterHash = rawUrl.slice(hashIdx + 1);
    const qIdx = afterHash.indexOf('?');
    if (qIdx !== -1) queryString = afterHash.slice(qIdx + 1);
  } else {
    const qIdx = rawUrl.indexOf('?');
    if (qIdx !== -1) queryString = rawUrl.slice(qIdx + 1);
  }

  if (!queryString) throw new Error('No query parameters found in URL');

  const params = new URLSearchParams(queryString);

  const payload = {
    sort_by_field:         params.get('sortByField') || '[none]',
    sort_ascending:        params.get('sortAscending') === 'true',
    page:                  1,
    display_mode:          'metadata_mode',
    per_page:              1,
    context:               'people-index-page',
    open_factor_names:     [],
    use_pending_signals:   false,
    use_cache:             false,
    num_fetch_result:      1,
    show_suggestions:      false,
    finder_verson:         2,
    search_session_id:     generateUuid(),
    ui_finder_random_seed: Math.random().toString(36).substring(2, 13),
    cacheKey:              Date.now(),
  };

  // Person filters
  const titles = params.getAll('personTitles[]');
  if (titles.length) payload.person_titles = titles;

  const notTitles = params.getAll('personNotTitles[]');
  if (notTitles.length) payload.person_not_titles = notTitles;

  const seniorities = params.getAll('personSeniorities[]');
  if (seniorities.length) payload.person_seniorities = seniorities;

  const personLocations = params.getAll('personLocations[]');
  if (personLocations.length) payload.person_locations = personLocations;

  const personNotLocations = params.getAll('personNotLocations[]');
  if (personNotLocations.length) payload.person_not_locations = personNotLocations;

  // Email filters
  const emailStatuses = params.getAll('contactEmailStatusV2[]');
  if (emailStatuses.length) payload.contact_email_status_v2 = emailStatuses;

  const excludeCatchAll = params.get('contactEmailExcludeCatchAll');
  if (excludeCatchAll !== null) payload.contact_email_exclude_catch_all = excludeCatchAll === 'true';

  // Phone
  const phoneExists = params.get('phoneExists');
  if (phoneExists !== null) payload.phone_exists = phoneExists === 'true';

  // Organization filters
  const orgSizes = params.getAll('organizationNumEmployeesRanges[]');
  if (orgSizes.length) payload.organization_num_employees_ranges = orgSizes;

  const orgLocations = params.getAll('organizationLocations[]');
  if (orgLocations.length) payload.organization_locations = orgLocations;

  const orgNotLocations = params.getAll('organizationNotLocations[]');
  if (orgNotLocations.length) payload.organization_not_locations = orgNotLocations;

  const orgIndustryTagIds = params.getAll('organizationIndustryTagIds[]');
  if (orgIndustryTagIds.length) payload.organization_industry_tag_ids = orgIndustryTagIds;

  const orgNotIndustryTagIds = params.getAll('organizationNotIndustryTagIds[]');
  if (orgNotIndustryTagIds.length) payload.organization_not_industry_tag_ids = orgNotIndustryTagIds;

  // Keyword tag filters
  const includedOrgKeywordFields = params.getAll('includedOrganizationKeywordFields[]');
  if (includedOrgKeywordFields.length) payload.included_organization_keyword_fields = includedOrgKeywordFields;

  const excludedOrgKeywordFields = params.getAll('excludedOrganizationKeywordFields[]');
  if (excludedOrgKeywordFields.length) payload.excluded_organization_keyword_fields = excludedOrgKeywordFields;

  const qOrgKeywordTags      = params.getAll('qOrganizationKeywordTags[]');
  const legacyOrgKeywordTags = params.getAll('organizationKeywordTags[]');
  const allIncludedTags      = [...qOrgKeywordTags, ...legacyOrgKeywordTags];
  if (allIncludedTags.length) payload.q_organization_keyword_tags = allIncludedTags;

  const qNotOrgKeywordTags = params.getAll('qNotOrganizationKeywordTags[]');
  if (qNotOrgKeywordTags.length) payload.q_not_organization_keyword_tags = qNotOrgKeywordTags;

  // Search list filters
  const listId = params.get('qOrganizationSearchListId');
  if (listId) payload.q_organization_search_list_id = listId;

  const notListId = params.get('qNotOrganizationSearchListId');
  if (notListId) payload.q_not_organization_search_list_id = notListId;

  // Keywords
  const keywords = params.get('qKeywords');
  if (keywords) payload.q_keywords = keywords;

  // Misc
  const includeSimilarTitles = params.get('includeSimilarTitles');
  if (includeSimilarTitles !== null) payload.include_similar_titles = includeSimilarTitles === 'true';

  const prospectedByCurrentTeam = params.getAll('prospectedByCurrentTeam[]');
  if (prospectedByCurrentTeam.length) payload.prospected_by_current_team = prospectedByCurrentTeam;

  const marketSegments = params.getAll('marketSegments[]');
  if (marketSegments.length) payload.market_segments = marketSegments;

  const revenueRange = params.getAll('revenueRange[]');
  if (revenueRange.length) payload.revenue_range = revenueRange;

  const techUids = params.getAll('currentlyUsingAnyOfTechnologyUids[]');
  if (techUids.length) payload.currently_using_any_of_technology_uids = techUids;

  const finderViewId = params.get('finderViewId');
  if (finderViewId) payload.finder_view_id = finderViewId;

  const finderTableLayoutId = params.get('finderTableLayoutId');
  if (finderTableLayoutId) payload.finder_table_layout_id = finderTableLayoutId;

  const uniqueUrlId = params.get('uniqueUrlId');
  if (uniqueUrlId) payload.unique_url_id = uniqueUrlId;

  const recConfigId = params.get('recommendationConfigId');
  if (recConfigId) payload.recommendation_config_id = recConfigId;

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extract lead count from Apollo response
// ─────────────────────────────────────────────────────────────────────────────

function extractCount(data) {
  if (!data) return null;

  // Direct console log to bypass logger filtering
  console.log('APOLLO RAW:', JSON.stringify(data));

  // pipeline_total can be a number or { value: number }
  if (data.pipeline_total !== undefined) {
    const pt = data.pipeline_total;
    if (typeof pt === 'number') return pt;
    if (typeof pt === 'object' && pt !== null) {
      if (typeof pt.value    === 'number') return pt.value;
      if (typeof pt.count    === 'number') return pt.count;
      if (typeof pt.total    === 'number') return pt.total;
    }
  }

  // breadcrumbs array — look for total entry
  if (Array.isArray(data.breadcrumbs)) {
    for (const b of data.breadcrumbs) {
      if (b?.label?.toLowerCase?.()?.includes('total') || b?.type === 'total') {
        if (typeof b.value === 'number') return b.value;
        if (typeof b.count === 'number') return b.count;
      }
    }
    // fallback: first breadcrumb with a numeric value
    for (const b of data.breadcrumbs) {
      if (typeof b?.value === 'number') return b.value;
    }
  }

  // Other common fields
  if (typeof data.pagination?.total_entries === 'number') return data.pagination.total_entries;
  if (typeof data.total_people              === 'number') return data.total_people;
  if (typeof data.total_results             === 'number') return data.total_results;
  if (typeof data.total                     === 'number') return data.total;
  if (typeof data.count                     === 'number') return data.count;
  if (typeof data.metadata?.total_results   === 'number') return data.metadata.total_results;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main export
// ─────────────────────────────────────────────────────────────────────────────

async function getLeadCount(apolloUrl) {
  const payload  = parseApolloUrl(apolloUrl);
  const filters  = Object.keys(payload).filter(k => !['page','per_page','display_mode','context','cacheKey','search_session_id','ui_finder_random_seed','finder_verson','open_factor_names','use_pending_signals','use_cache','num_fetch_result','show_suggestions','sort_by_field','sort_ascending'].includes(k));
  logger.info('Apollo search payload built', { filters });

  const MAX_RETRIES = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await getValidSession();

    // Rate limit guard
    const last = lastCallTime.get(session.accountId) || 0;
    const gap  = Date.now() - last;
    if (gap < API_CALL_DELAY) await new Promise(r => setTimeout(r, API_CALL_DELAY - gap));

    try {
      const data  = await _doApiCall(payload, session);
      lastCallTime.set(session.accountId, Date.now());

      console.log('=== APOLLO RAW RESPONSE ===');
      console.log(JSON.stringify(data, null, 2));
      console.log('=== END RESPONSE ===');

      const total = extractCount(data);

      if (total === null || total === undefined) {
        logger.warn('Could not parse lead count', { keys: Object.keys(data || {}) });
        throw new Error('Lead count not found in Apollo response');
      }

      logger.info('Lead count retrieved', { count: total, accountId: session.accountId });
      return Number(total);

    } catch (err) {
      lastErr = err;
      if (err.authError) {
        logger.warn('Auth error — invalidating session', { accountId: session.accountId });
        invalidateSession(session.accountId);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (err.status === 429) {
        logger.warn('Rate limited — backing off', { attempt });
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('Max retries exceeded');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Raw HTTPS POST
// ─────────────────────────────────────────────────────────────────────────────

function _doApiCall(payload, session) {
  return new Promise((resolve, reject) => {
    const body      = JSON.stringify(payload);
    const cookieStr = session.cookieHeader;
    const csrf      = session.headers?.['x-csrf-token'] || '';

    const req = https.request({
      hostname: 'app.apollo.io',
      path:     '/api/v1/mixed_people/search_metadata_mode',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'Accept':            '*/*',
        'Accept-Language':   'en-US,en;q=0.9',
        'Origin':            'https://app.apollo.io',
        'Referer':           'https://app.apollo.io/',
        'User-Agent':        session.headers?.['User-Agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'x-csrf-token':      csrf,
        'x-referer-host':    'app.apollo.io',
        'x-referer-path':    '/people',
        'x-accept-language': 'en',
        'Cookie':            cookieStr,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error(`Auth failed: HTTP ${res.statusCode}`), { authError: true }));
        }
        if (res.statusCode === 429) {
          return reject(Object.assign(new Error('Rate limited'), { status: 429 }));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Apollo API HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Failed to parse Apollo response as JSON'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { getLeadCount, parseApolloUrl };
