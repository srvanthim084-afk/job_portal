/**
 * The "new job opportunity" message (owner, 2026-10-06): one format for
 * every job alert and for Share Job, built ONLY from the job record.
 *
 *   🚀 NEW JOB OPPORTUNITY – <location>
 *   Hi! 👋 We found a job opportunity that could be a great match for your profile!
 *   🏥 <title> / 🏢 <company>
 *   💼 🎓 💰 📍 🕐 🏠   - only the fields the job has
 *   ⭐ What We're Looking For / ✅ requirements, de-duplicated and shortened
 *   🎯 Why Consider This Opportunity? / ✨ 2-4 highlights, only from the description
 *   (a walk-in job's walk-in block)
 *   👉 Interested? … / 🔗 <the system's apply URL> / 📩 Don't miss … / company, tagline
 *
 * One function, every channel, so a WhatsApp message and the email about the
 * same job cannot say different things:
 *
 *   whatsapp, in_app   the full format, *bold* headings and key values
 *   text               the same lines without the bold markers (email text part)
 *   email              { subject, text, html } - the same content as escaped HTML
 *                      in the house email shell, with one Apply button
 *   sms                a deliberate compact version: heading, title, company,
 *                      location, salary, link (SMS is billed per segment)
 *
 * RULES IT KEEPS. Nothing is invented: a field the job does not have is left
 * out (never "null", "undefined", "N/A" or an empty label). The title and the
 * apply URL are printed exactly as given. The company is the one the caller
 * passes - the name the candidate's job card shows (companyLabel() /
 * the share's safe company) - and a name containing "client" is never printed
 * (0051). Deterministic: the same job and options always give the same text.
 */
import { emailLayout } from './layout.js';

/* ------------------------------------------------------------------ *
 * fields
 * ------------------------------------------------------------------ */

const PLACEHOLDER = /^(undefined|null|nan|\[object object\]|n\/?a|na|nil|none|-+|tbd|not specified|not applicable|not disclosed)$/i;

/** A field worth printing: never "undefined", "null", "N/A" or blank. */
export const cleanField = (v) => {
  if (v === undefined || v === null || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && !PLACEHOLDER.test(s) ? s : '';
};

const pick = (job, keys) => {
  for (const k of keys) { const v = cleanField(job && job[k]); if (v) return v; }
  return '';
};

const listOf = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n|;/))
  .map((x) => cleanField(String(x == null ? '' : x).replace(/^[\s•\-*✅▪·]+/, ''))).filter(Boolean);

/** Candidates never read a client's name, or any name with "client" in it (0051). */
export const safeCompany = (c) => { const v = cleanField(c); return v && !/\bclients?\b/i.test(v) ? v : ''; };

export const isWalkinJob = (job) => !!job && (job.postingKind === 'walkin' || job.posting_kind === 'walkin'
  || job.jobType === 'walk-in' || /^walk.?in$/i.test(String(job.type || job.employment_type || '')));

/**
 * 🏠 Work From Home, from the job's mode: Remote -> Available, Hybrid ->
 * Hybrid, on-site -> Not Available. An unknown mode prints no line.
 */
export function workFromHome(mode) {
  const m = cleanField(mode).toLowerCase();
  if (!m) return '';
  if (/hybrid/.test(m)) return 'Hybrid';
  if (/remote|work\s*from\s*home|\bwfh\b|anywhere/.test(m)) return 'Available';
  if (/on-?\s?site|office|\bwfo\b|in-?person|^field/.test(m)) return 'Not Available';
  return '';
}

/* ------------------------------------------------------------------ *
 * requirements: short, readable, no duplicates
 * ------------------------------------------------------------------ */

/* Openers that add words, not meaning: "Candidates should have good
   communication skills" says what "Good communication skills" says. */
