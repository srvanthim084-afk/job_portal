/**
 * The AI calling agent's API.
 *
 * Two kinds of endpoint, with very different security:
 *
 *   /api/ai-calling/*            staff endpoints. Authenticated, role
 *                                checked, and everything they read is
 *                                still filtered by RLS.
 *   /api/ai-calling/webhooks/*   the carrier calling US. No session
 *                                exists, so these verify the provider's
 *                                signature instead, and are rate limited.
 *
 * Nothing here decides who may see a transcript: the policies in 0018 do,
 * using the same role rules as the rest of the ATS.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { telephony, telephonyStatus, speechToText } from '../telephony/index.js';
import {
  queueCall, startCall, handleTurn, handleStatus, finishCall, failCall, loadSettings,
} from '../ai/call/runtime.js';
import { plan } from '../ai/call/agent.js';
import { toCandidate, toJob } from '../shapes.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const ENGINE = { userId: '', role: 'admin', profileId: null };

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const issue of out.error.issues) details[issue.path.join('.') || 'body'] = issue.message;
    throw new ApiError(422, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  }
  return out.data;
}

/** One row of call history, as the ATS shows it. */
const toCall = (r) => ({
  id: r.id,
  campaignId: r.campaign_id || undefined,
  candidateId: r.candidate_id,
  candidateName: r.candidate_name || undefined,
  jobId: r.job_id || undefined,
  jobTitle: r.job_title || undefined,
  applicationId: r.application_id || undefined,
  recruiterId: r.recruiter_id || undefined,
  objective: r.objective,
  language: r.language,
  languageConfidence: r.language_confidence == null ? null : Number(r.language_confidence),
  languageSwitched: !!r.language_switched,
  state: r.state,
  status: r.status,
  outcome: r.outcome || undefined,
  interestStatus: r.interest_status || undefined,
  interestReason: r.interest_reason || undefined,
  currentCtc: r.current_ctc == null ? null : Number(r.current_ctc),
  expectedCtc: r.expected_ctc == null ? null : Number(r.expected_ctc),
  noticePeriod: r.notice_period || undefined,
  earliestJoiningDate: r.earliest_joining_date
    ? new Date(r.earliest_joining_date).toISOString().slice(0, 10) : undefined,
  locationAccepted: r.location_accepted,
  workModeAccepted: r.work_mode_accepted,
  interviewInterest: r.interview_interest,
  screening: r.screening || {},
  candidateQuestions: r.candidate_questions || [],
  candidateConcerns: r.candidate_concerns || [],
  callbackRequired: !!r.callback_required,
  callbackAt: r.callback_at ? new Date(r.callback_at).toISOString() : undefined,
  recruiterCallbackRequired: !!r.recruiter_callback_required,
  summary: r.summary || undefined,
  provider: r.provider || undefined,
  recordingUrl: r.recording_url || undefined,
  durationSeconds: r.duration_seconds,
  attempt: r.attempt,
  queuedAt: r.queued_at ? new Date(r.queued_at).toISOString() : undefined,
  answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : undefined,
  endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : undefined,
});

