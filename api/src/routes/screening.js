/**
 * Screening questions (0097).
 *
 *   GET  /api/jobs/:id/screening-questions          staff: the full set with rules;
 *                                                   anybody else: the public set
 *                                                   (+ pre-fill for a candidate)
 *   PUT  /api/jobs/:id/screening-questions          the job's owner: replace the set
 *   POST /api/screening/suggestions                 typed suggestions from the AI JD Generator
 *   GET  /api/screening/settings                    standard questions + answer weight
 *   PUT  /api/screening/settings                    admin
 *   GET  /api/screening/applications?jobId=&ids=    badges / columns for a list
 *   GET  /api/screening/applications/:id            the answers panel
 *   POST /api/screening/applications/:id/answers    "Answered on call by <recruiter>"
 *   POST /api/screening/applications/:id/reopen     a fresh link, sent now
 *   POST /api/screening/send                        bulk "Send screening questions"
 *   POST /api/screening/link/view                   the no-password page: what to ask
 *   POST /api/screening/link/submit                 the no-password page: the answers
 *
 * The link token travels in the request BODY, never in a path or query
 * string, so it does not end up in an access log.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCandidate } from '../shapes.js';
import {
  validateQuestionSet, fromRow, publicQuestion, prefillFor, suggestQuestions, mentionsCompany,
  STD_KEYS, TYPES, MAX_QUESTIONS,
} from '../screening/questions.js';
import {
  ENGINE, jobQuestionsInternal, prepareAnswers, storeAnswers, rescreen, sendLink, resolveLink,
  summarise, loadScreeningSettings,
} from '../screening/service.js';

const STAFF = ['recruiter', 'admin', 'bde'];
const newId = () => `sq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

const answersSchema = z.array(z.object({
  questionId: z.string().trim().min(1).max(64), answer: z.any(),
})).max(12);

async function staffName(c, session) {
  try {
    if (session.role === 'recruiter') {
      const r = (await c.query(`select name from recruiters where id=$1`, [session.profileId])).rows[0];
      if (r && r.name) return r.name;
    }
    if (session.role === 'admin') {
      const r = (await c.query(`select name from admins where id=$1`, [session.profileId])).rows[0];
      if (r && r.name) return r.name;
    }
  } catch { /* fall through */ }
  return session.email || 'the recruiter';
}

