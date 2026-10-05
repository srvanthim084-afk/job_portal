/**
 * The public face of a published job (0112): its URL, the JSON / RSS feed
 * the TeamLink website embeds, the XML feed a job site pulls, and the
 * schema.org JobPosting block on the job page.
 *
 * WHAT IS PUBLIC. Only jobs in `jobs_open` (Active, not paused, archived,
 * expired or past their walk-in) AND ticked for the destination the feed
 * is for. A job taken off the website, or closed, drops out of the next
 * response by construction - there is no cache of "what we listed".
 *
 * NOTHING INTERNAL. No recruiter, no applicant count, no notes; the
 * company name only under the same rule as the share preview (never one
 * containing the word "client").
 */
import { createHash } from 'node:crypto';
import { config } from '../config.js';

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
export const safeCompany = (c) => { const v = clean(c); return v && !/\bclient\b/i.test(v) ? v : ''; };
const ORG = () => clean(process.env.PUBLISH_ORG_NAME) || 'TeamLink Consultants';

/** The address the public opens: PUBLIC_SHARE_URL, else PUBLIC_ORIGIN. */
export function publicBase() {
  return (clean(process.env.PUBLIC_SHARE_URL) || config.publicOrigin || '').replace(/\/$/, '');
}
/** Where the server can reach ITSELF to check a URL really answers. */
export function probeBase() {
  return (clean(process.env.PUBLISH_PROBE_ORIGIN) || config.publicOrigin || '').replace(/\/$/, '');
}
export const jobPageUrl = (id) => `${publicBase()}/job/${encodeURIComponent(id)}`;
export const websiteEntryUrl = (id) => `${publicBase()}/feeds/jobs/${encodeURIComponent(id)}.json`;
/** The company website's own page for a job, when it has one (env). */
export function websiteJobUrl(id) {
  const t = clean(process.env.TEAMLINK_WEBSITE_JOB_URL);
  return t && t.includes('{id}') ? t.split('{id}').join(encodeURIComponent(id)) : '';
}

/** What a platform sees; a change to any of it is an update to push. */
export function jobContentHash(row) {
  const r = row || {};
  const parts = [r.title, r.location, r.mode, r.exp_label, r.pay_label, r.salary_min, r.salary_max,
    r.employment_type, r.posting_kind, r.openings, r.education, r.description,
    (r.skills || []).join('|'), (r.requirements || []).join('|'), (r.responsibilities || []).join('|'),
    r.walkin_date, r.walkin_from, r.walkin_to, r.walkin_venue, r.walkin_address, r.expires_at && new Date(r.expires_at).toISOString(),
    r.company_name];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

const SELECT_FEED = (dest) => `
  select j.*, co.name as company_name, p.updated_at as listed_at
    from jobs_open j
    join job_publications p on p.job_id = j.id and p.destination = '${dest}' and p.desired = 'published'
    left join companies co on co.id = j.company_id`;

/** Every job a destination's feed lists right now. `c` runs as the publishing worker. */
export async function feedRows(c, destination, { jobId = null, limit = 1000 } = {}) {
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(destination)) return [];
  const params = [];
  let where = '';
  if (jobId) { params.push(jobId); where = `where j.id = $1`; }
  params.push(limit);
  const { rows } = await c.query(
    `${SELECT_FEED(destination)} ${where} order by j.published_at desc nulls last, j.id limit $${params.length}`, params);
  return rows;
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ');
const plain = (s) => stripHtml(s).replace(/[ \t]+/g, ' ').trim();
const isoDate = (d) => { try { return d ? new Date(d).toISOString() : null; } catch { return null; } };
const EMPLOYMENT = { 'full-time': 'FULL_TIME', 'part-time': 'PART_TIME', contract: 'CONTRACTOR', internship: 'INTERN', temporary: 'TEMPORARY' };
function employmentType(r) {
  if (r.posting_kind === 'internship') return 'INTERN';
  return EMPLOYMENT[String(r.employment_type || '').toLowerCase()] || 'FULL_TIME';
}
/** "Hyderabad, Telangana" -> locality / region; the country is India. */
function place(r) {
  const parts = clean(r.location).split(',').map((x) => x.trim()).filter(Boolean);
  return { city: parts[0] || '', state: parts.length > 1 ? parts[parts.length - 1] : '', country: 'IN' };
}
const remote = (r) => /remote|work from home|wfh/i.test(`${r.mode || ''} ${r.location || ''}`);

/** The neutral shape every feed and connector starts from. */
export function publicJob(r) {
  const p = place(r);
  const company = safeCompany(r.company_name) || ORG();
  return {
    id: r.id,
    title: clean(r.title),
    company,
    postedBy: ORG(),
    location: clean(r.location),
    city: p.city, state: p.state, country: p.country,
    remote: remote(r),
    workMode: clean(r.mode),
    employmentType: employmentType(r),
    jobType: r.posting_kind === 'walkin' ? 'walk-in' : r.posting_kind === 'internship' ? 'internship' : 'regular',
    experience: clean(r.exp_label),
    salary: clean(r.pay_label),
    salaryMin: r.salary_min == null ? null : Number(r.salary_min),
    salaryMax: r.salary_max == null ? null : Number(r.salary_max),
    openings: r.openings == null ? null : Number(r.openings),
    education: clean(r.education),
    skills: (r.skills || []).map(clean).filter(Boolean),
    description: plain(r.description),
    responsibilities: (r.responsibilities || []).map(clean).filter(Boolean),
    requirements: (r.requirements || []).map(clean).filter(Boolean),
    walkin: r.posting_kind === 'walkin' ? {
      date: clean(r.walkin_date), from: clean(r.walkin_from), to: clean(r.walkin_to),
      venue: clean(r.walkin_venue), address: clean(r.walkin_address),
    } : null,
    publishedAt: isoDate(r.published_at),
    validThrough: isoDate(r.expires_at),
    url: jobPageUrl(r.id),
    applyUrl: jobPageUrl(r.id),
  };
}

/** schema.org JobPosting, for the job page and the JSON feed. */
export function jobPostingJsonLd(r) {
  const j = publicJob(r);
  const out = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: j.title,
    description: [j.description, j.responsibilities.length ? 'Responsibilities: ' + j.responsibilities.join('; ') : '',
      j.requirements.length ? 'Requirements: ' + j.requirements.join('; ') : ''].filter(Boolean).join('\n\n') || j.title,
    identifier: { '@type': 'PropertyValue', name: j.postedBy, value: j.id },
    datePosted: j.publishedAt || undefined,
    validThrough: j.validThrough || undefined,
    employmentType: j.employmentType,
    hiringOrganization: { '@type': 'Organization', name: j.company },
    url: j.url,
    directApply: true,
  };
  if (j.remote) out.jobLocationType = 'TELECOMMUTE';
  if (j.city || j.state) {
    out.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: j.city || undefined,
      addressRegion: j.state || undefined, addressCountry: j.country } };
  } else if (j.remote) {
    out.applicantLocationRequirements = { '@type': 'Country', name: 'India' };
  }
  if (j.salaryMin != null || j.salaryMax != null) {
    /* Stored in lakhs per annum on this portal (₹4–6 LPA -> 4, 6). */
    const lakh = (v) => (v == null ? undefined : Math.round(Number(v) * 100000));
    out.baseSalary = { '@type': 'MonetaryAmount', currency: 'INR',
      value: { '@type': 'QuantitativeValue', minValue: lakh(j.salaryMin), maxValue: lakh(j.salaryMax ?? j.salaryMin), unitText: 'YEAR' } };
  }
  if (j.education) out.educationRequirements = j.education;
  if (j.skills.length) out.skills = j.skills.join(', ');
  return out;
}

