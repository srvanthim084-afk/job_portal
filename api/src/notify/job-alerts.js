/**
 * Publish a requirement, reach the people it actually fits.
 *
 * Posting a job used to be silent: it appeared on the board and waited
 * for somebody to find it. Every candidate already in the database — the
 * ones we spent money acquiring — heard nothing, and a recruiter's only
 * option was to search the list by hand and message people one at a time.
 *
 * This runs the matching engine over every candidate profile when a job
 * is published, records the decision for each one, and messages the ones
 * that clear the bar on email, SMS and WhatsApp.
 *
 * Three things it deliberately does NOT do:
 *
 *   - message on one keyword. api/src/ai/match.js applies hard gates
 *     before the score is even consulted;
 *   - message the same candidate about the same job twice. The unique
 *     (job_id, candidate_id) row is the guard, and an already-notified
 *     match is skipped;
 *   - claim a delivery it did not get. A channel with no credentials
 *     records `not_configured`, and a candidate with no phone records
 *     `skipped_no_address`.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { buildEventMessages } from './templates.js';
import { matchJob, DEFAULT_THRESHOLD } from '../ai/match.js';
import { toCandidate, toJob } from '../shapes.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];

const newId = () =>
  `jm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Matching reads every candidate, including private profiles the posting
 * recruiter may not see — because the alert is for the CANDIDATE, not for
 * the recruiter. It exists only inside the server process and is never
 * derived from a cookie.
 */
const ENGINE_SESSION = { userId: '', role: 'admin', profileId: null };

/** How many alerts one publish may send. A guard, not a policy. */
const MAX_ALERTS = Number(process.env.JOB_MATCH_MAX_ALERTS || 200);

/**
 * Score every profile against one job and notify the matches.
 *
 * @param jobId     the job that was just published
 * @param opts      { threshold, notify }  notify:false scores without sending
 * @returns {Promise<{jobId, considered, matched, notified, threshold, matches}>}
 */
export async function runJobAlerts(jobId, opts = {}) {
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  const notify = opts.notify !== false;

  const data = await withUser(ENGINE_SESSION, async (c) => {
    const job = (await c.query(
      `select j.*, co.name as company_name
         from jobs j left join companies co on co.id = j.company_id
        where j.id = $1`, [jobId])).rows[0];
    if (!job) return null;

    // Only live postings alert. A draft, a paused or an archived job
    // reaching people's phones is the worst kind of bug to explain.
    if (job.status !== 'open' || job.paused || job.archived) {
      return { job, candidates: [], skip: `job is ${job.paused ? 'paused' : job.status}` };
    }

    const candidates = (await c.query(
      `select * from candidates order by updated_at desc nulls last limit 5000`)).rows;

    // Who has already been told about this job, and who already applied.
    const already = (await c.query(
      `select candidate_id, notified from job_matches where job_id=$1`, [jobId])).rows;
    const applied = (await c.query(
      `select candidate_id from applications where job_id=$1`, [jobId])).rows;

    return {
      job,
      candidates,
      notifiedAlready: new Set(already.filter((r) => r.notified).map((r) => r.candidate_id)),
      appliedAlready: new Set(applied.map((r) => r.candidate_id)),
    };
  });

  if (!data) return { jobId, error: 'no such job', considered: 0, matched: 0, notified: 0 };
  if (data.skip) {
    return { jobId, skipped: data.skip, considered: 0, matched: 0, notified: 0, threshold };
  }

  const job = toJob(data.job);
  job.companyName = data.job.company_name || 'TeamLink';
  const scored = matchJob(job, data.candidates.map(toCandidate), { threshold });

  const out = {
    jobId,
    jobTitle: job.title,
    threshold,
    considered: scored.considered,
    matched: scored.notified,
    notified: 0,
    skipped: 0,
    matches: [],
  };

  let sent = 0;
  for (const m of scored.matches) {
    const cand = m.candidate;

    // Every candidate scored gets a row, match or not: "why was this
    // person not contacted" is a question the ATS has to be able to
    // answer, and it cannot answer it from rows that were never written.
    const id = newId();
    const matchId = await withUser(ENGINE_SESSION, async (c) =>
      (await c.query(
        `select job_match_record($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as id`,
        [id, jobId, cand.id, m.score, threshold, m.reason,
         m.matchedSkills, JSON.stringify(m.breakdown)])).rows[0].id);

    if (!m.notify) continue;

    out.matches.push({
      matchId, candidateId: cand.id, score: m.score,
      matchedSkills: m.matchedSkills, reason: m.reason,
    });

    if (!notify) continue;
    if (data.appliedAlready.has(cand.id)) { out.skipped++; continue; }
    if (data.notifiedAlready.has(cand.id)) { out.skipped++; continue; }
    if (sent >= MAX_ALERTS) { out.skipped++; continue; }

    const delivered = await sendAlert({ matchId, job, cand, match: m });
    out.notified += Object.values(delivered).some((s) => s === 'sent') ? 1 : 0;
    out.matches[out.matches.length - 1].delivery = delivered;
    sent++;
  }

  return out;
}