const FILLER = [
  /^(the\s+)?(ideal\s+|interested\s+|eligible\s+)?(candidates?|applicants?|aspirants?)\s+(should|must|will|shall|need\s+to|needs\s+to|are\s+expected\s+to|is\s+expected\s+to|are\s+required\s+to|is\s+required\s+to)\s+(have|possess|hold|be)\s+/i,
  /^(the\s+)?(candidates?|applicants?)\s+(with|having)\s+/i,
  /^(we\s+are|we're|we\s+need|looking)\s+(looking\s+)?for\s+(someone|a\s+person|a\s+candidate|candidates|people)\s+(with|who\s+has|who\s+have|having)\s+/i,
  /^(must|should)\s+(have|possess|hold)\s+/i,
  /^(required|requirements?|mandatory|eligibility|qualification)\s*[:\-–—]\s*/i,
];

/** One requirement, without the filler, as one or more short points. */
export function shortenRequirement(raw) {
  let s = cleanField(raw);
  if (!s) return [];
  s = s.replace(/[\s.;,:]+$/, '').trim();
  if (!s) return [];
  /* A long one that is really several sentences becomes several points;
     the words of each are kept. */
  const parts = s.length > 90 ? s.split(/(?<=[a-z0-9)])\.\s+(?=[A-Z])/) : [s];
  return parts.map((p) => {
    let x = p.replace(/[\s.;,:]+$/, '').trim();
    const given = x;
    for (const re of FILLER) x = x.replace(re, '');
    /* "should have a valid licence" -> "Valid licence", not "A valid licence". */
    if (x !== given) x = x.replace(/^(a|an)\s+(?=\S)/i, '');
    return x ? x.charAt(0).toUpperCase() + x.slice(1) : '';
  }).filter(Boolean);
}

const dedupeKey = (s) => String(s).toLowerCase().normalize('NFKC')
  .replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();

export const MAX_REQUIREMENTS = 6;

