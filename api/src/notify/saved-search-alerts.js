/**
 * Saved searches that tell you when something new turns up.
 *
 *   instant   when a job is published, every instant search it matches
 *             is told at once (and the sweep below catches any job that
 *             reached the board some other way)
 *   daily     08:00 IST, one message per candidate, up to five jobs
 *   weekly    Monday 08:00 IST, the same
 *
 * What it will NOT send:
 *   - a job twice for one search: candidate_saved_search_hits is keyed
 *     (search, job) and a hit is announced once;
 *   - a job the candidate already heard about from the profile-match
 *     alert (job_matches.notified), applied to, or hid;
 *   - a job that is closed, paused or archived by the time it would go;
 *   - SMS or WhatsApp between 21:00 and 08:00 IST - those are recorded
 *     as skipped_quiet_hours, and the email still goes;
 *   - anything to somebody marked do-not-contact, or on a channel they
 *     opted out of;
 *   - WhatsApp without an approved template (Notification Settings ->
 *     WhatsApp template name): business-initiated WhatsApp is rejected by
 *     Meta without one, so it is recorded not_configured, not attempted.
 *
 * Every channel attempt is a row in candidate_saved_search_deliveries with the
 * provider's own answer. Nothing is reported as sent that was not.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { buildSavedSearchMessages } from './templates.js';
import { toCandidate, toJob } from '../shapes.js';
import { jobMatchesFilters, locationTierFunction } from '../search/saved-match.js';

/** The engine: no person behind it. 0086's functions admit only this. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

const CHANNELS = ['email', 'sms', 'whatsapp'];
const DIGEST_MAX = 5;
const IST_MS = 330 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * time, in India
 * ------------------------------------------------------------------ */

/** The wall clock in IST, as a Date whose UTC fields read as IST. */
const ist = (now) => new Date(now + IST_MS);

/** No SMS or WhatsApp from 21:00 to 08:00 IST. */
export function inQuietHours(now = Date.now()) {
  const h = ist(now).getUTCHours();
  return h >= 21 || h < 8;
}

/**
 * The most recent digest slot at or before `now`, as a UTC timestamp:
 * today 08:00 IST (daily) or this Monday 08:00 IST (weekly). A search
 * whose last_digest_at is older than its slot is due.
 */
export function digestSlot(kind, now = Date.now()) {
  const d = ist(now);
  const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0) - IST_MS;
  let at = now >= slot ? slot : slot - 86400000;
  if (kind === 'weekly') {
    const dow = ist(at).getUTCDay();             // 0 Sunday … 1 Monday
    at -= ((dow + 6) % 7) * 86400000;
  }
  return at;
}

/* ------------------------------------------------------------------ *
 * "Stop this alert" - a link that works without signing in
 * ------------------------------------------------------------------ */

const sig = (id) => createHmac('sha256', config.authSecret)
  .update(`saved-search-stop:${id}`).digest('base64url');

export function stopToken(id) { return `${id}.${sig(id)}`; }

/** The search id the token was issued for, or null. */
export function verifyStopToken(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const id = s.slice(0, dot);
  const given = Buffer.from(s.slice(dot + 1));
  const want = Buffer.from(sig(id));
  if (given.length !== want.length) return null;
  return timingSafeEqual(given, want) ? id : null;
}

const base = () => config.publicOrigin.replace(/\/$/, '');
const jobUrl = (id, searchId) => `${base()}/?ss=${encodeURIComponent(searchId)}#/job/${encodeURIComponent(id)}`;
const searchUrl = (id) => `${base()}/#/candidate/alerts?run=${encodeURIComponent(id)}`;
const stopUrl = (id) => `${base()}/api/saved-searches/stop?token=${encodeURIComponent(stopToken(id))}`;

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

/*
 * toJob passes published_at through as the driver's Date object, and
 * Date.parse() of a Date goes via its string form - which has no
 * milliseconds. A job published in the same second as a search was saved
 * then looked OLDER than the search and was never counted. ISO it is.
 */
