/**
 * AI screening, for everybody who applies.
 *
 * Screening was a button: a recruiter opened an application, pressed "Run
 * AI Screening", and a moment later it moved. That works for ten
 * applications a week and fails for a hundred a day - the ones nobody
 * pressed the button on simply sat there, unscored, indistinguishable
 * from the ones that had been looked at and rejected.
 *
 * Every application is now screened the moment it exists, whichever way
 * it arrived: the portal, Easy Apply, a Naukri email, an import. The
 * recruiter's decision is what to DO with the score, not whether to
 * produce one.
 *
 * THE SCORE IS THE ADMIN'S, NOT MINE
 *
 * `app_settings.ai` already carries weights - skills 45, experience 30,
 * education 15, location 10 - and an auto-shortlist threshold of 80.
 * Those were settings with nothing reading them. The score is computed
 * with exactly those numbers, so changing them in AI Settings changes
 * what the pipeline does, which is what a setting is for.
 *
 * The evidence comes from the same matcher the job alerts use, so "78%"
 * means the same thing on an alert and on an application.
 */
import { withUser } from '../db.js';
import { toJob, toCandidate } from '../shapes.js';
import { matchCandidate } from './match.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const DEFAULTS = {
  autoShortlistThreshold: 80,
  weightSkills: 45,
  weightExperience: 30,
  weightEducation: 15,
  weightLocation: 10,
  autoScreeningEnabled: true,
};

