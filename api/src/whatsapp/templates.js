/**
 * WhatsApp Business templates, the way a recruiter sends them (0158).
 *
 * ONE TEMPLATE STORE. A template is a row of `comm_templates` (kind 'whatsapp') that also has a wa_name, wa_language, wa_status and a
 * `wa` document. Nothing here keeps a second copy.
 *
 * HOW A TEMPLATE IS WRITTEN. Meta stores a body as "Hello {{1}}, ... {{2}}". The portal stores the same body with the FIELD in place of
 * the number - "Hello {{candidate_name}}, ... {{job_title}}" - which is what a recruiter reads, and derives the numbering from the
 * order the fields appear in (the n-th placeholder is {{n}}). `wa.params` is that ordered list of fields, so the parameters sent to Meta
 * are always in the order Meta expects. A body synced from Meta whose numbers have not been mapped to a field yet keeps its {{n}}; such
 * a template is listed but cannot be sent until each number says which candidate field fills it.
 *
 * ONLY APPROVED TEMPLATES GO OUT, and "approved" is Meta's word (wa_status), plus the portal's own approval and a complete mapping. There
 * is no free-text path here: a business-initiated WhatsApp message outside the 24-hour window must be an approved template.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { badRequest, ApiError } from '../errors.js';

export const COMPANY = 'TeamLink Consultants';

/* ------------------------------------------------------------------ *
 * the fields a template may use
 * ------------------------------------------------------------------ */
export const WA_VARIABLES = [
  { key: 'candidate_name',     label: "Candidate's full name",            example: 'Rahul Kumar' },
  { key: 'first_name',         label: 'First name',                       example: 'Rahul' },
  { key: 'job_title',          label: 'Job title',                        example: 'Software Developer' },
  { key: 'application_status', label: 'Application status',               example: 'Shortlisted' },
  { key: 'company_name',       label: 'Company name',                     example: COMPANY },
  { key: 'recruiter_name',     label: "Recruiter's name",                 example: 'Priya' },
  { key: 'interview_date',     label: 'Interview date',                   example: '15 Oct 2026' },
  { key: 'interview_time',     label: 'Interview time',                   example: '11:00 AM' },
  { key: 'job_location',       label: 'Job location',                     example: 'Hyderabad' },
  { key: 'job_id',             label: 'Job reference (for a link button)', example: 'job_123' },
  { key: 'job_link',           label: 'Job link',                         example: 'https://teamlink.example/#/job/job_123' },
  { key: 'location',           label: "Candidate's location",             example: 'Nellore' },
  { key: 'notice_period',      label: 'Notice period',                    example: '30 days' },
];
const KEYS = new Set(WA_VARIABLES.map((v) => v.key));
const label = (k) => (WA_VARIABLES.find((v) => v.key === k) || { label: k }).label;

const NAMED = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;
const NUMBERED = /\{\{\s*(\d+)\s*\}\}/g;

/** The fields a friendly body uses, in the order they appear (a field used twice is two parameters). */
export const occurrences = (body) => [...String(body || '').matchAll(NAMED)].map((m) => m[1].toLowerCase());

/** Friendly body -> Meta's numbered body. */
export function toMetaBody(body) {
  let n = 0;
  return String(body || '').replace(NAMED, () => `{{${++n}}}`);
}

/** Meta's numbered body + the field for each number -> the friendly body. A number with no field yet stays a number. */
export function fromMetaBody(text, params) {
  return String(text || '').replace(NUMBERED, (whole, n) => {
    const k = (params || [])[Number(n) - 1];
    return k ? `{{${k}}}` : whole;
  });
}

/* ------------------------------------------------------------------ *
 * phone numbers
 * ------------------------------------------------------------------ */
/**
 * The number WhatsApp needs: digits only, country code first. A ten-digit Indian mobile gets 91.
 * @returns {{ok:boolean, number?:string, reason?:string}}
 */
export function normalizePhone(raw) {
  const cc = String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (!d) return { ok: false, reason: 'no mobile number' };
  if (d.startsWith('00')) d = d.slice(2);
  if (cc === '91') {
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    if (d.length === 10) d = '91' + d;
    if (d.startsWith('91') && d.length === 12 && !/^[6-9]/.test(d[2])) return { ok: false, reason: 'not a valid Indian mobile number' };
  } else if (d.length <= 10) {
    d = cc + d;
  }
  if (d.length < 11 || d.length > 15) return { ok: false, reason: 'not a valid WhatsApp number' };
  return { ok: true, number: d };
}

