/**
 * The stats modal's 地区 column: one short region code per exit row instead of
 * the full "HK Central" the IP tooltip already carries.
 *
 * Input is the exit's `exitLocation`, which admission.ts builds as
 * `${countryCode} ${city}` from the ip-api echo (`HK Central`, `SG Singapore`,
 * `DE Frankfurt am Main`), so the first whitespace-separated token IS the
 * ISO-3166-1 alpha-2 country code. The table below widens those codes into the
 * region labels — the two anchors are the mapping's own examples (香港 → HK,
 * 新加坡 → SGP) — and anything unmapped falls back to the raw alpha-2 code
 * rather than a blank, so a new airport location is still readable the day it
 * appears.
 *
 * Deliberately a browser-side module with no host imports (the bundle must
 * not drag the YAML parser in), hence the plain object.
 */

/** Country code → the region label shown in the 地区 column. */
const REGION_CODES: Record<string, string> = {
  // Greater China: HK/TW/MO stay two-letter; CN reads as CHN.
  HK: 'HK',
  TW: 'TW',
  MO: 'MO',
  CN: 'CHN',
  // The rest of the airports' usual inventory, alpha-3.
  SG: 'SGP',
  JP: 'JPN',
  KR: 'KOR',
  US: 'USA',
  CA: 'CAN',
  MX: 'MEX',
  BR: 'BRA',
  AR: 'ARG',
  CL: 'CHL',
  GB: 'GBR',
  IE: 'IRL',
  FR: 'FRA',
  DE: 'DEU',
  NL: 'NLD',
  BE: 'BEL',
  LU: 'LUX',
  CH: 'CHE',
  AT: 'AUT',
  IT: 'ITA',
  ES: 'ESP',
  PT: 'PRT',
  SE: 'SWE',
  NO: 'NOR',
  DK: 'DNK',
  FI: 'FIN',
  IS: 'ISL',
  PL: 'POL',
  CZ: 'CZE',
  SK: 'SVK',
  HU: 'HUN',
  RO: 'ROU',
  BG: 'BGR',
  GR: 'GRC',
  HR: 'HRV',
  SI: 'SVN',
  RS: 'SRB',
  LT: 'LTU',
  LV: 'LVA',
  EE: 'EST',
  UA: 'UKR',
  MD: 'MDA',
  RU: 'RUS',
  TR: 'TUR',
  IL: 'ISR',
  AE: 'ARE',
  SA: 'SAU',
  QA: 'QAT',
  KW: 'KWT',
  EG: 'EGY',
  MA: 'MAR',
  ZA: 'ZAF',
  NG: 'NGA',
  KE: 'KEN',
  IN: 'IND',
  PK: 'PAK',
  BD: 'BGD',
  LK: 'LKA',
  NP: 'NPL',
  MM: 'MMR',
  TH: 'THA',
  VN: 'VNM',
  MY: 'MYS',
  ID: 'IDN',
  PH: 'PHL',
  KH: 'KHM',
  MN: 'MNG',
  KZ: 'KAZ',
  UZ: 'UZB',
  AU: 'AUS',
  NZ: 'NZL',
}

/**
 * The 地区 code for one `exitLocation`, or an empty string when the value
 * carries no country code at all (an unprobed exit, or a source that reports
 * a bare city) — the caller renders its own placeholder for that case.
 */
export function regionCode(location: string): string {
  const token = location.trim().split(/\s+/)[0] ?? ''
  if (!/^[A-Za-z]{2}$/.test(token)) return ''
  const code = token.toUpperCase()
  return REGION_CODES[code] ?? code
}