export async function loadAiSettings() {
  try {
    const row = await withUser(ENGINE, async (c) =>
      (await c.query(`select value from app_settings where key='ai'`)).rows[0]);
    return { ...DEFAULTS, ...(row ? row.value : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Score one application against its requirement.
 *
 * @returns {{score, verdict, reasons, matched, missing, breakdown}}
 */
export function scoreApplication({ job, candidate, settings = DEFAULTS }) {
  const m = matchCandidate(job, candidate, { threshold: settings.autoShortlistThreshold });
  const b = m.breakdown || {};

  // The matcher's dimensions are scored out of its own weights; rescale
  // each to 0..1 and reapply the ADMIN's weights, so AI Settings is the
  // thing that decides.
  const unit = (dim, max) => {
    const v = b[dim] && Number(b[dim].score);
    if (!Number.isFinite(v) || !max) return 0;
    return Math.max(0, Math.min(1, v / max));
  };

  const parts = [
    { key: 'skills', unit: unit('skills', 40), weight: Number(settings.weightSkills) || 0 },
    { key: 'experience', unit: unit('experience', 20), weight: Number(settings.weightExperience) || 0 },
    { key: 'education', unit: unit('education', 5), weight: Number(settings.weightEducation) || 0 },
    { key: 'location', unit: unit('location', 15), weight: Number(settings.weightLocation) || 0 },
  ];

  const totalWeight = parts.reduce((t, p) => t + p.weight, 0) || 1;
  const score = Math.round(parts.reduce((t, p) => t + p.unit * p.weight, 0) / totalWeight * 100);

  const threshold = Number(settings.autoShortlistThreshold) || 80;
  const verdict = score >= threshold ? 'shortlist'
    : score >= threshold - 15 ? 'review'
    : 'hold';

  const matched = (b.skills && b.skills.matched) || [];
  const missing = (b.skills && b.skills.missing) || [];

  const reasons = [];
  if (matched.length) reasons.push(`matches ${matched.join(', ')}`);
  if (missing.length) reasons.push(`no evidence of ${missing.join(', ')}`);
  if (b.experience) {
    if (b.experience.fit === 'inside') reasons.push('experience is inside the band');
    else if (b.experience.fit === 'near') reasons.push('experience is just outside the band');
    else if (b.experience.fit === 'far') reasons.push('experience is well outside the band');
    else if (b.experience.fit === 'unknown') reasons.push('no experience on the profile');
  }
  if (b.location && b.location.reason) reasons.push(`location: ${b.location.reason}`);
  if (b.education && b.education.reason && b.education.reason !== 'not specified') {
    reasons.push(b.education.reason);
  }

  return {
    score,
    verdict,
    threshold,
    reasons,
    matched,
    missing,
    breakdown: parts.reduce((o, p) => {
      o[p.key] = { of: p.weight, scored: Math.round(p.unit * p.weight) };
      return o;
    }, {}),
  };
}

/**
 * Screen one application and write the result.
 *
 * Deliberately cautious about the stage: a passing score moves an
 * application from `applied` to `shortlisted`, and nothing else moves at
 * all. A low score does NOT reject anybody - that is a person's decision,
 * and an automatic rejection is the one mistake this system must never
 * make on its own.
 *
 * @returns {Promise<object|null>} the screening result, or null
 */
export async function screenApplication(applicationId, { actor = 'system', force = false } = {}) {
  const settings = await loadAiSettings();

  const ctx = await withUser(ENGINE, async (c) => {
    const app = (await c.query(`select * from applications where id=$1`, [applicationId])).rows[0];
    if (!app) return null;
    const job = (await c.query(
      `select j.*, co.name as company_name from jobs j
         left join companies co on co.id = j.company_id where j.id=$1`, [app.job_id])).rows[0];
    const cand = (await c.query(`select * from candidates where id=$1`, [app.candidate_id])).rows[0];
    return { app, job, cand };
  });

  if (!ctx || !ctx.job || !ctx.cand) return null;

  /*
   * Already screened - unless the resume has arrived since.
   *
   * A score is computed the moment an application exists, which is
   * usually before anybody has attached a CV: the candidate uploads five
   * minutes later, or a recruiter does it next morning. The score on
   * screen was then worked out from a record with no resume behind it
   * and never changed, so the CV might as well not have been sent.
   */
  const screenedAt = ctx.app.ai_screened_at ? new Date(ctx.app.ai_screened_at) : null;
  const resumeAt = ctx.cand.resume_uploaded_at ? new Date(ctx.cand.resume_uploaded_at) : null;
  const resumeIsNewer = !!(resumeAt && screenedAt && resumeAt > screenedAt);
  if (!force && ctx.app.ai_score != null && !resumeIsNewer) return null;

  /*
   * The resume goes in beside the profile, and NOT through toCandidate().
   *
   * toCandidate() is the shape every API response is built from, so
   * putting the text there would return somebody's whole CV to every
   * screen that lists candidates. It is read here, server-side, by the
   * one thing that needs it.
   */
  const result = scoreApplication({
    job: { ...toJob(ctx.job), companyName: ctx.job.company_name },
    candidate: { ...toCandidate(ctx.cand), resumeText: ctx.cand.resume_text || '' },
    settings,
  });

  /*
   * Screening is a STEP, not a place to sit.
   *
   * A failing score used to move the application INTO `ai_screening` and
   * leave it there, so the recruiter's list became a column of identical
   * "AI Screening" badges - one per candidate, saying nothing about any
   * of them, and hiding the score that had just been worked out. The
   * stage told you the software had run; it never told you the answer.
   *
   * Now a score that passes shortlists, and a score that does not leaves
   * the application exactly where it was - at `applied`, its real
   * position in the pipeline - with the score attached and on screen.
   * Nobody is rejected either way: that stays a person's decision.
   */
  const movable = ['applied', 'ai_screening'].includes(ctx.app.stage);
  const nextStage = movable
    ? (result.verdict === 'shortlist' ? 'shortlisted' : 'applied')
    : ctx.app.stage;

  const note = `AI screening ${result.score}% (threshold ${result.threshold}) - `
    + `${result.verdict === 'shortlist' ? 'recommend shortlist'
       : result.verdict === 'review' ? 'worth a look' : 'gaps against the requirement'}`
    + (result.reasons.length ? `: ${result.reasons.join('; ')}` : '');

  await withUser(ENGINE, async (c) => {
    await c.query(`select set_config('app.stage_note', $1, true)`, [note.slice(0, 500)]);
    await c.query(
      `update applications
          set ai_score = $2,
              match_score = coalesce(match_score, $2),
              stage = $3,
              -- So "was this score worked out before the resume arrived?"
              -- has an answer, which is what decides a re-screen.
              ai_screened_at = now(),
              updated_at = now()
        where id = $1`,
      [applicationId, result.score, nextStage]);

    await c.query(
      `select app_event($1,$2,'screening.completed',$3,$4,$5::jsonb)`,
      [applicationId, ctx.app.candidate_id, note, actor, JSON.stringify({
        score: result.score, verdict: result.verdict, threshold: result.threshold,
        matched: result.matched, missing: result.missing, breakdown: result.breakdown,
      })]).catch(() => {});

    // The recruiter who owns the requirement hears about it, because a
    // screened application nobody looks at is the same as an unscreened
    // one.
    const recruiterId = ctx.app.recruiter_id || ctx.job.recruiter_id;
    if (recruiterId) {
      await c.query(
        `select notify_create($1,$2,'recruiter','AI_SCREENING',$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [`ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
         recruiterId,
         `${ctx.cand.name} - ${result.score}% for ${ctx.job.title}`,
         note.slice(0, 400),
         ctx.job.id, applicationId, ctx.app.candidate_id, recruiterId,
         JSON.stringify({ score: result.score, verdict: result.verdict })]).catch(() => {});
    }
  });

  return { applicationId, ...result, stage: nextStage };
}

/**
 * Screen everything that has not been screened.
 *
 * Runs on a timer as well as on demand: an application created while the
 * screener was failing, or before screening existed at all, must not stay
 * unscored forever.
 */
export async function screenPending({ limit = 200 } = {}) {
  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select id from applications
      where ai_score is null and stage in ('applied','ai_screening')
      order by applied_at desc limit $1`, [limit])).rows);

  const out = { considered: rows.length, screened: 0, shortlisted: 0, failed: 0 };
  for (const r of rows) {
    try {
      const res = await screenApplication(r.id, { actor: 'system' });
      if (res) {
        out.screened++;
        if (res.verdict === 'shortlist') out.shortlisted++;
      }
    } catch (err) {
      out.failed++;
      console.error(`[screening] ${r.id} failed:`, err.message);
    }
  }
  return out;
}

/** The background pass. Returns a stop function. */
export function startScreeningSweep() {
  const every = Number(process.env.SCREENING_SWEEP_MS || 10 * 60 * 1000);
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await screenPending({ limit: 100 });
      if (out.screened) {
        console.log(`[screening] ${out.screened} application(s) screened, ${out.shortlisted} shortlisted`);
      }
    } catch (err) {
      console.error('[screening] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, Number(process.env.SCREENING_FIRST_MS || 20_000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