/** The job's requirements as ✅ points: shortened, duplicates removed, in order. */
export function requirementPoints(requirements, max = MAX_REQUIREMENTS) {
  const out = [];
  const seen = new Set();
  for (const r of listOf(requirements)) {
    for (const p of shortenRequirement(r)) {
      const k = dedupeKey(p);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * highlights: only what the description itself says
 * ------------------------------------------------------------------ */

/*
 * Each rule is a phrase the description must actually contain, and the
 * short highlight it becomes. A sentence with a negation in it ("no
 * incentives", "accommodation not provided") is skipped entirely - when in
 * doubt, say nothing. Fewer than two highlights: no section at all.
 */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const HIGHLIGHTS = [
  { re: /\b(competitive|attractive|excellent|lucrative|best[- ]in[- ](?:the[- ])?industry)\s+(salary|pay|package|compensation|remuneration)\b/i,
    say: (m) => `${cap(m[1].toLowerCase().replace(/\s+/g, '-').replace(/^best-in-the-industry$/, 'best-in-industry'))} salary package` },
  { re: /\b(?:attractive|performance[- ]based|monthly|lucrative|good|high|unlimited)\s+incentives?\b|\bincentives?\s+(?:are\s+|will\s+be\s+)?(?:provided|offered|available|paid)\b|\b(?:salary|pay|ctc)\s*(?:\+|plus|and|&)\s*incentives?\b/i,
    say: () => 'Incentives offered' },
  { re: /\b(performance|annual|joining|yearly|quarterly)\s+bonus(?:es)?\b|\bbonus(?:es)?\s+(?:is\s+|are\s+|will\s+be\s+)?(?:provided|offered|paid)\b/i,
    say: (m) => (m[1] ? `${cap(m[1].toLowerCase())} bonus` : 'Bonus on offer') },
  { re: /\b(?:career|professional)\s+(?:growth|development|progression|advancement)\b|\bgrowth\s+opportunit(?:y|ies)\b/i,
    say: () => 'Career growth opportunity' },
  { re: /\btraining\s+(?:will\s+be\s+|is\s+)?(?:provided|given|offered)\b|\b(?:paid|free|on[- ]the[- ]job|complete|full)\s+training\b/i,
    say: () => 'Training provided' },
  { re: /\b(?:health|medical)\s+insurance\b|\bmediclaim\b/i, say: () => 'Health insurance' },
  { re: /\b(?:PF|ESIC?|[Pp]rovident\s+[Ff]und)\b/, say: (m, s) => {
    const pf = /\b(?:PF|[Pp]rovident\s+[Ff]und)\b/.test(s), esi = /\bESIC?\b/.test(s);
    return pf && esi ? 'PF and ESI benefits' : pf ? 'PF benefits' : 'ESI benefits';
  } },
  { re: /\bfree\s+(?:accommodation|stay|hostel)\b|\b(?:accommodation|stay|hostel)\s+(?:facility\s+)?(?:is\s+|will\s+be\s+)?(?:provided|available|given|offered)\b|\b(?:food|meals?)\s+(?:and|&)\s+accommodation\b/i,
    say: () => 'Accommodation provided' },
  { re: /\bfree\s+(?:food|meals?|lunch)\b|\bfood\s+(?:is\s+)?(?:provided|facility)\b/i, say: () => 'Food provided' },
  { re: /\b(?:cab|transport(?:ation)?)\s+(?:facility|is\s+provided|provided|available)\b|\bpick[- ]?up\s+(?:and|&)\s+drop\b/i,
    say: () => 'Transport facility' },
  { re: /\b(?:5|five)[- ]days?\s+(?:a\s+)?(?:work(?:ing)?\s+)?week\b/i, say: () => '5-day work week' },
  { re: /\bflexible\s+(?:working\s+)?(?:hours|timings?|schedule|shifts?)\b/i, say: () => 'Flexible working hours' },
  { re: /\b(?:build|develop|grow|manage|maintain)\w*\s+(?:strong\s+|long[- ]term\s+)?business\s+relationships?\b/i,
    say: () => 'Opportunity to develop business relationships' },
  { re: /\bwork(?:ing)?\s+(?:with|alongside)\s+(experienced|leading|senior|skilled|expert)\s+(doctors|healthcare\s+professionals|professionals|specialists|engineers)\b/i,
    say: (m) => `Work with ${m[1].toLowerCase()} ${m[2].toLowerCase().replace(/\s+/g, ' ')}` },
  { re: /\b(leading|reputed|renowned|premier|well[- ]known)\s+(hospitals?|company|companies|organi[sz]ations?|brands?|groups?|institutions?|firms?)\b/i,
    say: (m) => {
      const adj = m[1].toLowerCase().replace(/\s+/g, '-');
      const noun = m[2].toLowerCase();
      return /(s|ies)$/.test(noun) && !/^(?:company|organi[sz]ation)$/.test(noun)
        ? `Work with ${adj} ${noun}` : `Work with a ${adj} ${noun}`;
    } },
];
const NEGATION = /\b(no|not|without|nil|none|neither|nor|unpaid)\b|n't\b/i;
export const MAX_HIGHLIGHTS = 4;

/** 2-4 short highlights the description supports, or none. */
export function highlightsFrom(description) {
  const text = cleanField(String(description == null ? '' : description).replace(/<[^>]+>/g, ' '));
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+|\s*[\n•]\s*/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const rule of HIGHLIGHTS) {
    for (const s of sentences) {
      if (NEGATION.test(s)) continue;
      const m = rule.re.exec(s);
      if (!m) continue;
      const h = rule.say(m, s);
      if (h && !out.includes(h)) out.push(h);
      break;
    }
    if (out.length >= MAX_HIGHLIGHTS) break;
  }
  return out.length >= 2 ? out : [];
}

/* ------------------------------------------------------------------ *
 * the walk-in block (the owner's Share Job walk-in rules)
 * ------------------------------------------------------------------ */

const WALKIN_CARRY_DEFAULT = ['Updated Resume – Hard Copy', 'A copy of this Job Post'];
const WALKIN_GATE_NOTE = 'The job post copy must be shown at the main gate entrance.';

/** "09:00" -> "9:00 AM"; anything else as written. */
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return cleanField(t);
  let hh = Number(m[1]); const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${hh}:${m[2]} ${ap}`;
}
/** "2026-10-10" -> "10 October 2026"; anything else as written. */
function longDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim());
  if (!m) return cleanField(d);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
const mapLink = (u) => {
  const v = cleanField(u);
  return /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(v) ? v : '';
};

/** { heading, lines } for a walk-in job, from its own fields; null otherwise. */
function walkinBlock(j) {
  if (!isWalkinJob(j)) return null;
  const lines = [];
  const date = longDate(pick(j, ['walkinDate', 'walkin_date']));
  if (date) lines.push(`📅 Walk-In Date: ${date}`);
  const from = clock(pick(j, ['walkinStartTime', 'walkinFrom', 'walkin_from']));
  const to = clock(pick(j, ['walkinEndTime', 'walkinTo', 'walkin_to']));
  if (from || to) lines.push(`⏰ Interview Time: ${[from, to].filter(Boolean).join(' – ')}`);
  const carry = listOf(j.walkinDocumentsToCarry || j.walkinDocuments || j.walkin_documents);
  lines.push('📄 Please carry:', ...(carry.length ? carry : WALKIN_CARRY_DEFAULT).map((d) => `• ${d}`));
  lines.push(`⚠️ Important: ${WALKIN_GATE_NOTE}`);
  const notes = cleanField(j.walkinInstructions || j.walkin_instructions);
  if (notes) lines.push(`ℹ️ ${notes}`);
  const venue = pick(j, ['walkinVenue', 'walkin_venue']);
  const address = pick(j, ['walkinAddress', 'walkin_address']);
  const venueLines = [];
  if (venue) venueLines.push(venue);
  if (address && address !== venue) {
    venueLines.push(...String(j.walkinAddress || j.walkin_address).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  }
  const maps = mapLink(j.walkinMapLink || j.walkin_map_link);
  const phone = pick(j, ['walkinContactNumber', 'walkinPhone', 'walkin_phone']);
  const person = pick(j, ['walkinContactPerson', 'walkinContact', 'walkin_contact']);
  return {
    heading: '🚶 Walk-In Interview',
    lines,
    venue: venueLines,
    maps,
    contact: phone || person ? `📞 Contact: ${[person, phone].filter(Boolean).join(' – ')}` : '',
  };
}

/* ------------------------------------------------------------------ *
 * why it was sent: the heading and the opening line
 * ------------------------------------------------------------------ */

const OPENER = 'Hi! 👋 We found a job opportunity that could be a great match for your profile!';
const pct = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? `${Math.round(Number(n))}%` : '');

/*
 * The heading and the opener may say WHY this message was sent - only where
 * the alert already said so before this format. The body is identical for
 * every kind.
 */
function intro(kind, j, ctx) {
  const where = pick(j, ['location']);
  const at = (h) => (where ? `${h} – ${where}` : h);
  const match = pct(ctx.matchPercent);
  switch (kind) {
    case 'saved_search': {
      const label = cleanField(ctx.label);
      return { heading: at('🚀 NEW JOB OPPORTUNITY'),
        opener: label
          ? `Hi! 👋 A new job matching your saved search "${label}" has just been posted — it could be a great match for your profile!`
          : OPENER,
        sms: label ? `New job for "${label}"` : 'New job opportunity' };
    }
    case 'saved_job': {
      const t = cleanField(ctx.savedTitle);
      const bits = [safeCompany(ctx.savedCompany), cleanField(ctx.savedLocation)].filter(Boolean).join(' · ');
      return { heading: at('🚀 NEW JOB OPPORTUNITY'),
        opener: t
          ? `Hi! 👋 You saved "${t}"${bits ? ` (${bits})` : ''} on TeamLink. We found a new job like it that could be a great match for your profile!`
          : OPENER,
        sms: 'New job like one you saved' };
    }
    case 'urgent_hiring':
      return { heading: at('🚀 URGENT HIRING'),
        opener: `Hi! 👋 We found an urgent job opening that could be a great match for your profile${match ? ` (${match} match)` : ''}!`,
        sms: 'Urgent hiring' };
    case 'deadline_2d': {
      const d = cleanField(ctx.deadline);
      return { heading: at('⏳ LAST DATE TO APPLY IS APPROACHING'),
        opener: `Hi! 👋 Applications for this job close${d ? ` on ${d}` : ' soon'}, and you have not applied yet.`
          + (match ? ` Your AI Match for it is ${match}.` : ''),
        sms: `Last date to apply${d ? ` ${d}` : ''}` };
    }
    case 'deadline_today':
      return { heading: at('⏳ LAST DAY TO APPLY'),
        opener: 'Hi! 👋 Today is the last day to apply for this job, and you have not applied yet.'
          + (match ? ` Your AI Match for it is ${match}.` : ''),
        sms: 'Last day to apply' };
    default:   // profile_match, share
      return { heading: at('🚀 NEW JOB OPPORTUNITY'), opener: OPENER, sms: 'New job opportunity' };
  }
}

/* ------------------------------------------------------------------ *
 * the parts, once
 * ------------------------------------------------------------------ */

/**
 * Everything the message says, as data. Every renderer below reads this,
 * so no channel can print a fact another one left out.
 */
export function opportunityParts(job, opts = {}) {
  const j = job || {};
  const kind = opts.kind || 'profile_match';
  const company = safeCompany(opts.company);
  const walk = walkinBlock(j);
  const type = pick(j, ['type', 'employmentType', 'employment_type']);
  const stipend = Number(j.stipend);
  const pay = pick(j, ['pay', 'pay_label', 'payLabel', 'salary'])
    || (Number.isFinite(stipend) && stipend > 0 ? `₹${stipend} stipend` : '');
  const facts = [
    ['💼', 'Experience', pick(j, ['exp', 'exp_label', 'expLabel', 'experience']), true],
    ['🎓', 'Qualification', pick(j, ['education', 'qualification']), false],
    ['💰', 'Salary', pay, true],
    ['📍', 'Location', pick(j, ['location']), true],
    /* A walk-in's type is said by its walk-in block. */
    ['🕐', 'Job Type', walk && /^walk.?in$/i.test(type) ? '' : type, false],
    ['🏠', 'Work From Home', workFromHome(j.mode), false],
  ].filter((f) => f[2]);
  const tagline = cleanField(opts.tagline);
  return {
    kind,
    ...intro(kind, j, opts),
    title: cleanField(j.title),
    company,
    facts,
    requirements: requirementPoints(j.requirements),
    highlights: highlightsFrom(j.desc != null ? j.desc : j.description),
    walkin: walk,
    applyUrl: String(opts.applyUrl || '').trim(),
    tagline: tagline.length <= 120 ? tagline : '',
  };
}

/* ------------------------------------------------------------------ *
 * WhatsApp, in-app and plain text: the lines
 * ------------------------------------------------------------------ */

const LINK_LINE = Symbol('link');

/** WhatsApp *bold*, only around a value it cannot break. */
const boldWith = (on) => (s) => (on && s && !/[*\n]/.test(s) ? `*${s}*` : s);

function lines(p, { bold }) {
  const b = boldWith(bold);
  const out = [b(p.heading), '', p.opener];
  const head = [];
  if (p.title) head.push(`🏥 ${b(p.title)}`);
  if (p.company) head.push(`🏢 ${b(p.company)}`);
  if (head.length) out.push('', ...head);
  if (p.facts.length) out.push('', ...p.facts.map(([e, label, v, key]) => `${e} ${label}: ${key ? b(v) : v}`));
  if (p.requirements.length) out.push('', b('⭐ What We\'re Looking For'), ...p.requirements.map((r) => `✅ ${r}`));
  if (p.highlights.length) out.push('', b('🎯 Why Consider This Opportunity?'), ...p.highlights.map((h) => `✨ ${h}`));
  if (p.walkin) {
    const w = p.walkin;
    out.push('', b(w.heading), ...w.lines);
    if (w.venue.length) out.push('', '📍 Venue:', ...w.venue);
    if (w.maps) out.push(`📍 Get Directions: ${w.maps}`);
    if (w.contact) out.push(w.contact);
  }
  out.push('', b('👉 Interested? Explore the complete job details and apply now:'));
  if (p.applyUrl) out.push(LINK_LINE);
  out.push('📩 Don\'t miss this opportunity — apply today!');
  const foot = [p.company ? b(p.company) : '', p.tagline].filter(Boolean);
  if (foot.length) out.push('', ...foot);
  return out;
}

const join = (ls, url, withLink = true) => ls
  .filter((l) => l !== LINK_LINE || withLink)
  .map((l) => (l === LINK_LINE ? `🔗 ${url}` : l)).join('\n');

/* ------------------------------------------------------------------ *
 * SMS: compact on purpose
 * ------------------------------------------------------------------ */

const SMS_MAX = 320;

/**
 * Heading, title, company, location, salary and the link - nothing else.
 * Over the limit, the salary goes first, then the location, then the
 * company, then the title is shortened. The link is never cut.
 */
function smsText(p) {
  const pay = (p.facts.find((f) => f[1] === 'Salary') || [])[2] || '';
  const loc = (p.facts.find((f) => f[1] === 'Location') || [])[2] || '';
  const build = (title, co, where, salary) => {
    const role = [title, co ? `at ${co}` : ''].filter(Boolean).join(' ');
    return `TeamLink: ${p.sms}${role ? `: ${role}` : ''}${where ? `, ${where}` : ''}.`
      + (salary ? ` Salary: ${salary}.` : '') + (p.applyUrl ? ` Apply: ${p.applyUrl}` : '');
  };
  const tries = [[p.title, p.company, loc, pay], [p.title, p.company, loc, ''], [p.title, p.company, '', ''], [p.title, '', '', '']];
  for (const t of tries) { const s = build(...t); if (s.length <= SMS_MAX) return s; }
  const room = SMS_MAX - build('', '', '', '').length - 4;
  return build(room > 0 ? `${p.title.slice(0, room)}…` : '', '', '', '');
}

/* ------------------------------------------------------------------ *
 * email: the same content as HTML
 * ------------------------------------------------------------------ */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const P = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.62;color:#243449`;
const H = `margin:18px 0 8px;font-family:${FONT};font-size:15px;font-weight:700;color:#0f2540`;
const LI = `margin:0 0 6px;font-family:${FONT};font-size:14.5px;line-height:1.55;color:#243449`;

function emailParts(p) {
  const list = (items, mark) => items.map((x) => `<p style="${LI}">${mark} ${esc(x)}</p>`).join('');
  const body = [`<p style="${P}">${esc(p.opener)}</p>`];
  if (p.title || p.company) {
    body.push(`<p style="${P};font-size:16px">`
      + (p.title ? `🏥 <strong style="font-size:17px;color:#0f2540">${esc(p.title)}</strong>` : '')
      + (p.title && p.company ? '<br>' : '')
      + (p.company ? `🏢 <strong>${esc(p.company)}</strong>` : '') + '</p>');
  }
  if (p.facts.length) {
    body.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
      + 'style="background:#f7f9fc;border:1px solid #e4eaf2;border-radius:8px;margin:4px 0 6px">'
      + p.facts.map(([e, label, v, key]) => `<tr><td style="padding:7px 0 7px 14px;font-family:${FONT};font-size:13.5px;color:#6b7a90;white-space:nowrap;vertical-align:top">${e} ${esc(label)}</td>`
        + `<td style="padding:7px 14px 7px 12px;font-family:${FONT};font-size:14.5px;color:#243449${key ? ';font-weight:700' : ''}">${esc(v)}</td></tr>`).join('')
      + '</table>');
  }
  if (p.requirements.length) body.push(`<p style="${H}">⭐ What We're Looking For</p>`, list(p.requirements, '✅'));
  if (p.highlights.length) body.push(`<p style="${H}">🎯 Why Consider This Opportunity?</p>`, list(p.highlights, '✨'));
  if (p.walkin) {
    const w = p.walkin;
    body.push(`<p style="${H}">${esc(w.heading)}</p>`, w.lines.map((l) => `<p style="${LI}">${esc(l)}</p>`).join(''));
    if (w.venue.length) body.push(`<p style="${LI}">📍 Venue:<br>${w.venue.map(esc).join('<br>')}</p>`);
    if (w.maps) body.push(`<p style="${LI}">📍 <a href="${esc(w.maps)}" style="color:#1d6ff2">Get Directions</a></p>`);
    if (w.contact) body.push(`<p style="${LI}">${esc(w.contact)}</p>`);
  }
  body.push(`<p style="${H}">👉 Interested? Explore the complete job details and apply now:</p>`);
  const after = [];
  if (p.applyUrl) {
    after.push(`<p style="margin:4px 0 12px;font-family:${FONT};font-size:12.5px;line-height:1.5;color:#6b7a90;word-break:break-all">`
      + `🔗 <a href="${esc(p.applyUrl)}" style="color:#1d6ff2">${esc(p.applyUrl)}</a></p>`);
  }
  after.push(`<p style="${P}">📩 Don't miss this opportunity — apply today!</p>`);
  if (p.company || p.tagline) {
    after.push(`<p style="${P}">${p.company ? `<strong>${esc(p.company)}</strong>` : ''}`
      + (p.company && p.tagline ? '<br>' : '') + (p.tagline ? `<span style="color:#6b7a90">${esc(p.tagline)}</span>` : '') + '</p>');
  }
  return { bodyHtml: body.join(''), afterCtaHtml: after.join('') };
}

const DEFAULT_SUBJECT = (p) => [`New job opportunity: ${p.title || 'a new role'}`,
  p.facts.find((f) => f[1] === 'Location') ? p.facts.find((f) => f[1] === 'Location')[2] : ''].filter(Boolean).join(' – ');

/* ------------------------------------------------------------------ *
 * the API
 * ------------------------------------------------------------------ */

/**
 * Every channel's version of one job's message.
 *
 * @param job   the job (toJob() shape or a jobs row)
 * @param opts  { applyUrl, company, kind, matchPercent, label, savedTitle,
 *                savedCompany, savedLocation, deadline, tagline,
 *                email: { subject, note, stopLink, preheader, ctaLabel } }
 *        kind  profile_match | saved_search | saved_job | urgent_hiring |
 *              deadline_2d | deadline_today | share
 * @returns {{ whatsapp, inApp, text, body, sms, email:{subject,text,html}, parts }}
 */
export function jobOpportunityMessages(job, opts = {}) {
  const p = opportunityParts(job, opts);
  const boldLines = lines(p, { bold: true });
  const plainLines = lines(p, { bold: false });
  const whatsapp = join(boldLines, p.applyUrl);
  const text = join(plainLines, p.applyUrl);
  const e = opts.email || {};
  const subject = cleanField(e.subject) || DEFAULT_SUBJECT(p);
  const { bodyHtml, afterCtaHtml } = emailParts(p);
  const html = emailLayout({
    title: p.heading,
    preheader: e.preheader || [p.title, p.company, (p.facts.find((f) => f[1] === 'Location') || [])[2]].filter(Boolean).join(' · ') || p.heading,
    bodyHtml,
    cta: p.applyUrl ? { label: cleanField(e.ctaLabel) || 'View Job & Apply', url: p.applyUrl } : null,
    afterCtaHtml,
    note: e.note || '',
    stopLink: e.stopLink || null,
  });
  const emailText = text
    + (e.note ? `\n\n${e.note}` : '')
    + (e.stopLink && e.stopLink.url ? `\n\n${e.stopLink.label || 'Stop these emails'}: ${e.stopLink.url}` : '');
  return {
    whatsapp,
    inApp: whatsapp,
    text,
    /* The message without its "🔗 <link>" line - a phone's share sheet adds the URL itself. */
    body: join(boldLines, p.applyUrl, false),
    plainBody: join(plainLines, p.applyUrl, false),
    sms: smsText(p),
    email: { subject, text: emailText, html },
    parts: p,
  };
}

/**
 * One channel's version: 'whatsapp' | 'in_app' | 'text' | 'sms' return a
 * string; 'email' returns { subject, text, html }.
 */
export function jobOpportunityMessage(job, opts = {}) {
  const all = jobOpportunityMessages(job, opts);
  switch (opts.channel || 'whatsapp') {
    case 'email': return all.email;
    case 'sms': return all.sms;
    case 'text': return all.text;
    case 'in_app': case 'inApp': return all.inApp;
    default: return all.whatsapp;
  }
}