export default function aiCallingRoutes() {
  const r = Router();

  /* ================================================================ *
   * staff endpoints
   * ================================================================ */

  /**
   * GET /api/ai-calling/status
   * Which provider is active and what is missing to make calls real.
   */
  r.get('/ai-calling/status', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const settings = await loadSettings();
      res.json({ telephony: telephonyStatus(), settings });
    }));

  /**
   * POST /api/ai-calling/call — call one candidate now.
   *
   * The plan is built and returned with the call, so a recruiter can see
   * what the agent intends to ask before a word is spoken.
   */
  r.post('/ai-calling/call', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        candidateId: z.string().trim().min(1).max(64),
        jobId: z.string().trim().min(1).max(64).optional(),
        applicationId: z.string().trim().min(1).max(64).optional(),
        objective: z.string().trim().max(200).optional(),
        language: z.enum(['auto', 'en', 'hi', 'te']).optional(),
        campaignId: z.string().trim().max(64).optional(),
      }), req.body);

      // Read through the CALLER's session, so a recruiter cannot start a
      // call to a candidate they are not allowed to see.
      const seen = await withUser(req.session, async (c) => {
        const cand = (await c.query(`select * from candidates where id=$1`, [b.candidateId])).rows[0];
        if (!cand) return null;
        const job = b.jobId
          ? (await c.query(`select * from jobs where id=$1`, [b.jobId])).rows[0] : null;
        return { cand, job };
      });
      if (!seen) throw notFound('That candidate could not be found.');
      if (b.jobId && !seen.job) throw notFound('That requirement could not be found.');
      if (seen.cand.do_not_contact) {
        throw new ApiError(409, 'DO_NOT_CONTACT',
          'This candidate has asked not to be contacted.');
      }
      if (!seen.cand.phone) {
        throw badRequest('This candidate has no phone number on their profile.');
      }

      const recruiterId = req.session.role === 'recruiter' ? req.session.profileId : null;

      let sessionId;
      try {
        sessionId = await queueCall(req.session, {
          candidateId: b.candidateId,
          jobId: b.jobId,
          applicationId: b.applicationId,
          recruiterId,
          campaignId: b.campaignId,
          objective: b.objective,
          language: b.language && b.language !== 'auto' ? b.language : null,
        });
      } catch (err) {
        // The database enforces the three rules that must never be
        // bypassed; surface them as the conflicts they are.
        if (/already in progress/.test(err.message)) {
          throw new ApiError(409, 'CALL_IN_PROGRESS',
            'A call to this candidate for this requirement is already running.');
        }
        if (/not to be contacted/.test(err.message)) {
          throw new ApiError(409, 'DO_NOT_CONTACT', 'This candidate has asked not to be contacted.');
        }
        if (/no phone/.test(err.message)) {
          throw badRequest('This candidate has no phone number on their profile.');
        }
        throw err;
      }

      const started = await startCall(sessionId);
      res.status(201).json({
        call: { id: sessionId, provider: started.provider, providerCallId: started.providerCallId },
        say: started.say,
        plan: started.plan,
        telephony: telephonyStatus(),
      });
    }));

  /**
   * POST /api/ai-calling/calls/:id/say
   *
   * One candidate turn, for the local driver and for testing a
   * conversation without a carrier. The same engine the webhooks use.
   */
  r.post('/ai-calling/calls/:id/say', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        text: z.string().max(4000).optional().default(''),
        confidence: z.number().min(0).max(1).optional(),
      }), req.body);

      const allowed = await withUser(req.session, async (c) =>
        (await c.query(`select id from ai_call_sessions where id=$1`, [req.params.id])).rowCount);
      if (!allowed) throw notFound('That call could not be found.');

      const out = await handleTurn(req.params.id, b.text, { confidence: b.confidence });
      res.json(out);
    }));

  /** POST /api/ai-calling/calls/:id/end — hang up and process the result. */
  r.post('/ai-calling/calls/:id/end', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const row = await withUser(req.session, async (c) =>
        (await c.query(`select * from ai_call_sessions where id=$1`, [req.params.id])).rows[0]);
      if (!row) throw notFound('That call could not be found.');

      if (row.provider_call_id && telephony().hangup) {
        await telephony().hangup({ callId: row.provider_call_id }).catch(() => {});
      }
      const out = await finishCall(req.params.id, null, { status: 'completed' });
      res.json({ ok: true, ...(out || {}) });
    }));

  /**
   * GET /api/ai-calling/calls  ?candidateId= &jobId= &campaignId= &status=
   * The call history, and the dashboard's rows.
   */
  r.get('/ai-calling/calls', requireAuth(), wrap(async (req, res) => {
    const { candidateId, jobId, campaignId, status, outcome, language, limit } = req.query;

    const rows = await withUser(req.session, async (c) => {
      const where = [], vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
      if (candidateId) add('s.candidate_id=$?', candidateId);
      if (jobId)       add('s.job_id=$?', jobId);
      if (campaignId)  add('s.campaign_id=$?', campaignId);
      if (status)      add('s.status=$?', status);
      if (outcome)     add('s.outcome=$?', outcome);
      if (language)    add('s.language=$?', language);
      const clause = where.length ? `where ${where.join(' and ')}` : '';

      return (await c.query(
        `select s.*, c.name as candidate_name, j.title as job_title
           from ai_call_sessions s
           join candidates c on c.id = s.candidate_id
           left join jobs j on j.id = s.job_id
           ${clause}
          order by s.queued_at desc
          limit ${Math.min(Number(limit) || 200, 500)}`, vals)).rows;
    });

    res.json({ calls: rows.map(toCall) });
  }));

  /** GET /api/ai-calling/calls/:id — one call, with its transcript. */
  r.get('/ai-calling/calls/:id', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const row = (await c.query(
        `select s.*, c.name as candidate_name, j.title as job_title
           from ai_call_sessions s
           join candidates c on c.id = s.candidate_id
           left join jobs j on j.id = s.job_id
          where s.id=$1`, [req.params.id])).rows[0];
      if (!row) return null;
      const turns = (await c.query(
        `select seq, speaker, text, language, intent, state, at
           from ai_call_turns where session_id=$1 order by seq`, [req.params.id])).rows;
      return { row, turns };
    });
    if (!out) throw notFound('That call could not be found.');

    res.json({
      call: toCall(out.row),
      transcript: out.turns.map((t) => ({
        seq: t.seq, speaker: t.speaker, text: t.text, language: t.language,
        intent: t.intent || undefined, state: t.state || undefined,
        at: t.at ? new Date(t.at).toISOString() : undefined,
      })),
    });
  }));

  /**
   * GET /api/ai-calling/plan?candidateId=&jobId=
   *
   * What the agent WOULD ask, without calling anybody. This is the answer
   * to "will it ask my candidate something we already know".
   */
  r.get('/ai-calling/plan', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const { candidateId, jobId } = req.query;
      if (!candidateId) throw badRequest('A candidate is required.');

      const ctx = await withUser(req.session, async (c) => {
        const cand = (await c.query(`select * from candidates where id=$1`, [candidateId])).rows[0];
        if (!cand) return null;
        const job = jobId ? (await c.query(`select * from jobs where id=$1`, [jobId])).rows[0] : null;
        const app = jobId ? (await c.query(
          `select * from applications where candidate_id=$1 and job_id=$2 limit 1`,
          [candidateId, jobId])).rows[0] : null;
        return { cand, job, app };
      });
      if (!ctx) throw notFound('That candidate could not be found.');

      res.json({
        plan: plan({
          candidate: toCandidate(ctx.cand),
          job: ctx.job ? toJob(ctx.job) : null,
          application: ctx.app ? { stage: ctx.app.stage } : null,
        }),
      });
    }));

  /* ---- campaigns --------------------------------------------------- */

  /**
   * POST /api/ai-calling/campaign — call a list for one requirement.
   *
   * Validates every number, drops opt-outs and duplicates, then queues
   * within the configured concurrency. Nothing is dialled synchronously:
   * the recruiter gets an answer immediately and the calls proceed.
   */
  r.post('/ai-calling/campaign', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        name: z.string().trim().min(1).max(160).optional(),
        jobId: z.string().trim().min(1).max(64),
        candidateIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
        objective: z.string().trim().max(200).optional(),
        languageMode: z.enum(['auto', 'en', 'hi', 'te']).optional().default('auto'),
        maxCalls: z.number().int().min(1).max(500).optional(),
        scheduledAt: z.string().datetime().optional(),
      }), req.body);

      const job = await withUser(req.session, async (c) =>
        (await c.query(`select * from jobs where id=$1`, [b.jobId])).rows[0]);
      if (!job) throw notFound('That requirement could not be found.');

      const recruiterId = req.session.role === 'recruiter' ? req.session.profileId : null;
      const campaignId = newId('camp');

      await withUser(req.session, (c) => c.query(
        `select ai_call_campaign_create($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [campaignId, b.name || `${job.title} — AI calling`, b.jobId, recruiterId,
         req.session.userId || null, b.objective || 'screen', b.languageMode,
         b.maxCalls || b.candidateIds.length, JSON.stringify({}), b.scheduledAt || null]));

      // Validate the list before dialling any of it.
      const checked = await withUser(req.session, async (c) => {
        const { rows } = await c.query(
          `select c.id, c.name, c.phone, c.do_not_contact,
                  a.id as application_id,
                  exists (select 1 from ai_call_sessions s
                           where s.candidate_id = c.id and s.job_id = $2
                             and s.status in ('queued','dialing','ringing','in_progress')) as busy
             from candidates c
             left join applications a on a.candidate_id = c.id and a.job_id = $2
            where c.id = any($1)`, [b.candidateIds, b.jobId]);
        return rows;
      });

      const queued = [], skipped = [];
      for (const c of checked) {
        if (queued.length >= (b.maxCalls || b.candidateIds.length)) {
          skipped.push({ candidateId: c.id, reason: 'over the campaign limit' }); continue;
        }
        if (c.do_not_contact) { skipped.push({ candidateId: c.id, reason: 'do not contact' }); continue; }
        if (!c.phone) { skipped.push({ candidateId: c.id, reason: 'no phone number' }); continue; }
        if (c.busy) { skipped.push({ candidateId: c.id, reason: 'a call is already running' }); continue; }

        try {
          const id = await queueCall(req.session, {
            candidateId: c.id, jobId: b.jobId, applicationId: c.application_id,
            recruiterId, campaignId, objective: b.objective,
            language: b.languageMode !== 'auto' ? b.languageMode : null,
          });
          queued.push({ candidateId: c.id, callId: id });
        } catch (err) {
          skipped.push({ candidateId: c.id, reason: err.message });
        }
      }

      const missing = b.candidateIds.filter((id) => !checked.some((c) => c.id === id));
      for (const id of missing) skipped.push({ candidateId: id, reason: 'not visible to you' });

      // Start them, respecting the configured concurrency. Not awaited:
      // the recruiter is not held while a hundred calls are placed.
      if (!b.scheduledAt) runQueue(campaignId).catch((err) =>
        console.error('[ai-call] campaign queue failed:', err.message));

      res.status(201).json({
        campaign: { id: campaignId, jobId: b.jobId, queued: queued.length, skipped: skipped.length },
        queued, skipped, telephony: telephonyStatus(),
      });
    }));

  /** GET /api/ai-calling/campaigns / :id — the dashboard's campaign view. */
  r.get('/ai-calling/campaigns', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select ca.*, j.title as job_title,
              (select count(*) from ai_call_sessions s where s.campaign_id = ca.id) as total,
              (select count(*) from ai_call_sessions s where s.campaign_id = ca.id
                 and s.status = 'completed') as completed,
              (select count(*) from ai_call_sessions s where s.campaign_id = ca.id
                 and s.interest_status = 'interested') as interested
         from ai_call_campaigns ca
         left join jobs j on j.id = ca.job_id
        order by ca.created_at desc limit 100`)).rows);

    res.json({
      campaigns: rows.map((c) => ({
        id: c.id, name: c.name, jobId: c.job_id, jobTitle: c.job_title || undefined,
        status: c.status, languageMode: c.language_mode, objective: c.objective,
        maxCalls: c.max_calls,
        total: Number(c.total), completed: Number(c.completed), interested: Number(c.interested),
        createdAt: c.created_at ? new Date(c.created_at).toISOString() : undefined,
      })),
    });
  }));

  /** GET /api/ai-calling/dashboard — the counts the recruiter screen shows. */
  r.get('/ai-calling/dashboard', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const { jobId, from, to } = req.query;
      const out = await withUser(req.session, async (c) => {
        const vals = [];
        const where = [];
        if (jobId) { vals.push(jobId); where.push(`job_id=$${vals.length}`); }
        if (from)  { vals.push(from);  where.push(`queued_at >= $${vals.length}`); }
        if (to)    { vals.push(to);    where.push(`queued_at <= $${vals.length}`); }
        const clause = where.length ? `where ${where.join(' and ')}` : '';

        const totals = (await c.query(
          `select count(*)::int as total,
                  count(*) filter (where status='completed')::int as connected,
                  count(*) filter (where status in ('no_answer','busy'))::int as no_answer,
                  count(*) filter (where interest_status='interested')::int as interested,
                  count(*) filter (where interest_status='not_interested')::int as not_interested,
                  count(*) filter (where callback_required)::int as callbacks,
                  count(*) filter (where recruiter_callback_required)::int as recruiter_callbacks,
                  count(*) filter (where outcome='do_not_contact')::int as do_not_contact,
                  count(*) filter (where outcome in ('interested','call_completed'))::int as screened
             from ai_call_sessions ${clause}`, vals)).rows[0];

        const byLanguage = (await c.query(
          `select language, count(*)::int as n from ai_call_sessions ${clause}
            group by language order by n desc`, vals)).rows;

        const pending = (await c.query(
          `select cb.*, c.name as candidate_name, j.title as job_title
             from ai_call_callbacks cb
             join candidates c on c.id = cb.candidate_id
             left join jobs j on j.id = cb.job_id
            where cb.status='pending'
            order by cb.requested_for nulls last limit 50`)).rows;

        return { totals, byLanguage, pending };
      });

      res.json({
        totals: out.totals,
        byLanguage: out.byLanguage,
        callbacks: out.pending.map((p) => ({
          id: p.id, kind: p.kind, candidateId: p.candidate_id,
          candidateName: p.candidate_name, jobId: p.job_id || undefined,
          jobTitle: p.job_title || undefined,
          requestedFor: p.requested_for ? new Date(p.requested_for).toISOString() : undefined,
          language: p.language || undefined, reason: p.reason || undefined,
          question: p.question || undefined,
        })),
        telephony: telephonyStatus(),
      });
    }));

  /** PATCH /api/ai-calling/settings — admin only, enforced in the database. */
  /*
   * Recruiters may set the operational fields; the database decides the
   * rest. A non-admin patch that touches disclosure or recording leaves
   * those exactly as they were rather than failing, so saving the
   * provider and the caller ID still works from the recruiter screen.
   */
  r.patch('/ai-calling/settings', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(
      `select ai_call_settings_update($1::jsonb,$2)`,
      [JSON.stringify(req.body || {}), req.session.userId || 'admin']));
    res.json({ settings: await loadSettings() });
  }));

  /** POST /api/ai-calling/callbacks/:id/done */
  r.post('/ai-calling/callbacks/:id/done', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      await withUser(ENGINE, (c) => c.query(
        `update ai_call_callbacks set status='done', completed_at=now() where id=$1`,
        [req.params.id]));
      res.json({ ok: true });
    }));

  /* ================================================================ *
   * webhooks — the carrier calling us
   * ================================================================ */

  const webhookGuard = (req, res, next) => {
    const provider = telephony();
    // The local driver has no signature and is not reachable from
    // outside; every real provider must verify.
    if (provider.name === 'local') return next();
    if (typeof provider.verifyWebhook !== 'function' || !provider.verifyWebhook(req)) {
      console.error('[ai-call] a webhook failed verification and was refused');
      return res.status(403).json({ error: { code: 'BAD_SIGNATURE', message: 'Refused.' } });
    }
    return next();
  };

  /**
   * POST /api/ai-calling/webhooks/voice
   *
   * The carrier posts what the candidate said; we answer with what to say
   * next, in whatever form that provider speaks.
   */
  r.post('/ai-calling/webhooks/voice', webhookGuard, wrap(async (req, res) => {
    const sessionId = String(req.query.session || req.body.session || '');
    if (!sessionId) return res.status(400).json({ error: { code: 'NO_SESSION' } });

    const heard = speechToText.fromWebhook(req.body);
    const silence = req.query.silence === '1' || (!heard.text && !req.body.SpeechResult);

    await withUser(ENGINE, (c) => c.query(
      `select ai_call_event($1,'webhook:voice',$2,$3::jsonb,null)`,
      [sessionId, telephony().name, JSON.stringify({ heard: heard.text, silence })]))
      .catch(() => {});

    let turn;
    try {
      turn = await handleTurn(sessionId, silence ? '' : heard.text, { confidence: heard.confidence });
    } catch (err) {
      console.error('[ai-call] turn failed:', err.message);
      await failCall(sessionId, 'technical_failure', err.message);
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }

    const provider = telephony();
    if (provider.name === 'twilio') {
      const settings = await loadSettings();
      const doc = await provider.speak({
        text: turn.say, language: turn.language, expectReply: !turn.end,
        webhookUrl: `${(config.telephony.publicWebhookBase || config.publicOrigin).replace(/\/$/, '')}/api/ai-calling/webhooks/voice`,
        sessionId,
        silenceSeconds: settings.silencePromptSeconds,
      });
      return res.type('text/xml').send(doc.twiml);
    }
    return res.json({ say: turn.say, end: turn.end, language: turn.language });
  }));

  /** POST /api/ai-calling/webhooks/voice/status — telephony lifecycle. */
  r.post('/ai-calling/webhooks/voice/status', webhookGuard, wrap(async (req, res) => {
    const sessionId = String(req.query.session || req.body.session || '');
    const status = req.body.CallStatus || req.body.Status || req.body.status || 'completed';
    const callId = req.body.CallSid || req.body.CallSid || req.body.callId || null;
    if (sessionId) await handleStatus(sessionId, status, callId, req.body);
    res.json({ ok: true });
  }));

  /** POST /api/ai-calling/webhooks/recording — a recording became available. */
  r.post('/ai-calling/webhooks/recording', webhookGuard, wrap(async (req, res) => {
    const sessionId = String(req.query.session || req.body.session || '');
    const url = req.body.RecordingUrl || req.body.recording_url || '';
    if (sessionId && url) {
      await withUser(ENGINE, (c) => c.query(
        `update ai_call_sessions set recording_url=$2, updated_at=now() where id=$1`,
        [sessionId, url]));
      await withUser(ENGINE, (c) => c.query(
        `select ai_call_event($1,'recording',$2,$3::jsonb,null)`,
        [sessionId, telephony().name, JSON.stringify({ url })]));
    }
    res.json({ ok: true });
  }));

  return r;
}

/* ------------------------------------------------------------------ *
 * the queue
 * ------------------------------------------------------------------ */

/**
 * Start the queued calls for a campaign, a few at a time.
 *
 * Concurrency is the point: a hundred simultaneous calls will be
 * throttled by the carrier, and the failures come back as generic errors
 * that look like bugs. Small batches, in order.
 */
export async function runQueue(campaignId) {
  const limit = Math.max(1, config.telephony.concurrency || 3);

  for (;;) {
    const batch = await withUser(ENGINE, async (c) => (await c.query(
      `select id from ai_call_sessions
        where campaign_id=$1 and status='queued'
        order by queued_at limit $2`, [campaignId, limit])).rows);
    if (!batch.length) break;

    await Promise.all(batch.map(async (row) => {
      try {
        await startCall(row.id);
      } catch (err) {
        console.error(`[ai-call] ${row.id} could not be started:`, err.message);
        await failCall(row.id, 'technical_failure', err.message);
      }
    }));

    // With the local driver every call finishes when the conversation
    // does, so there is nothing to wait for; with a carrier the next
    // batch waits for the previous one to leave the live set.
    if (telephony().name !== 'local') {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