/* ------------------------------------------------------------------ *
 * what a template needs before it can be sent
 * ------------------------------------------------------------------ */
const HEADER_MEDIA = ['image', 'document', 'video'];

/** Why a template cannot be sent yet; an empty list means it can. */
export function unsendable(t) {
  const why = [];
  const wa = t.wa || {};
  if (t.kind !== 'whatsapp' || !t.wa_name) why.push('not a WhatsApp Business template');
  if (t.archived) why.push('archived');
  if (t.approval_state !== 'approved') why.push('waiting for approval in the portal');
  if (t.wa_status !== 'approved') why.push(t.wa_status ? `WhatsApp status is "${t.wa_status}", not approved` : 'not approved by WhatsApp');
  if ((wa.params || []).some((k) => !k)) why.push('some {{numbers}} are not matched to a candidate field yet');
  if (wa.header && wa.header.type === 'text' && wa.header.param === '?') why.push('the header variable is not matched to a field');
  if (wa.header && HEADER_MEDIA.includes(wa.header.type) && !wa.header.mediaUrl) why.push('the header needs its media link');
  for (const b of wa.buttons || []) {
    if (b.type === 'url' && /\{\{\s*\d+\s*\}\}/.test(b.url || '') && !b.urlParam) why.push('a link button variable is not matched to a field');
  }
  return why;
}

/* ------------------------------------------------------------------ *
 * the template a recruiter or admin saves, cleaned
 * ------------------------------------------------------------------ */
const problem = (details) => badRequest('Please check the highlighted fields and try again.', details);

/**
 * Validate what the admin form (or a sync) hands over and return what is stored.
 * Throws a 400 whose `details` name the field.
 */
