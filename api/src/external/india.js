/**
 * Is this posting in India?
 *
 * WHY A FILTER AT ALL. Every source here is global. Remotive is remote
 * jobs worldwide, Greenhouse and Lever are whatever companies have been
 * added, and the aggregators return whatever the query brought back. A
 * candidate in Nellore opening External Jobs and finding forty American
 * customer-service roles learns that the page is not for them, and stops
 * opening it.
 *
 * WHERE IT RUNS. At INGESTION, before anything is stored - not at read
 * time. A posting that cannot be shown should not be taking up a row, a
 * dedupe slot or a match calculation, and filtering on the way out means
 * every candidate pays for the same decision again.
 *
 * THE LIST IS IN ONE PLACE, which is this file. A city list scattered
 * through three connectors is a city list that disagrees with itself.
 *
 * WHAT IT DOES NOT DO. It does not guess. A posting with no location at
 * all is REJECTED rather than assumed local: an advert whose location
 * nobody stated is not evidence that the job is in India, and letting it
 * through is how the page fills up with roles nobody can take.
 */
import { config } from '../config.js';

/*
 * Written as they are written on job boards, including the spellings
 * that changed and the ones that did not. "Bangalore" and "Bengaluru"
 * are both in daily use; so are "Gurgaon" and "Gurugram".
 */
const CITIES = [
  'hyderabad', 'secunderabad', 'bengaluru', 'bangalore', 'chennai', 'mumbai',
  'navi mumbai', 'thane', 'pune', 'delhi', 'new delhi', 'ncr', 'gurugram',
  'gurgaon', 'noida', 'ghaziabad', 'faridabad', 'kolkata', 'ahmedabad',
  'surat', 'vadodara', 'rajkot', 'kochi', 'cochin', 'ernakulam',
  'thiruvananthapuram', 'trivandrum', 'kozhikode', 'calicut', 'thrissur',
  'coimbatore', 'madurai', 'tiruchirappalli', 'trichy', 'salem', 'vellore',
  'jaipur', 'jodhpur', 'udaipur', 'lucknow', 'kanpur', 'varanasi', 'agra',
  'prayagraj', 'allahabad', 'bhopal', 'indore', 'gwalior', 'jabalpur',
  'nagpur', 'nashik', 'aurangabad', 'visakhapatnam', 'vizag', 'vijayawada',
  'guntur', 'nellore', 'tirupati', 'rajahmundry', 'kakinada', 'warangal',
  'karimnagar', 'nizamabad', 'mysuru', 'mysore', 'mangaluru', 'mangalore',
  'hubli', 'belagavi', 'chandigarh', 'mohali', 'panchkula', 'ludhiana',
  'amritsar', 'jalandhar', 'patna', 'ranchi', 'jamshedpur', 'dhanbad',
  'bhubaneswar', 'cuttack', 'raipur', 'guwahati', 'shillong', 'imphal',
  'dehradun', 'haridwar', 'shimla', 'jammu', 'srinagar', 'goa', 'panaji',
  'puducherry', 'pondicherry', 'siliguri', 'durgapur', 'asansol', 'bareilly',
  'meerut', 'aligarh', 'moradabad', 'solapur', 'kolhapur', 'sangli',
];

const STATES = [
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh',
  'goa', 'gujarat', 'haryana', 'himachal pradesh', 'jharkhand', 'karnataka',
  'kerala', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram',
  'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim',
  'tamil nadu', 'tamilnadu', 'telangana', 'tripura', 'uttar pradesh',
  'uttarakhand', 'west bengal', 'andaman', 'ladakh', 'kashmir', 'puducherry',
];

/* A remote posting is in India when it says so, or when it is open to
   everyone. "Worldwide" and "Anywhere" include India; "US only" does not. */
const OPEN_TO_ANYWHERE = [
  'worldwide', 'anywhere', 'remote - global', 'global', 'international',
  'apac', 'asia', 'asia pacific', 'south asia', 'emea, apac',
];

/* Said explicitly on a great many remote adverts, and the reason a
   "Worldwide"-looking posting is still not open to somebody here. */
const EXCLUDES_INDIA = [
  'us only', 'usa only', 'united states only', 'u.s. only', 'us-only',
  'uk only', 'eu only', 'europe only', 'canada only', 'australia only',
  'must be located in the us', 'must reside in the us', 'authorized to work in the us',
  'ausgenommen', 'nicht in', 'excluding india',
];

const fold = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whole-word, so "goa" does not match "goal" and "pune" not "puneri". */
const mentions = (haystack, needle) => {
  if (!haystack || !needle) return false;
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? ' ' : haystack[i - 1];
  const after = i + needle.length >= haystack.length ? ' ' : haystack[i + needle.length];
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
};

/**
 * @param job  a normalised posting: { location, city, state, country, title }
 * @returns { keep, reason }  `reason` says why, in words fit for a log
 *          and for the admin screen's rejected count.
 */
export function inIndia(job) {
  if (!config.externalJobs.countryFilter) return { keep: true, reason: 'no country filter' };

  const country = fold(job.country);
  const text = fold([job.location, job.city, job.state, job.country].filter(Boolean).join(', '));

  if (!text) {
    /* NOT ASSUMED LOCAL. An advert whose location nobody stated is not
       evidence of anything, and letting it through fills the page with
       roles nobody here can take. */
    return { keep: false, reason: 'no location stated' };
  }

  for (const no of EXCLUDES_INDIA) {
    if (text.includes(no)) return { keep: false, reason: `stated as ${no}` };
  }

  if (country === 'in' || country === 'ind' || mentions(country, 'india')) {
    return { keep: true, reason: 'country is India' };
  }
  if (mentions(text, 'india') || mentions(text, 'bharat')) {
    return { keep: true, reason: 'location names India' };
  }
  for (const c of CITIES) {
    if (mentions(text, c)) return { keep: true, reason: `location names ${c}` };
  }
  for (const st of STATES) {
    if (mentions(text, st)) return { keep: true, reason: `location names ${st}` };
  }
  for (const open of OPEN_TO_ANYWHERE) {
    if (mentions(text, open)) return { keep: true, reason: `open to ${open}` };
  }

  return { keep: false, reason: `outside India (${text.slice(0, 60)})` };
}

/** The list the candidate's location filter offers by default. */
export const INDIAN_CITIES = CITIES;
