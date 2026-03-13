'use strict';

function parseApolloUrl(apolloUrl) {
  let fragment = apolloUrl;
  const hashIdx = apolloUrl.indexOf('#');
  if (hashIdx !== -1) fragment = apolloUrl.slice(hashIdx + 1);
  fragment = fragment.replace(/^\/?people\??/, '');

  const params = new URLSearchParams(fragment);
  const get    = k => params.get(k);
  const getArr = k => {
    const val = get(k);
    if (!val) return undefined;
    try { return JSON.parse(val); } catch { return val.split(',').filter(Boolean); }
  };

  const payload = { page: 1, per_page: 1, display_mode: 'explorer_mode' };

  const titles = getArr('personTitles') || params.getAll('personTitles[]');
  if (titles?.length) payload.person_titles = titles;

  const personLocs = getArr('personLocations') || params.getAll('personLocations[]');
  if (personLocs?.length) payload.person_locations = personLocs;

  const orgLocs = getArr('organizationLocations') || params.getAll('organizationLocations[]');
  if (orgLocs?.length) payload.organization_locations = orgLocs;

  const empRanges = getArr('organizationNumEmployeesRanges') || params.getAll('organizationNumEmployeesRanges[]');
  if (empRanges?.length) payload.organization_num_employees_ranges = empRanges;

  const industries = getArr('organizationIndustryTagIds') || params.getAll('organizationIndustryTagIds[]');
  if (industries?.length) payload.organization_industry_tag_ids = industries;

  const seniorities = getArr('personSeniorities') || params.getAll('personSeniorities[]');
  if (seniorities?.length) payload.person_seniorities = seniorities;

  const q = get('q') || get('qOrganizationName');
  if (q) payload.q_keywords = q;

  const techTags = getArr('currentTechnology') || params.getAll('currentTechnology[]');
  if (techTags?.length) payload.currently_using_any_of_technology_uids = techTags;

  return payload;
}

module.exports = { parseApolloUrl };