export function cleanTemplate(input) {
  const d = {};
  const i = input || {};
  const waName = String(i.waName || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(waName)) d.waName = 'The WhatsApp template name uses lower-case letters, numbers and underscores only (as in WhatsApp Manager).';
  const language = String(i.language || '').trim();
  if (!/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(language)) d.language = 'Use a WhatsApp language code such as en, en_US or te.';
  const name = String(i.name || '').trim();
  if (!name) d.name = 'Give the template a name.';

  const body = String(i.body || '').trim();
  if (!body) d.body = 'The message body is required.';
  else if (body.length > 1024) d.body = 'WhatsApp bodies are at most 1024 characters.';
  const params = occurrences(body);
  const unknown = [...new Set(params.filter((k) => !KEYS.has(k)))];
  if (unknown.length) d.body = `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `{{${k}}}`).join(', ')}. Use ${WA_VARIABLES.map((v) => `{{${v.key}}}`).join(', ')}.`;
  const numbered = [...body.matchAll(NUMBERED)].length;

  const footer = String(i.footer || '').trim();
  if (footer.length > 60) d.footer = 'A WhatsApp footer is at most 60 characters.';
  if (/\{\{/.test(footer)) d.footer = 'A WhatsApp footer cannot contain variables.';

  const header = { type: 'none' };
  const ht = String(i.headerType || 'none').toLowerCase();
  if (['text', ...HEADER_MEDIA].includes(ht)) {
    header.type = ht;
    if (ht === 'text') {
      const text = String(i.headerText || '').trim();
      if (!text) d.headerText = 'Write the header text, or choose no header.';
      if (text.length > 60) d.headerText = 'A header is at most 60 characters.';
      const hp = occurrences(text);
      const hnum = /\{\{\s*1\s*\}\}/.test(text);
      if (hp.length + (hnum ? 1 : 0) > 1) d.headerText = 'A WhatsApp header can hold one variable at most.';
      if (hp[0] && !KEYS.has(hp[0])) d.headerText = `Unknown field {{${hp[0]}}}.`;
      const hk = hp[0] || (hnum ? String(i.headerParam || '').trim() : '');
      if (hnum && !KEYS.has(hk)) d.headerText = 'Match the header variable {{1}} to a candidate field.';
      header.text = text;
      header.param = hk || null;
    } else {
      const url = String(i.headerMediaUrl || '').trim();
      if (url && !/^https:\/\/\S+$/i.test(url)) d.headerMediaUrl = 'The media link must be a public https:// address.';
      header.mediaUrl = url || null;
    }
  }

  const buttons = [];
  const src = Array.isArray(i.buttons) ? i.buttons : [];
  if (src.length > 10) d.buttons = 'A WhatsApp template has at most 10 buttons.';
  src.slice(0, 10).forEach((b, n) => {
    const type = String(b && b.type || '').toLowerCase();
    const text = String(b && b.text || '').trim();
    if (!['quick_reply', 'url', 'phone'].includes(type)) { d[`buttons.${n}`] = 'Unknown button type.'; return; }
    if (!text || text.length > 25) { d[`buttons.${n}`] = 'A button needs text of at most 25 characters.'; return; }
    const out = { type, text };
    if (type === 'url') {
      const url = String(b.url || '').trim();
      if (!/^https:\/\/\S+$/i.test(url)) { d[`buttons.${n}`] = 'A link button needs a full https:// address.'; return; }
      out.url = url;
      if (/\{\{\s*\d+\s*\}\}/.test(url)) {
        const p = String(b.urlParam || '').trim();
        if (p && !KEYS.has(p)) { d[`buttons.${n}`] = `Unknown field ${p}.`; return; }
        out.urlParam = p || null;
      }
    }
    if (type === 'phone') {
      const ph = String(b.phone || '').replace(/[^\d+]/g, '');
      if (ph.replace(/\D/g, '').length < 8) { d[`buttons.${n}`] = 'A call button needs a phone number.'; return; }
      out.phone = ph;
    }
    buttons.push(out);
  });

  const fallbacks = {};
  for (const [k, v] of Object.entries(i.fallbacks || {})) {
    if (KEYS.has(k) && String(v || '').trim()) fallbacks[k] = String(v).trim().slice(0, 120);
  }

  const status = String(i.waStatus || 'approved').toLowerCase();
  if (!['approved', 'pending', 'rejected', 'paused', 'disabled', 'draft'].includes(status)) d.waStatus = 'Unknown status.';

  /* a body with {{1}} {{2}} cannot be used until each number is matched to a field */
  if (numbered && params.length) d.body = 'Use either the field names ({{candidate_name}}) or numbers ({{1}}) in the body, not both.';
  if (numbered) {
    const seq = [...body.matchAll(NUMBERED)].map((m) => Number(m[1]));
    if (seq.some((x, n) => x !== n + 1)) d.body = 'The numbered variables must appear in order: {{1}}, {{2}}, {{3}} ...';
  }
  if (Object.keys(d).length) throw problem(d);

  let finalBody = body;
  let mapped = params;
  if (numbered) {
    mapped = Array.from({ length: numbered }, (_, n) => (KEYS.has((i.params || [])[n]) ? i.params[n] : null));
    finalBody = fromMetaBody(body, mapped);
    if (mapped.every(Boolean)) mapped = occurrences(finalBody);
  }
  const wa = {
    category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(String(i.category || '').toUpperCase()) ? String(i.category).toUpperCase() : 'UTILITY',
    header, footer: footer || null, buttons,
    params: mapped,
    fallbacks,
    metaId: i.metaId || null,
    syncedAt: i.syncedAt || null,
  };
  return {
    waName, language, name, body: finalBody, wa, waStatus: status,
    department: String(i.department || '').trim().slice(0, 80) || null,
    usedIn: Array.isArray(i.usedIn) ? i.usedIn.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : null,
  };
}

/** What a stored template looks like to the screens. */
export function shapeTemplate(t) {
  const wa = t.wa || {};
  const why = unsendable(t);
  return {
    id: t.id, name: t.name, waName: t.wa_name, language: t.wa_language, status: t.wa_status,
    category: wa.category || null,
    header: wa.header || { type: 'none' }, body: t.body, footer: wa.footer || null, buttons: wa.buttons || [],
    params: (wa.params || []).map((k, n) => ({ position: n + 1, key: k || null, label: k ? label(k) : null })),
    fallbacks: wa.fallbacks || {},
    approval: t.approval_state, version: t.version, source: t.source, archived: !!t.archived,
    department: t.department, syncedAt: wa.syncedAt || null,
    sendable: why.length === 0, notSendableBecause: why,
  };
}

/* ------------------------------------------------------------------ *
 * filling a template in for ONE candidate
 * ------------------------------------------------------------------ */
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
/* WhatsApp rejects parameters with line breaks, tabs or runs of spaces, and longer than 1024 */
const param = (v) => clean(v).slice(0, 1024);

const fmtDate = (d) => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** The value of every field for one candidate (empty string where the database has nothing). */
export function valuesFor(ctx) {
  const c = ctx.candidate;
  const name = clean(c.name);
  return {
    candidate_name: name,
    first_name: name.split(' ')[0] || '',
    job_title: clean(ctx.jobTitle || ''),
    application_status: clean(ctx.statusLabel || ''),
    company_name: COMPANY,
    recruiter_name: clean(ctx.recruiterName || ''),
    interview_date: fmtDate(ctx.interviewDate),
    interview_time: clean(ctx.interviewTime || ''),
    job_location: clean(ctx.jobLocation || ''),
    job_id: clean(ctx.jobId || ''),
    job_link: ctx.jobId ? `${String(config.publicOrigin || '').replace(/\/$/, '')}/#/job/${ctx.jobId}` : '',
    location: clean(c.location),
    notice_period: clean(c.notice_period),
  };
}

/**
 * Fill the template in: the text the recruiter previews AND the exact parameters that are sent.
 * A field with no value uses the template's fallback; with neither, it is `missing` and this candidate is not sent.
 */
export function fill(t, values) {
  const wa = t.wa || {};
  const fb = wa.fallbacks || {};
  const missing = new Set();
  const get = (k) => {
    if (!k) return '';
    const v = clean(values[k]);
    if (v) return v;
    if (fb[k]) return fb[k];
    missing.add(k);
    return '';
  };
  let n = 0;
  const bodyParams = [];
  const body = String(t.body || '').replace(/\{\{\s*([a-z][a-z0-9_]*|\d+)\s*\}\}/gi, (whole, key) => {
    n += 1;
    const field = /^\d+$/.test(key) ? (wa.params || [])[Number(key) - 1] : String(key).toLowerCase();
    if (!field) { missing.add(`{{${key}}}`); return whole; }
    const v = get(field);
    bodyParams.push(param(v));
    return v;
  });

  const header = { ...(wa.header || { type: 'none' }) };
  let headerParam = null;
  if (header.type === 'text') {
    if (header.param && header.param !== '?') {
      headerParam = param(get(header.param));
      header.text = String(header.text).replace(/\{\{\s*(?:[a-z][a-z0-9_]*|\d+)\s*\}\}/gi, () => headerParam);
    }
  }

  const buttons = (wa.buttons || []).map((b) => {
    if (b.type !== 'url') return { ...b };
    let suffix = null;
    if (/\{\{\s*\d+\s*\}\}/.test(b.url || '') && b.urlParam) suffix = param(get(b.urlParam));
    return { ...b, shownUrl: suffix == null ? b.url : String(b.url).replace(NUMBERED, suffix), suffix };
  });

  return {
    header, body, footer: wa.footer || null, buttons,
    bodyParams, headerParam,
    missing: [...missing].map((k) => (k.startsWith('{{') ? k : label(k))),
    missingKeys: [...missing],
  };
}

/** The exact request body's `template` object for the Cloud API. */
export function buildPayload(t, f) {
  const wa = t.wa || {};
  const components = [];
  if (wa.header && wa.header.type === 'text' && f.headerParam != null) {
    components.push({ type: 'header', parameters: [{ type: 'text', text: f.headerParam }] });
  } else if (wa.header && HEADER_MEDIA.includes(wa.header.type) && wa.header.mediaUrl) {
    components.push({ type: 'header', parameters: [{ type: wa.header.type, [wa.header.type]: { link: wa.header.mediaUrl } }] });
  }
  if (f.bodyParams.length) components.push({ type: 'body', parameters: f.bodyParams.map((text) => ({ type: 'text', text })) });
  (wa.buttons || []).forEach((b, index) => {
    const fb = f.buttons[index];
    if (b.type === 'url' && fb && fb.suffix != null) {
      components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: fb.suffix }] });
    }
  });
  return { name: t.wa_name, language: { code: t.wa_language }, components };
}