export function asMatchable(r) {
  const j = { ...toJob(r), companyName: r.company_name || '' };
  if (r.published_at) j.publishedAt = new Date(r.published_at).toISOString();
  return j;
}

async function openJobs(c, ids) {
  const where = ids ? 'and j.id = any($1)' : '';
  const { rows } = await c.query(
    `select j.*, co.name as company_name
       from jobs j left join companies co on co.id = j.company_id
      where j.status = 'open' and not coalesce(j.paused, false)
        and not coalesce(j.archived, false) ${where}`, ids ? [ids] : []);
  return rows.map(asMatchable);
}

/** Who each candidate is, and what they must not be told about. */
async function candidateFacts(c, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cands = (await c.query(`select * from candidates where id = any($1)`, [ids])).rows;
  for (const r of cands) {
    out.set(r.id, { cand: toCandidate(r), skip: new Set() });
  }
  const add = (rows) => rows.forEach((r) => { const f = out.get(r.candidate_id); if (f) f.skip.add(r.job_id); });
  add((await c.query(`select candidate_id, job_id from applications where candidate_id = any($1)`, [ids])).rows);
  add((await c.query(`select candidate_id, job_id from hidden_jobs where candidate_id = any($1)`, [ids])).rows);
  add((await c.query(
    `select candidate_id, job_id from job_matches where notified and candidate_id = any($1)`, [ids])).rows);
  return out;
}

async function templateIds(c) {
  try {
    const { rows } = await c.query(
      `select event_key, template_id from notification_templates
        where event_key in ('saved_search_alert','saved_search_digest')`);
    return Object.fromEntries(rows.map((r) => [r.event_key, r.template_id]));
  } catch { return {}; }
}

/* ------------------------------------------------------------------ *
 * sending
 * ------------------------------------------------------------------ */