/** One candidate, three channels, every outcome recorded. */
async function sendAlert({ matchId, job, cand, match }) {
  const base = config.publicOrigin.replace(/\/$/, '');
  // Straight to the job, with the alert id so a click can be recorded
  // against the message that caused it.
  const jobUrl = `${base}/?alert=${encodeURIComponent(matchId)}#/job/${job.id}`;

  const messages = buildEventMessages('JOB_MATCH_ALERT', {
    candidateName: cand.name,
    jobTitle: job.title,
    company: job.companyName || 'TeamLink',
    jobId: job.id,
    applicationId: null,
    location: job.location,
    expLabel: job.exp,
    payLabel: job.pay,
    matchedSkills: match.matchedSkills,
    portalUrl: jobUrl,
    linkLabel: 'View job & apply',
    smsLead: `New job matching your profile: ${job.title}` +
             `${job.location ? ` - ${job.location}` : ''}. View & apply:`,
  });

  const status = {};
  for (const channel of CHANNELS) {
    const to = channel === 'email' ? cand.email : cand.phone;
    let result;

    if (!to) {
      result = { status: 'skipped_no_address', provider: channel };
    } else if (channel === 'whatsapp' && cand.whatsappOptIn === false) {
      // Opt-in is a promise, not a preference to be overridden by a
      // marketing feature.
      result = { status: 'skipped_no_address', provider: 'whatsapp', error: 'not opted in' };
    } else {
      try {
        result = await providers[channel].send({
          to,
          vars: {
            to_name: cand.name,
            candidate_name: cand.name,
            job_title: job.title,
            company_name: job.companyName || '',
            portal_link: jobUrl,
          },
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms
              : channel === 'whatsapp' ? messages.whatsapp
              : messages.email.text,
        });
      } catch (err) {
        result = { status: 'failed', provider: channel, error: err.message };
      }
    }

    status[channel] = result.status;
    await withUser(ENGINE_SESSION, (c) =>
      c.query(`select job_match_delivery($1,$2,$3,$4,$5,$6,$7)`,
        [matchId, channel, result.status, to || null,
         result.provider || null, result.ref || null, result.error || null]))
      .catch((err) => console.error('[alerts] could not record a delivery:', err.message));
  }

  return status;
}

/**
 * Fire and forget, for the request that published the job.
 *
 * Matching five thousand profiles and sending three messages each must
 * not hold up the response to "save job" — and must never fail it: the
 * job is published either way, which is the thing the recruiter asked
 * for.
 */
export function runJobAlertsInBackground(jobId, opts) {
  setTimeout(() => {
    runJobAlerts(jobId, opts)
      .then((r) => {
        if (r.notified || r.matched) {
          console.log(`[alerts] ${jobId}: ${r.matched} matched of ${r.considered} ` +
                      `profiles, ${r.notified} notified (threshold ${r.threshold})`);
        }
      })
      .catch((err) => console.error(`[alerts] ${jobId} failed:`, err.message));
  }, 10).unref?.();
}