/* ------------------------------------------------------------------ *
 * who the candidates are, in this recruiter's rights
 * ------------------------------------------------------------------ */
/**
 * Everything a message needs about each candidate, in four queries (never one per candidate).
 *
 * Which application a candidate's job and status come from: an application the caller names; else the application for the job the
 * caller chose; else their most recent application. A candidate with no application has no job title or status - those are then
 * "missing" unless the template has a fallback.
 */
export async function loadContext(session, { candidateIds = [], applicationIds = [], jobId = null }) {
  const ids = [...new Set(candidateIds)];
  return withUser(session, async (c) => {
    const apps = applicationIds.length
      ? (await c.query(
          `select a.id, a.candidate_id, a.job_id, a.stage, a.applied_at from applications a where a.id = any($1)`, [applicationIds])).rows
      : [];
    for (const a of apps) if (!ids.includes(a.candidate_id)) ids.push(a.candidate_id);

    const cands = ids.length ? (await c.query(
      `select id, name, email, phone, title, preferred_role, location, current_company, notice_period,
              do_not_contact, availability_status, whatsapp_opt_in
         from candidates where id = any($1)`, [ids])).rows : [];

    const explicit = new Map(apps.map((a) => [a.candidate_id, a]));
    const need = ids.filter((id) => !explicit.has(id));
    let picked = [];
    if (need.length) {
      picked = (await c.query(
        jobId
          ? `select distinct on (a.candidate_id) a.id, a.candidate_id, a.job_id, a.stage, a.applied_at
               from applications a where a.candidate_id = any($1) and a.job_id = $2
              order by a.candidate_id, a.applied_at desc`
          : `select distinct on (a.candidate_id) a.id, a.candidate_id, a.job_id, a.stage, a.applied_at
               from applications a where a.candidate_id = any($1)
              order by a.candidate_id, a.applied_at desc`,
        jobId ? [need, jobId] : [need])).rows;
    }
    const appOf = new Map([...explicit, ...picked.map((a) => [a.candidate_id, a])]);

    const jobIds = [...new Set([...appOf.values()].map((a) => a.job_id).concat(jobId ? [jobId] : []))];
    const jobs = jobIds.length ? new Map((await c.query(
      `select id, title, location from jobs where id = any($1)`, [jobIds])).rows.map((j) => [j.id, j])) : new Map();
    /* the candidate's own word for the stage (0051/0052): never the internal one - 'Shortlisted', not 'Recruiter Review' */
    const stages = new Map((await c.query(`select id, coalesce(candidate_label, label) as label from stages`)).rows.map((s) => [s.id, s.label]));

    const ivs = ids.length ? (await c.query(
      `select distinct on (candidate_id) candidate_id, job_id, scheduled_date, scheduled_time
         from interviews
        where candidate_id = any($1) and status = 'Scheduled' and scheduled_date >= current_date
        order by candidate_id, scheduled_date, scheduled_time`, [ids])).rows : [];
    const ivOf = new Map(ivs.map((x) => [x.candidate_id, x]));

    let recruiterName = '';
    if (session.role === 'recruiter' && session.profileId) {
      recruiterName = ((await c.query(`select name from recruiters where id = $1`, [session.profileId])).rows[0] || {}).name || '';
    }
    const job = jobId ? jobs.get(jobId) || null : null;

    const out = new Map();
    for (const cand of cands) {
      const app = appOf.get(cand.id) || null;
      const j = (app && jobs.get(app.job_id)) || job || null;
      const iv = ivOf.get(cand.id) || null;
      out.set(cand.id, {
        candidate: cand,
        applicationId: app ? app.id : null,
        jobId: j ? j.id : null,
        jobTitle: j ? j.title : '',
        jobLocation: j ? j.location : '',
        statusLabel: app ? (stages.get(app.stage) || app.stage) : '',
        interviewDate: iv ? iv.scheduled_date : null,
        interviewTime: iv ? iv.scheduled_time : '',
        recruiterName: recruiterName || (session.role === 'admin' ? 'TeamLink Recruitment Team' : ''),
      });
    }
    return out;
  });
}

