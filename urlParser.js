'use strict';

/**
 * Converts an Apollo frontend people-search URL into the body payload
 * expected by Apollo's internal /api/v1/mixed_people/search endpoint.
 *
 * Apollo encodes filters in the hash (#) portion of the URL as
 * URLSearchParams, so we parse the fragment, not the query string.
 *
 * Supported filter params (as seen in Apollo URLs):
 *   personTitles, personLocations, organizationLocations,
 *   organizationNumEmployeesRanges, organizationIndustryTagIds,
 *   personSeniorities, contactEmailStatusV2, etc.
 */

const SENIORITY_MAP = {
  owner:       'owner',
  founder:     'founder',
  c_suite:     'c_suite',
  partner:     'partner',
  vp:          'vp',
  head:        'head',
  director:    'director',
  manager:     'manager',
  senior:      'senior',
  entry:       'entry',
  intern:      'intern',
};

/**
 * Parse an Apollo people URL into a search API payload.
 * @param {string} apolloUrl
 * @returns {object} payload ready for POST to Apollo search API
 */
function parseApolloUrl(apolloUrl) {
  // Strip the leading https://app.apollo.io/#/people? portion
  let fragment = apolloUrl;

  // Handle both hash-based (#) and regular query string formats
  const hashIdx = apolloUrl.indexOf('#');
  if (hashIdx !== -1) {
    fragment = apolloUrl.slice(hashIdx + 1);
  }

  // Remove leading /people? or /people/
  fragment = fragment.replace(/^\/?people\??/, '');

  const params = new URLSearchParams(fragment);

  const get     = k => params.get(k);
  const getAll  = k => params.getAll(k);
  const getArr  = k => {
    const val = get(k);
    if (!val) return undefined;
    try { return JSON.parse(val); } catch { return val.split(',').filter(Boolean); }
  };

  // ── Build payload ──────────────────────────────────────────────────────────
  const payload = {
    page:        1,
    per_page:    1,     // We only need the count, not the records
    display_mode: 'explorer_mode',
  };

  // Person titles
  const titles = getArr('personTitles') || getAll('personTitles[]');
  if (titles?.length) payload.person_titles = titles;

  // Person locations
  const personLocs = getArr('personLocations') || getAll('personLocations[]');
  if (personLocs?.length) payload.person_locations = personLocs;

  // Organisation locations
  const orgLocs = getArr('organizationLocations') || getAll('organizationLocations[]');
  if (orgLocs?.length) payload.organization_locations = orgLocs;

  // Employee count ranges — Apollo expects strings like "1,10" or "11,50"
  const empRanges = getArr('organizationNumEmployeesRanges') || getAll('organizationNumEmployeesRanges[]');
  if (empRanges?.length) payload.organization_num_employees_ranges = empRanges;

  // Industry tag IDs
  const industries = getArr('organizationIndustryTagIds') || getAll('organizationIndustryTagIds[]');
  if (industries?.length) payload.organization_industry_tag_ids = industries;

  // Seniority
  const seniorities = getArr('personSeniorities') || getAll('personSeniorities[]');
  if (seniorities?.length) {
    payload.person_seniorities = seniorities
      .map(s => SENIORITY_MAP[s?.toLowerCase()] ?? s)
      .filter(Boolean);
  }

  // Keywords
  const q = get('q') || get('qOrganizationName');
  if (q) payload.q_keywords = q;

  // Email status filter
  const emailStatus = getArr('contactEmailStatusV2') || getAll('contactEmailStatusV2[]');
  if (emailStatus?.length) payload.contact_email_status_v2 = emailStatus;

  // Job change filter
  const jobChange = get('personJobChangeType');
  if (jobChange) payload.person_job_change_type = jobChange;

  // Keywords (person)
  const personKeywords = get('personKeywords');
  if (personKeywords) payload.q_person_keywords = personKeywords;

  // Organisation keywords
  const orgKeywords = get('organizationKeywords');
  if (orgKeywords) payload.q_organization_keyword_tags = orgKeywords;

  // Technology tags
  const techTags = getArr('currentTechnology') || getAll('currentTechnology[]');
  if (techTags?.length) payload.currently_using_any_of_technology_uids = techTags;

  return payload;
}

module.exports = { parseApolloUrl };