/** The JSON-LD <script>, safe inside an HTML head. */
export function jsonLdScript(r) {
  const s = JSON.stringify(jobPostingJsonLd(r)).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${s}</script>`;
}

/* ------------------------------------------------------------------ *
 * the website feed
 * ------------------------------------------------------------------ */
export function jsonFeed(rows) {
  return {
    version: 1,
    source: ORG(),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    jobs: rows.map((r) => ({ ...publicJob(r), jsonLd: jobPostingJsonLd(r) })),
  };
}

const xml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // characters XML 1.0 forbids
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const cdata = (v) => `<![CDATA[${String(v == null ? '' : v).split(']]>').join(']]]]><![CDATA[>')}]]>`;

export function rssFeed(rows) {
  const items = rows.map((r) => {
    const j = publicJob(r);
    const summary = [j.company, j.location, j.experience, j.salary].filter(Boolean).join(' · ');
    return `  <item>
    <title>${xml(j.title)}</title>
    <link>${xml(j.url)}</link>
    <guid isPermaLink="false">teamlink-job-${xml(j.id)}</guid>
    ${j.publishedAt ? `<pubDate>${new Date(j.publishedAt).toUTCString()}</pubDate>` : ''}
    <category>${xml(j.jobType)}</category>
    <description>${cdata(summary + (j.description ? '\n\n' + j.description : ''))}</description>
  </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${xml(ORG())} - open jobs</title>
  <link>${xml(publicBase())}/</link>
  <description>Jobs currently open at ${xml(ORG())}</description>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

/**
 * The XML job feed a job site pulls (Indeed's published feed format; the
 * same shape serves a partner-feed programme on another platform).
 * `referencenumber` is the TeamLink job id, which is how the platform's
 * confirmation names the job back to us.
 */
export function partnerXmlFeed(rows, { publisherUrl = publicBase() } = {}) {
  const jobs = rows.map((r) => {
    const j = publicJob(r);
    const desc = [j.description,
      j.responsibilities.length ? 'Responsibilities:\n- ' + j.responsibilities.join('\n- ') : '',
      j.requirements.length ? 'Requirements:\n- ' + j.requirements.join('\n- ') : '',
      j.walkin ? `Walk-in interview: ${[j.walkin.date, [j.walkin.from, j.walkin.to].filter(Boolean).join('-'), j.walkin.venue, j.walkin.address].filter(Boolean).join(', ')}` : '',
    ].filter(Boolean).join('\n\n') || j.title;
    return `  <job>
    <title>${cdata(j.title)}</title>
    <date>${cdata(j.publishedAt ? new Date(j.publishedAt).toUTCString() : '')}</date>
    <referencenumber>${cdata(j.id)}</referencenumber>
    <requisitionid>${cdata(j.id)}</requisitionid>
    <url>${cdata(j.url)}</url>
    <company>${cdata(j.company)}</company>
    <sourcename>${cdata(j.postedBy)}</sourcename>
    <city>${cdata(j.city)}</city>
    <state>${cdata(j.state)}</state>
    <country>${cdata(j.country)}</country>
    <description>${cdata(desc)}</description>
    <salary>${cdata(j.salary)}</salary>
    <education>${cdata(j.education)}</education>
    <jobtype>${cdata(j.employmentType.toLowerCase().replace('_', '-'))}</jobtype>
    <experience>${cdata(j.experience)}</experience>
    ${j.remote ? `<remotetype>${cdata('Fully remote')}</remotetype>` : ''}
    ${j.validThrough ? `<expirationdate>${cdata(j.validThrough.slice(0, 10))}</expirationdate>` : ''}
  </job>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>${xml(ORG())}</publisher>
  <publisherurl>${xml(publisherUrl)}</publisherurl>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${jobs}
</source>
`;
}
