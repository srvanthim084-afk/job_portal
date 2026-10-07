/**
 * The AI Hiring Demo - the real pipeline, step by step.
 *
 *   POST /api/ai-pipeline/run          { jobId, text?, applicationId? }
 *   GET  /api/ai-pipeline/applications the applications the viewer may run it on
 *
 * Resume parsing -> job matching -> AI screening -> ranking -> recommendation
 * -> AI interview -> report. Every number comes from the functions the product
 * itself uses:
 *
 *   parsing     resume/fields.js extractFields      (what an uploaded resume is read with)
 *   matching    ai/ai-match.js aiMatch              (JD skills matched / JD skills required)
 *   screening   ai/screening.js scoreApplication    (the admin-weighted screening and verdict)
 *   interview   ai/interview.js planInterview       (the real question planner; AI when a key is set)
 *   ranking     the real applications of that job   (visible to the viewer by row-level security)
 *
 * THREE WAYS IN, NONE OF THEM INVENTED:
 *   - text           anybody, signed in or not, pastes their own resume text and picks an open
 *                    TeamLink job. Nothing is stored; the text is not logged.
 *   - own profile    a signed-in candidate picks a job and no text: their saved profile is used.
 *   - applicationId  a real application the viewer may see (a candidate's own; a recruiter's or
 *                    admin's by RLS). Ranking and the screening verdict are for staff only - a
 *                    candidate never sees a score ranking or a decision about themselves.
 *
 * A human always makes the final decision; this never auto-rejects.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, ApiError, CODES } from '../errors.js';
import { requireAuth } from '../auth.js';
import { toJob, toCandidate } from '../shapes.js';
import { extractFields } from '../resume/fields.js';
import { aiMatch } from '../ai/ai-match.js';
import { loadAiSettings, scoreApplication } from '../ai/screening.js';
import { planInterview, aiConfigured } from '../ai/interview.js';

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AI_PIPELINE_RATE_MAX || 15),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'You are running the pipeline too quickly. Please wait a moment and try again.')),
});

const body = z.object({
  jobId: z.string().trim().min(1, 'Choose a job first.').max(80),
  text: z.string().max(12000, 'Keep the resume text under 12,000 characters.').optional(),
  applicationId: z.string().trim().max(80).optional(),
}).strict();

const isStaff = (s) => !!s && (s.role === 'recruiter' || s.role === 'admin');

const DIMS = ['skills', 'experience', 'education', 'location'];

function shapeScreening(sc, settings) {
  const b = sc.breakdown || {};
  const dims = {};
  for (const k of DIMS) {
    const v = b[k];
    if (v && typeof v === 'object' && Number.isFinite(Number(v.of)) && Number(v.of) > 0) {
      const scored = Math.max(0, Number(v.scored) || 0);
      dims[k] = { scored, of: Number(v.of), percent: Math.round((scored / Number(v.of)) * 100) };
    }
  }
  return {
    score: sc.score, verdict: sc.verdict, threshold: settings.autoShortlistThreshold,
    reasons: (sc.reasons || []).slice(0, 6).map((x) => String(x).slice(0, 200)), dimensions: dims,
  };
}

function recommend(verdict, am, hasSkills) {
  const gaps = (am.missing || []).slice(0, 4);
  if (verdict === 'shortlist') {
    return { level: 'strong', text: 'Strong match. Recommend fast-tracking to the AI interview and a recruiter shortlist within 24 hours.' };
  }
  if (am.score != null && am.score >= 60 && !hasSkills) {
    return { level: 'moderate', text: 'A good skills fit. Recommend a recruiter review before the next step.' };
  }
  if (verdict === 'hold') {
    return {
      level: 'low',
      text: `Below the automatic shortlist line. TeamLink AI never rejects anyone - a recruiter decides${gaps.length ? `. Skills to look at: ${gaps.join(', ')}` : ''}.`,
    };
  }
  return {
    level: 'moderate',
    text: `Needs a recruiter's review before going further${gaps.length ? ` - skills to look at: ${gaps.join(', ')}` : ''}.`,
  };
}

async function interviewPreview(job, candidate) {
  try {
    const qs = await planInterview({ job, candidate, count: 5 });
    return { engine: aiConfigured() ? 'ai' : 'rules', questions: qs.map((q) => String(q.question || '').slice(0, 300)).filter(Boolean).slice(0, 5) };
  } catch (err) {
    console.error('[ai-pipeline] interview planning failed:', err && err.message);
    return { engine: 'rules', questions: [], unavailable: true };
  }
}

export default function aiPipelineRoutes() {
  const r = Router();

  r.get('/ai-pipeline/applications', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select a.id, a.reference, a.job_id, j.title, a.applied_at, c2.name as candidate_name
         from applications a
         join jobs j on j.id = a.job_id
         join candidates c2 on c2.id = a.candidate_id
        order by a.applied_at desc nulls last limit 100`)).rows);
    res.json({
      applications: rows.map((a) => ({
        id: a.id, reference: a.reference || null, jobId: a.job_id, jobTitle: a.title || 'A job that is no longer listed',
        ...(isStaff(req.session) ? { candidateName: a.candidate_name } : {}),
        appliedAt: a.applied_at ? new Date(a.applied_at).toISOString() : null,
      })),
    });
  }));

  r.post('/ai-pipeline/run', limiter, wrap(async (req, res) => {
    const p = body.safeParse(req.body || {});
    if (!p.success) {
      const i = p.error.issues[0];
      throw badRequest(i && /Choose a job|Keep the resume/.test(i.message) ? i.message : 'Please check your request and try again.');
    }
    const { jobId, text, applicationId } = p.data;
    const session = req.session || null;
    const settings = await loadAiSettings();

    let jobRow; let candRow = null; let mode; let appRow = null; let ranking = { available: false, reason: 'Ranking compares real applicants, so it is shown to recruiters only.' };
    let existingInterview = null; let parseSource = 'resume text';

    if (applicationId) {
      if (!session) throw new ApiError(401, CODES.UNAUTHENTICATED || 'UNAUTHENTICATED', 'Please sign in to run the pipeline on an application.');
      mode = 'application';
      const got = await withUser(session, async (c) => {
        const a = (await c.query(`select a.* from applications a where a.id = $1`, [applicationId])).rows[0];
        if (!a) return null;
        const j = (await c.query(`select j.*, co.name as company_name from jobs j left join companies co on co.id = j.company_id where j.id = $1`, [a.job_id])).rows[0];
        const cd = (await c.query(`select * from candidates where id = $1`, [a.candidate_id])).rows[0];
        let rk = null; let iv = null;
        if (isStaff(session)) {
          rk = (await c.query(
            `select count(*)::int as total, count(*) filter (where coalesce(match_score,0) > coalesce($2::numeric,0))::int as ahead
               from applications where job_id = $1`, [a.job_id, a.match_score])).rows[0];
        }
        iv = (await c.query(
          `select status, overall_percentage, completed_at from ai_interviews where application_id = $1 order by created_at desc limit 1`, [a.id])).rows[0] || null;
        return { a, j, cd, rk, iv };
      });
      if (!got || !got.j || !got.cd) throw notFound('That application could not be found.');
      appRow = got.a; jobRow = got.j; candRow = got.cd; parseSource = 'the saved profile';
      if (got.rk) ranking = { available: true, rank: got.rk.ahead + 1, of: got.rk.total };
      if (got.iv) {
        existingInterview = { status: got.iv.status, completedOn: got.iv.completed_at ? new Date(got.iv.completed_at).toISOString().slice(0, 10) : null,
          ...(isStaff(session) && got.iv.overall_percentage != null ? { score: Number(got.iv.overall_percentage) } : {}) };
      }
    } else {
      jobRow = await withUser(session, async (c) => (await c.query(
        `select j.*, co.name as company_name from jobs_open j left join companies co on co.id = j.company_id
          where j.id = $1 and j.source_type = 'TEAMLINK'`, [jobId])).rows[0]);
      if (!jobRow) throw notFound('That job is not open, or does not exist.');
      if (text && text.trim().length >= 40) {
        mode = 'resume';
      } else if (session && session.role === 'candidate') {
        mode = 'profile'; parseSource = 'the saved profile';
        candRow = await withUser(session, async (c) => (await c.query(`select * from candidates where id = app_candidate_id()`)).rows[0] || null);
        if (!candRow) throw badRequest('Add your details to your TeamLink profile first, or paste your resume text.');
      } else {
        throw badRequest('Paste your resume text (at least a few lines) so the pipeline has something to read.');
      }
    }

    const job = toJob(jobRow);
    let candidate; let parse;
    if (mode === 'resume') {
      const { fields, found } = extractFields(text);
      candidate = {
        name: fields.name || '', email: fields.email || '', phone: fields.phone || '', location: fields.location || '',
        title: fields.title || '', currentCompany: fields.currentCompany || '', education: fields.education || '',
        skills: fields.skills || [], expYears: fields.expYears ?? null, exp: fields.expYears != null ? `${fields.expYears} yrs` : '',
        summary: fields.summary || '', resumeText: text,
      };
      parse = { source: parseSource, found, name: candidate.name, location: candidate.location, title: candidate.title,
        experience: fields.expYears != null ? `${fields.expYears} yr${fields.expYears === 1 ? '' : 's'}` : '', education: candidate.education,
        skills: candidate.skills.slice(0, 20), contact: candidate.email ? true : false };
    } else {
      candidate = toCandidate(candRow);
      parse = { source: parseSource, found: null, name: candidate.name || '', location: candidate.location || '', title: candidate.title || '',
        experience: candidate.exp || '', education: candidate.education || '', skills: (candidate.skills || []).slice(0, 20),
        contact: !!(candidate.email || candidate.phone) };
    }

    const am = aiMatch(job, candidate);
    const sc = scoreApplication({ job, candidate, settings });
    const showVerdict = mode !== 'application' || isStaff(session);
    const interview = await interviewPreview(job, candidate);

    res.json({
      mode,
      engine: aiConfigured() ? 'ai' : 'rules',
      job: { id: job.id, title: job.title, company: jobRow.company_name || '', location: job.location || '', skills: job.skills || [], pay: job.pay || '' },
      parse,
      match: { score: am.score, required: am.required, matchedCount: am.matchedCount, matched: am.matched, missing: am.missing,
        basis: am.score == null ? 'The job lists no skills, so there is no skills match.' : 'JD skills matched / JD skills required' },
      screening: showVerdict ? shapeScreening(sc, settings) : null,
      ranking: mode === 'application' ? ranking : { available: false, reason: 'Ranking compares real applicants, so it is not part of a try-out.' },
      recommendation: showVerdict ? { ...recommend(sc.verdict, am, am.stated), humanDecides: true }
        : { level: 'info', text: 'Your recruiter reviews every application. Add the missing skills to your profile to strengthen it.', humanDecides: true },
      interview: { ...interview, existing: existingInterview },
      application: appRow ? { id: appRow.id, reference: appRow.reference || null, stage: appRow.stage } : null,
      notice: 'TeamLink AI never auto-rejects or auto-selects a candidate. A human recruiter makes the final decision.',
    });
  }));

  return r;
}
