const INDIA_JURISDICTIONS = [
  ['AN', 'Andaman and Nicobar Islands', ['ANDAMAN & NICOBAR ISLANDS']],
  ['AP', 'Andhra Pradesh'],
  ['AR', 'Arunachal Pradesh'],
  ['AS', 'Assam'],
  ['BR', 'Bihar'],
  ['CH', 'Chandigarh'],
  ['CG', 'Chhattisgarh', ['CT']],
  ['DH', 'Dadra and Nagar Haveli and Daman and Diu', ['DN', 'DD']],
  ['DL', 'Delhi', ['NCT OF DELHI', 'NATIONAL CAPITAL TERRITORY OF DELHI']],
  ['GA', 'Goa'],
  ['GJ', 'Gujarat'],
  ['HR', 'Haryana'],
  ['HP', 'Himachal Pradesh'],
  ['JK', 'Jammu and Kashmir'],
  ['JH', 'Jharkhand'],
  ['KA', 'Karnataka'],
  ['KL', 'Kerala'],
  ['LA', 'Ladakh'],
  ['LD', 'Lakshadweep'],
  ['MP', 'Madhya Pradesh'],
  ['MH', 'Maharashtra'],
  ['MN', 'Manipur'],
  ['ML', 'Meghalaya'],
  ['MZ', 'Mizoram'],
  ['NL', 'Nagaland'],
  ['OD', 'Odisha', ['OR', 'ORISSA']],
  ['PY', 'Puducherry', ['PONDICHERRY']],
  ['PB', 'Punjab'],
  ['RJ', 'Rajasthan'],
  ['SK', 'Sikkim'],
  ['TN', 'Tamil Nadu'],
  ['TS', 'Telangana', ['TG']],
  ['TR', 'Tripura'],
  ['UP', 'Uttar Pradesh'],
  ['UK', 'Uttarakhand', ['UT', 'UTTARANCHAL']],
  ['WB', 'West Bengal'],
];

const normalized = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .trim();

const CODE_BY_ALIAS = new Map();
for (const [code, name, aliases = []] of INDIA_JURISDICTIONS) {
  [code, name, ...aliases].forEach((value) => CODE_BY_ALIAS.set(normalized(value), code));
}

export const normalizeIndiaJurisdictionCode = (value) => CODE_BY_ALIAS.get(normalized(value)) || null;

export const rulesetMatchesIndiaJurisdiction = ({
  profileCountry,
  profileState,
  rulesetCountry,
  rulesetState,
  allowCentral = true,
} = {}) => {
  const country = normalized(profileCountry);
  const rulesetCountryCode = normalized(rulesetCountry || 'IN');
  if (!['IN', 'INDIA'].includes(country) || !['IN', 'INDIA'].includes(rulesetCountryCode)) return false;
  if (!rulesetState) return allowCentral;
  const profileCode = normalizeIndiaJurisdictionCode(profileState);
  const rulesetCode = normalizeIndiaJurisdictionCode(rulesetState);
  return Boolean(profileCode && rulesetCode && profileCode === rulesetCode);
};

export const INDIA_RERA_CENTRAL_RULESET_CODE = 'INDIA_RERA_CENTRAL';