export default function screeningRoutes() {
  const r = Router();

  /* ---------------- a job's questions ---------------- */

  r.get('/jobs/:id/screening-questions', wrap(async (req, res) => {
    const s = req.session;
    const jobId = String(req.params.id).slice(0, 64);
    if (s && STAFF.includes(s.role)) {
      const out = await withUser(s, async (c) => {
        const job = (await c.query(`select id from jobs where id=$1`, [jobId])).rows[0];
        if (!job) return null;
        const rows = (await c.query(
          `select * from job_screening_questions where job_id=$1 order by position, created_at`, [jobId])).rows;
        const editable = (await c.query(`select screening_job_writer($1) as ok`, [jobId])).rows[0].ok;
        const st = (await c.query(`select auto_reject_knockouts from job_screening_settings where job_id=$1`, [jobId])).rows[0];
        return { rows, editable, autoRejectKnockouts: !!(st && st.auto_reject_knockouts) };
      });
      if (!out) throw notFound('That job could not be found.');
      return res.json({
        questions: out.rows.map(fromRow), editable: !!out.editable,
        autoRejectKnockouts: out.autoRejectKnockouts, max: MAX_QUESTIONS,
      });
    }

    // Candidates, clients and visitors: the public set only.
    const out = await withUser(s, async (c) => {
      const rows = (await c.query(
        `select * from job_screening_questions_public_v where job_id=$1 order by position`, [jobId])).rows;
      let prefill = {};
      if (s && s.role === 'candidate' && rows.length) {
        const qs = rows.map((r0) => ({ ...r0, stdKey: r0.std_key }));
        const defaults = (await c.query(`select * from candidate_screening_defaults where candidate_id=$1`, [s.profileId])).rows[0];
        const cand = (await c.query(`select * from candidates where id=$1`, [s.profileId])).rows[0];
        prefill = prefillFor(qs, { defaults, candidate: cand ? toCandidate(cand) : null });
        return { rows, prefill, hasDefaults: !!defaults };
      }
      return { rows, prefill };
    });
    res.json({
      questions: out.rows.map((r0) => publicQuestion(r0)),
      prefill: out.prefill,
      hasSavedAnswers: !!out.hasDefaults,
    });
  }));

  r.put('/jobs/:id/screening-questions', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const jobId = String(req.params.id).slice(0, 64);
    const body = parse(z.object({
      questions: z.array(z.any()).max(20),
      autoRejectKnockouts: z.boolean().optional(),
    }), req.body);

    const job = (await jobQuestionsInternal(jobId)).job;
    if (!job) throw notFound('That job could not be found.');

    let set;
    try { set = validateQuestionSet(body.questions, { companyName: job.company_name }); }
    catch (err) { throw badRequest(err.message, err.details); }

    const saved = await withUser(req.session, async (c) => {
      const ok = (await c.query(`select screening_job_writer($1) as ok`, [jobId])).rows[0].ok;
      if (!ok) throw forbidden('Only the recruiter who owns this job can change its screening questions.');
      const existing = new Set((await c.query(
        `select id from job_screening_questions where job_id=$1`, [jobId])).rows.map((x) => x.id));
      await c.query(`delete from job_screening_questions where job_id=$1`, [jobId]);
      for (const q of set.questions) {
        const id = q.id && existing.has(q.id) ? q.id : newId();
        await c.query(
          `insert into job_screening_questions
             (id, job_id, position, std_key, text, type, options, is_knockout, knockout_rule,
              weight, source, share_with_client, created_by)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)`,
          [id, jobId, q.position, q.stdKey, q.text, q.type, JSON.stringify(q.options), q.isKnockout,
           q.knockoutRule ? JSON.stringify(q.knockoutRule) : null, q.weight, q.source,
           q.shareWithClient, req.session.userId || null]);
      }
      if (body.autoRejectKnockouts !== undefined) {
        await c.query(
          `insert into job_screening_settings (job_id, auto_reject_knockouts) values ($1,$2)
           on conflict (job_id) do update set auto_reject_knockouts=excluded.auto_reject_knockouts, updated_at=now()`,
          [jobId, body.autoRejectKnockouts]);
      }
      return (await c.query(
        `select * from job_screening_questions where job_id=$1 order by position`, [jobId])).rows;
    }).catch((err) => {
      if (/screening_question_limit/.test(err.message || '')) {
        throw new ApiError(409, 'SCREENING_QUESTION_LIMIT', `A job can have at most ${MAX_QUESTIONS} screening questions.`);
      }
      throw err;
    });

    res.json({ questions: saved.map(fromRow), warnings: set.warnings,
      note: 'Changes apply to new applications. Answers already given keep the question they were given.' });
  }));

  r.post('/screening/suggestions', requireAuth(), requireRole('recruiter', 'admin', 'bde'), wrap(async (req, res) => {
    const b = req.body || {};
    let job = {
      title: String(b.title || '').slice(0, 120), location: String(b.location || '').slice(0, 120),
      skills: Array.isArray(b.skills) ? b.skills.slice(0, 20).map((x) => String(x).slice(0, 60))
        : String(b.skills || '').split(',').slice(0, 20),
      postingKind: String(b.postingKind || '').slice(0, 40), duration: String(b.duration || '').slice(0, 40),
    };
    if (b.jobId) {
      const row = await withUser(req.session, async (c) => (await c.query(
        `select title, location, skills, posting_kind, employment_type, internship_duration from jobs where id=$1`,
        [String(b.jobId).slice(0, 64)])).rows[0]);
      if (row) {
        job = { title: row.title, location: row.location, skills: row.skills || [],
          postingKind: row.posting_kind || row.employment_type || '', duration: row.internship_duration || '' };
      }
    }
    res.json({ suggestions: suggestQuestions(job), source: 'jd-generator' });
  }));

  /* ---------------- admin: the standard questions ---------------- */

  r.get('/screening/settings', requireAuth(), requireRole('recruiter', 'admin', 'bde'), wrap(async (_req, res) => {
    const s = await loadScreeningSettings();
    res.json({ standard: s.standard, answerWeight: s.answerWeight, stdKeys: STD_KEYS, types: TYPES });
  }));

  r.put('/screening/settings', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const body = parse(z.object({
      standard: z.array(z.object({
        key: z.enum(STD_KEYS),
        enabled: z.boolean(),
        text: z.string().trim().min(3).max(200),
        weight: z.number().int().min(0).max(10),
        type: z.enum(TYPES),
        options: z.record(z.any()).optional(),
        shareWithClient: z.boolean().optional(),
      })).max(6).optional(),
      answerWeight: z.number().int().min(0).max(60).optional(),
    }), req.body);

    if (body.standard) {
      for (const q of body.standard) {
        if (/\bclient\b/i.test(q.text)) throw badRequest('Candidates see these questions: do not use the word "client".');
      }
      try { validateQuestionSet(body.standard.map((q) => ({ ...q, stdKey: q.key })), {}); }
      catch (err) { throw badRequest(err.message, err.details); }
    }
    await withUser(req.session, async (c) => {
      if (body.standard) {
        await c.query(
          `insert into app_settings (key, value) values ('screening', $1::jsonb)
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [JSON.stringify({ standard: body.standard })]);
      }
      if (body.answerWeight !== undefined) {
        await c.query(
          `insert into app_settings (key, value) values ('ai', $1::jsonb)
           on conflict (key) do update set value = app_settings.value || excluded.value, updated_at = now()`,
          [JSON.stringify({ weightScreeningAnswers: body.answerWeight })]);
      }
    });
    const s = await loadScreeningSettings();
    res.json({ standard: s.standard, answerWeight: s.answerWeight });
  }));

  /* ---------------- what a recruiter sees ---------------- */

  r.get('/screening/applications', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
    const jobId = req.query.jobId ? String(req.query.jobId).slice(0, 64) : null;
    const out = await withUser(req.session, async (c) => {
      const where = []; const params = [];
      if (ids.length) { params.push(ids); where.push(`a.id = any($${params.length})`); }
      if (jobId) { params.push(jobId); where.push(`a.job_id = $${params.length}`); }
      const apps = (await c.query(
        `select a.* from applications a ${where.length ? 'where ' + where.join(' and ') : ''}
          order by a.applied_at desc limit 1000`, params)).rows;
      const ans = apps.length ? (await c.query(
        `select * from application_screening_answers where application_id = any($1) order by position`,
        [apps.map((a) => a.id)])).rows : [];
      return apps.map((a) => summarise(a, ans.filter((x) => x.application_id === a.id)));
    });
    res.json({ applications: out });
  }));

  r.get('/screening/applications/:id', requireAuth(), wrap(async (req, res) => {
    const s = req.session;
    const id = String(req.params.id).slice(0, 80);

    if (s.role === 'client') {
      const rows = await withUser(s, async (c) => (await c.query(
        `select position, question_text, question_type, std_key, answer, answered_at
           from client_screening_answers_v where application_id=$1 order by position`, [id])).rows);
      return res.json({ answers: rows.map((x) => ({
        question: x.question_text, type: x.question_type, stdKey: x.std_key, answer: x.answer, answeredAt: x.answered_at,
      })) });
    }
    if (s.role === 'candidate') {
      const rows = await withUser(s, async (c) => (await c.query(
        `select position, question_text, question_type, answer, answered_at
           from candidate_screening_answers_v where application_id=$1 order by position`, [id])).rows);
      return res.json({ answers: rows.map((x) => ({
        question: x.question_text, type: x.question_type, answer: x.answer, answeredAt: x.answered_at,
      })) });
    }
    if (!STAFF.includes(s.role)) throw forbidden();

    const out = await withUser(s, async (c) => {
      const app = (await c.query(`select * from applications where id=$1`, [id])).rows[0];
      if (!app) return null;
      const ans = (await c.query(
        `select * from application_screening_answers where application_id=$1 order by position`, [id])).rows;
      const qs = (await c.query(
        `select * from job_screening_questions where job_id=$1 order by position`, [app.job_id])).rows;
      const dl = (await c.query(
        `select kind, channel, status, provider, error, created_at from screening_link_deliveries
          where application_id=$1 order by created_at desc limit 30`, [id])).rows;
      return { app, ans, qs, dl };
    });
    if (!out) throw notFound('That application could not be found.');
    res.json({
      summary: summarise(out.app, out.ans),
      answers: out.ans.map((x) => ({
        questionId: x.question_id, question: x.question_text, type: x.question_type, stdKey: x.std_key,
        answer: x.answer, mustHaveNotMet: !!x.knocked_out, source: x.source, answeredBy: x.answered_by,
        answeredAt: x.answered_at, sharedWithClient: x.std_key === 'other_consultancy' ? !!x.share_with_client : true,
      })),
      questions: out.qs.map(fromRow),
      deliveries: out.dl,
    });
  }));

  /** "Answered on call": a recruiter types what the candidate said. */
  r.post('/screening/applications/:id/answers', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const body = parse(z.object({ answers: answersSchema }), req.body);
    const seen = await withUser(req.session, async (c) => {
      const a = (await c.query(`select id, job_id from applications where id=$1`, [id])).rows[0];
      return a ? { a, name: await staffName(c, req.session) } : null;
    });
    if (!seen) throw notFound('That application could not be found.');
    const set = await jobQuestionsInternal(seen.a.job_id);
    if (!set.questions.length) throw badRequest('This job has no screening questions.');
    let prepared;
    try { prepared = prepareAnswers(set, body.answers); }
    catch (err) { throw badRequest(err.message, err.details); }
    await withUser(ENGINE, (c) => storeAnswers(c, id, prepared, {
      source: 'recruiter_call', by: `Answered on call by ${seen.name}`,
    }));
    const screening = await rescreen(id, req.session.userId || 'recruiter');
    res.json({ ok: true, status: prepared.status, answerScore: prepared.score,
      combinedScore: screening ? screening.combinedScore ?? null : null });
  }));

  r.post('/screening/applications/:id/reopen', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const seen = await withUser(req.session, async (c) => (await c.query(
      `select id from applications where id=$1`, [id])).rows[0]);
    if (!seen) throw notFound('That application could not be found.');
    const out = await sendLink(id);
    if (out.skipped) throw badRequest(`Could not send: ${out.skipped}.`);
    res.json({ ok: true, delivery_status: out.delivery_status });
  }));

  r.post('/screening/send', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(z.object({ applicationIds: z.array(z.string().max(80)).min(1).max(200) }), req.body);
    const visible = await withUser(req.session, async (c) => (await c.query(
      `select id, screening_status from applications where id = any($1)`, [body.applicationIds])).rows);
    const results = [];
    for (const a of visible) {
      if (a.screening_status === 'answered' || a.screening_status === 'knocked_out') {
        results.push({ applicationId: a.id, skipped: 'already answered (use Re-open answers)' });
        continue;
      }
      try {
        const out = await sendLink(a.id);
        results.push({ applicationId: a.id, ...(out.skipped ? { skipped: out.skipped } : { delivery_status: out.delivery_status }) });
      } catch (err) {
        results.push({ applicationId: a.id, error: 'could not send' });
      }
    }
    const notVisible = body.applicationIds.filter((x) => !visible.some((v) => v.id === x));
    notVisible.forEach((x) => results.push({ applicationId: x, skipped: 'not found' }));
    res.json({ sent: results.filter((x) => x.delivery_status).length, results });
  }));

  /* ---------------- the no-password link ---------------- */

  const linkError = (code) => {
    const say = {
      invalid: 'This link is not valid.',
      expired: 'This link has expired. Ask the recruitment team to send a new one.',
      used: 'These questions have already been answered. Thank you!',
      replaced: 'A newer link was sent to you. Please use the latest message.',
    }[code] || 'This link is not valid.';
    return new ApiError(code === 'used' ? 409 : 410, `SCREENING_LINK_${code.toUpperCase()}`, say);
  };

  r.post('/screening/link/view', wrap(async (req, res) => {
    const token = String((req.body || {}).token || '').slice(0, 400);
    const link = await resolveLink(token);
    if (link.error) throw linkError(link.error);
    const a = link.app;
    const out = await withUser(ENGINE, async (c) => {
      const qs = (await c.query(
        `select * from job_screening_questions where job_id=$1 order by position`, [a.job_id])).rows.map(fromRow);
      const defaults = (await c.query(`select * from candidate_screening_defaults where candidate_id=$1`, [a.candidate_id])).rows[0];
      const cand = (await c.query(`select * from candidates where id=$1`, [a.candidate_id])).rows[0];
      return { qs, prefill: prefillFor(qs, { defaults, candidate: cand ? toCandidate(cand) : null }) };
    });
    res.json({
      jobTitle: a.job_title,
      location: a.job_location || null,
      firstName: String(a.candidate_name || '').split(/\s+/)[0] || null,
      expiresAt: a.screening_link_expires_at,
      questions: out.qs.map(publicQuestion),
      prefill: out.prefill,
    });
  }));

  r.post('/screening/link/submit', wrap(async (req, res) => {
    const body = parse(z.object({
      token: z.string().max(400), answers: answersSchema, saveDefaults: z.boolean().optional(),
    }), req.body);
    const link = await resolveLink(body.token);
    if (link.error) throw linkError(link.error);
    const a = link.app;
    const set = await jobQuestionsInternal(a.job_id);
    let prepared;
    try { prepared = prepareAnswers(set, body.answers); }
    catch (err) { throw badRequest(err.message, err.details); }
    await withUser(ENGINE, (c) => storeAnswers(c, a.id, prepared, {
      source: 'link', by: null, saveDefaults: body.saveDefaults === true, candidateId: a.candidate_id,
    }));
    await rescreen(a.id, 'candidate');
    // The same answer whatever the answers were: a failed must-have is the
    // recruiter's to see, never the candidate's.
    res.json({ ok: true, message: 'Thank you - your answers have been sent to the recruitment team.' });
  }));

  return r;
}

export { mentionsCompany };