/* ------------------------------------------------------------------ *
 * the templates themselves
 * ------------------------------------------------------------------ */
export async function loadTemplate(session, id) {
  return withUser(session, async (c) => (await c.query(
    `select * from comm_templates where id = $1 and kind = 'whatsapp' and wa_name is not null`, [id])).rows[0] || null);
}

export async function listTemplates(session, { all = false } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select * from comm_templates where kind = 'whatsapp' and wa_name is not null ${all ? '' : 'and not archived'}
      order by (wa_status = 'approved') desc, name`)).rows);
}

/* ------------------------------------------------------------------ *
 * "Sync from WhatsApp Business": the templates Meta already approved
 * ------------------------------------------------------------------ */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/** One template from Meta's list, in the shape cleanTemplate / the table want. */
export function fromMeta(m, existing) {
  const comps = Array.isArray(m.components) ? m.components : [];
  const find = (t) => comps.find((x) => String(x.type).toUpperCase() === t);
  const hdr = find('HEADER'), bod = find('BODY'), ftr = find('FOOTER'), btn = find('BUTTONS');
  const metaBody = String((bod && bod.text) || '');
  const count = [...metaBody.matchAll(NUMBERED)].length;
  /* keep the mapping an administrator already made, as long as the body still has the same shape */
  const old = existing && existing.wa ? existing.wa : {};
  const sameShape = existing && toMetaBody(existing.body) === metaBody;
  const params = sameShape ? (old.params || []) : Array.from({ length: count }, () => null);
  const header = { type: 'none' };
  if (hdr) {
    const f = String(hdr.format || 'TEXT').toLowerCase();
    if (f === 'text') {
      header.type = 'text'; header.text = String(hdr.text || '');
      header.param = /\{\{\s*\d+\s*\}\}/.test(header.text) ? ((old.header && old.header.param) || '?') : null;
    } else if (HEADER_MEDIA.includes(f)) {
      header.type = f; header.mediaUrl = (old.header && old.header.mediaUrl) || null;
    }
  }
  const buttons = (btn && Array.isArray(btn.buttons) ? btn.buttons : []).map((b, n) => {
    const t = String(b.type).toUpperCase();
    const prev = (old.buttons || [])[n] || {};
    if (t === 'URL') return { type: 'url', text: b.text, url: b.url, urlParam: prev.urlParam || null };
    if (t === 'PHONE_NUMBER') return { type: 'phone', text: b.text, phone: b.phone_number };
    return { type: 'quick_reply', text: b.text };
  });
  const status = String(m.status || '').toLowerCase();
  return {
    waName: m.name, language: m.language, name: existing ? existing.name : m.name,
    body: fromMetaBody(metaBody, params),
    wa: {
      category: m.category || old.category || 'UTILITY', header, footer: ftr ? ftr.text : null, buttons, params,
      fallbacks: old.fallbacks || {}, metaId: m.id || null, syncedAt: new Date().toISOString(),
    },
    waStatus: ['approved', 'pending', 'rejected', 'paused', 'disabled'].includes(status) ? status : (status === 'in_appeal' ? 'pending' : 'draft'),
  };
}

/** Ask WhatsApp Business which templates this account has, and store them (administrator only; the caller checks). */
export async function syncFromMeta(session, actorName) {
  const businessId = config.waBusinessId || process.env.WHATSAPP_BUSINESS_ID || '';
  if (!config.whatsappApiKey || !businessId) {
    throw new ApiError(409, 'WHATSAPP_NOT_CONFIGURED',
      'WhatsApp Business is not connected: the access token and the WhatsApp Business account ID are needed (Admin → Integrations → WhatsApp Business).');
  }
  const base = String(config.whatsappApiUrl).replace(/\/$/, '');
  let url = `${base}/${encodeURIComponent(businessId)}/message_templates?fields=name,language,status,category,components&limit=100`;
  const found = [];
  for (let page = 0; url && page < 20; page += 1) {
    let res;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${config.whatsappApiKey}` }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new ApiError(502, 'WHATSAPP_UNREACHABLE', `WhatsApp did not answer: ${err.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(502, 'WHATSAPP_REFUSED', `WhatsApp refused the request (${res.status}): ${String((json.error && json.error.message) || 'no reason given').slice(0, 250)}`);
    }
    found.push(...(json.data || []));
    url = json.paging && json.paging.next ? json.paging.next : null;
  }

  const stats = { found: found.length, added: 0, updated: 0, unchanged: 0, needsMapping: 0 };
  for (const m of found) {
    const existing = await withUser(ENGINE, async (c) => (await c.query(
      `select * from comm_templates where wa_name = $1 and wa_language = $2 and not archived`, [m.name, m.language])).rows[0]);
    const t = fromMeta(m, existing);
    const row = await withUser(session, async (c) => (await c.query(
      `select * from comm_template_wa_upsert($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [existing ? existing.id : `wa_${m.name}_${m.language}`.slice(0, 80), t.waName, t.language, t.name, t.body, JSON.stringify(t.wa),
       t.waStatus, existing ? existing.department : null, existing ? existing.used_in : ['WhatsApp messages'],
       existing ? existing.source : 'meta', actorName || 'TeamLink'])).rows[0]);
    if (!existing) stats.added += 1;
    else if (row.version > existing.version) stats.updated += 1;
    else stats.unchanged += 1;
    if ((t.wa.params || []).some((k) => !k)) stats.needsMapping += 1;
  }
  return stats;
}