/** One candidate, one message, every channel they chose. */
async function deliver({ search, cand, kind, jobs, total, label, templateId, now }) {
  const messages = buildSavedSearchMessages({
    candidateName: cand.name,
    label,
    kind,
    total,
    jobs: jobs.map((j) => ({
      title: j.title, company: j.companyName, location: j.location, pay: j.pay,
      url: jobUrl(j.id, search.id),
    })),
    searchUrl: searchUrl(search.id),
    stopUrl: stopUrl(search.id),
  });

  const waCfg = await channelSettings('whatsapp').catch(() => ({}));
  const quiet = inQuietHours(now);
  const result = {};

  for (const channel of CHANNELS) {
    if (!(search.channels || []).includes(channel)) continue;
    const to = channel === 'email' ? cand.email : cand.phone;
    let r;
    if (cand.doNotContact) r = { status: 'skipped_opted_out', provider: channel, error: 'do not contact' };
    else if (!to) r = { status: 'skipped_no_address', provider: channel };
    else if (channel === 'email' && cand.emailOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'sms' && cand.smsOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'whatsapp' && !cand.whatsappOptIn) r = { status: 'skipped_opted_out', provider: channel, error: 'not opted in' };
    else if (channel !== 'email' && quiet) r = { status: 'skipped_quiet_hours', provider: channel, error: '21:00-08:00 IST' };
    else if (channel === 'whatsapp' && !(waCfg && waCfg.templateName)) {
      r = { status: 'not_configured', provider: 'whatsapp',
            error: 'no approved WhatsApp template is set in Notification Settings' };
    } else {
      try {
        r = await providers[channel].send({
          to,
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms
              : channel === 'whatsapp' ? messages.whatsapp : messages.email.text,
          templateId: channel === 'email' ? (templateId || undefined) : undefined,
          vars: {
            to_name: cand.name, candidate_name: cand.name,
            job_title: jobs[0] ? jobs[0].title : '', company_name: jobs[0] ? jobs[0].companyName : '',
            portal_link: jobs.length === 1 ? jobUrl(jobs[0].id, search.id) : searchUrl(search.id),
            subject: messages.email.subject, message: messages.email.text,
          },
        });
      } catch (err) {
        r = { status: 'failed', provider: channel, error: err.message };
      }
    }
    result[channel] = r.status;
    await withUser(ENGINE, (c) => c.query(
      `select saved_search_delivery_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [search.id, search.candidate_id, kind, channel, r.status, to || null,
       r.provider || null, r.ref || null, r.error || null, jobs.map((j) => j.id)]))
      .catch((err) => console.error('[saved-search] could not record a delivery:', err.message));
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * instant: the moment a job is published
 * ------------------------------------------------------------------ */

/**
 * Tell every instant search this job matches, and record a hit on every
 * daily/weekly one so the digest has it.
 */
export async function runSavedSearchInstant(jobId, opts = {}) {
  const now = opts.now ?? Date.now();
  const tier = await locationTierFunction();

  const data = await withUser(ENGINE, async (c) => {
    const [job] = await openJobs(c, [jobId]);
    if (!job) return null;
    const searches = (await c.query(
      `select * from saved_search_engine_list($1)`, [['instant', 'daily', 'weekly']])).rows;
    const hits = [];
    for (const s of searches) {
      if (!jobMatchesFilters(job, s.filters, { now, locationTier: tier })) continue;
      const fresh = (await c.query(`select saved_search_hit_add($1,$2) as n`, [s.id, job.id])).rows[0].n;
      if (fresh) hits.push(s);
    }
    const instant = hits.filter((s) => s.alert_frequency === 'instant');
    const facts = await candidateFacts(c, [...new Set(instant.map((s) => s.candidate_id))]);
    return { job, instant, facts, tpl: await templateIds(c), hits: hits.length };
  });
  if (!data) return { jobId, skipped: 'job is not open', recorded: 0, sent: 0 };

  let sent = 0;
  for (const s of data.instant) {
    const f = data.facts.get(s.candidate_id);
    if (!f) continue;
    if (!f.skip.has(data.job.id)) {
      const r = await deliver({ search: s, cand: f.cand, kind: 'instant', jobs: [data.job], total: 1,
        label: s.label, templateId: data.tpl.saved_search_alert, now });
      if (Object.values(r).includes('sent')) sent += 1;
    }
    // Announced or deliberately not: either way it is done for this search.
    await withUser(ENGINE, (c) => c.query(`select saved_search_mark_alerted($1,$2)`, [s.id, [data.job.id]]));
  }
  return { jobId, recorded: data.hits, instant: data.instant.length, sent };
}

/* ------------------------------------------------------------------ *
 * the sweep: digests, and instant searches the publish hook missed
 * ------------------------------------------------------------------ */

/**
 * @param opts { now, kinds:['instant','daily','weekly'] }
 */
export async function runSavedSearchSweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const kinds = opts.kinds || ['instant', 'daily', 'weekly'];
  const tier = await locationTierFunction();

  const plan = await withUser(ENGINE, async (c) => {
    const searches = (await c.query(`select * from saved_search_engine_list($1)`, [kinds])).rows;
    // Due: instant always; a digest once a slot has passed since it was
    // last processed - or since it was made, so a daily search saved at
    // 15:00 waits for tomorrow's 08:00 instead of firing at 15:10.
    const due = searches.filter((s) => s.alert_frequency === 'instant'
      || new Date(s.last_digest_at || s.created_at).getTime() < digestSlot(s.alert_frequency, now));
    if (!due.length) return null;

    const jobs = await openJobs(c);
    const byId = new Map(jobs.map((j) => [j.id, j]));

    // Catch jobs published since the search was made that no hook saw.
    for (const s of due) {
      const since = new Date(s.created_at).getTime();
      for (const j of jobs) {
        if (!j.publishedAt || Date.parse(j.publishedAt) < since) continue;
        if (jobMatchesFilters(j, s.filters, { now, locationTier: tier })) {
          await c.query(`select saved_search_hit_add($1,$2)`, [s.id, j.id]);
        }
      }
      s.pending = (await c.query(`select * from saved_search_pending($1)`, [s.id])).rows.map((r) => r.job_id);
    }
    const facts = await candidateFacts(c, [...new Set(due.map((s) => s.candidate_id))]);
    return { due, byId, facts, tpl: await templateIds(c) };
  });
  if (!plan) return { due: 0, messages: 0, sent: 0 };

  const out = { due: plan.due.length, messages: 0, sent: 0 };

  // Group: one instant message per (search, job); one digest per candidate.
  const digests = new Map();
  for (const s of plan.due) {
    const f = plan.facts.get(s.candidate_id);
    const live = s.pending.filter((id) => plan.byId.has(id) && !(f && f.skip.has(id)));
    const dropped = s.pending.filter((id) => !live.includes(id));

    if (s.alert_frequency === 'instant') {
      for (const id of live) {
        if (!f) break;
        const r = await deliver({ search: s, cand: f.cand, kind: 'instant', jobs: [plan.byId.get(id)],
          total: 1, label: s.label, templateId: plan.tpl.saved_search_alert, now });
        out.messages += 1;
        if (Object.values(r).includes('sent')) out.sent += 1;
      }
      if (s.pending.length) {
        await withUser(ENGINE, (c) => c.query(`select saved_search_mark_alerted($1,$2)`, [s.id, s.pending]));
      }
      continue;
    }

    if (dropped.length) {
      await withUser(ENGINE, (c) => c.query(`select saved_search_mark_alerted($1,$2)`, [s.id, dropped]));
    }
    const key = `${s.candidate_id}|${s.alert_frequency}`;
    const g = digests.get(key) || { kind: s.alert_frequency, candidateId: s.candidate_id, searches: [] };
    g.searches.push({ s, live });
    digests.set(key, g);
  }

  for (const g of digests.values()) {
    const f = plan.facts.get(g.candidateId);
    const withJobs = g.searches.filter((x) => x.live.length).sort((a, b) => b.live.length - a.live.length);
    if (f && withJobs.length) {
      const ids = [...new Set(withJobs.flatMap((x) => x.live))];
      const jobs = ids.map((id) => plan.byId.get(id))
        .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
      const lead = withJobs[0].s;
      const label = withJobs.length === 1 ? lead.label
        : `${lead.label} + ${withJobs.length - 1} more search${withJobs.length > 2 ? 'es' : ''}`;
      const r = await deliver({ search: lead, cand: f.cand, kind: g.kind, jobs: jobs.slice(0, DIGEST_MAX),
        total: jobs.length, label, templateId: plan.tpl.saved_search_digest, now });
      out.messages += 1;
      if (Object.values(r).includes('sent')) out.sent += 1;
      for (const x of withJobs) {
        await withUser(ENGINE, (c) => c.query(`select saved_search_mark_alerted($1,$2)`, [x.s.id, x.live]));
      }
    }
    for (const x of g.searches) {
      await withUser(ENGINE, (c) => c.query(`select saved_search_digest_done($1)`, [x.s.id]));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the timer
 * ------------------------------------------------------------------ */

const EVERY_MS = Number(process.env.SAVED_SEARCH_SWEEP_MS || 10 * 60 * 1000);

/**
 * Every ten minutes. Each run is idempotent - a hit is announced once
 * and a digest slot is processed once - so a restart, or two runs close
 * together, cannot send anything twice.
 */
export function startSavedSearchAlerts() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSavedSearchSweep();
      if (r.messages) console.log(`[saved-search] ${r.messages} message(s), ${r.sent} delivered`);
    } catch (err) {
      console.error('[saved-search] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Number(process.env.SAVED_SEARCH_FIRST_MS || 90_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
