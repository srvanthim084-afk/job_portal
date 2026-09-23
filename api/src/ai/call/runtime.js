/**
 * The part that actually runs a call.
 *
 * agent.js decides what to say; this decides what happens: it loads the
 * candidate, the job and the application that already exist, plans the
 * call from them, places it through whichever carrier is configured,
 * records every turn, and when the call ends writes the result back into
 * the ATS and tells the recruiter.
 *
 * Conversation state lives in memory for the duration of the call and is
 * rebuilt from the transcript if the process restarts mid-call, because a
 * dropped call must not lose what the candidate already said.
 */
import { withUser } from '../../db.js';
import { config } from '../../config.js';
import { toCandidate, toJob } from '../../shapes.js';
import { telephony, speechToText } from '../../telephony/index.js';
import { dispatchEvent } from '../../notify/events.js';
import {
  plan, startConversation, openingTurn, nextTurn, callResult, summarise, atsAction, parseWhen,
} from './agent.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The identity the calling machinery runs as. Never from a cookie. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/** Live conversations, keyed by session id. */
const live = new Map();

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export async function loadSettings() {
  const row = await withUser(ENGINE, async (c) =>
    (await c.query(`select * from ai_call_settings where id='default'`)).rows[0]);
  if (!row) return { agentName: 'Anu', companyName: 'TeamLink', defaultLanguage: 'en' };
  return {
    // How a call is PLACED. The credentials that authorise it stay in
    // the server environment and are never part of this.
    provider: row.provider || 'not_selected',
    apiUrl: row.api_url || '',
    callerId: row.caller_id || '',
    autoInterviewCalls: !!row.auto_interview_calls,
    autoReminderCalls: !!row.auto_reminder_calls,

    agentName: row.agent_name,
    companyName: row.company_name,
    defaultLanguage: row.default_language,
    supportedLanguages: row.supported_languages || ['en', 'hi', 'te'],
    discloseAi: row.disclose_ai,
    aiDisclosure: row.ai_disclosure,
    recordingEnabled: row.recording_enabled,
    recordingDisclosure: row.recording_disclosure,
    maxDurationSeconds: row.max_duration_seconds,
    silencePromptSeconds: row.silence_prompt_seconds,
    maxSilencePrompts: row.max_silence_prompts,
    retryNoAnswer: row.retry_no_answer,
    retryIntervalMinutes: row.retry_interval_minutes,
    callWindowStart: row.call_window_start,
    callWindowEnd: row.call_window_end,
    discloseSalary: row.disclose_salary,
    discloseClient: row.disclose_client,
    voice: row.voice,
    voiceSpeed: Number(row.voice_speed),
    conversationStyle: row.conversation_style,
  };
}

/** Everything one call needs, read from the tables that already hold it. */
async function loadContext(sessionId) {
  return withUser(ENGINE, async (c) => {
    const s = (await c.query(`select * from ai_call_sessions where id=$1`, [sessionId])).rows[0];
    if (!s) return null;

    const cand = (await c.query(`select * from candidates where id=$1`, [s.candidate_id])).rows[0];
    const job = s.job_id
      ? (await c.query(
          `select j.*, co.name as company_name from jobs j
             left join companies co on co.id = j.company_id where j.id=$1`, [s.job_id])).rows[0]
      : null;
    const app = s.application_id
      ? (await c.query(`select * from applications where id=$1`, [s.application_id])).rows[0]
      : (s.job_id
          ? (await c.query(
              `select * from applications where candidate_id=$1 and job_id=$2 limit 1`,
              [s.candidate_id, s.job_id])).rows[0]
          : null);

    const turns = (await c.query(
      `select * from ai_call_turns where session_id=$1 order by seq`, [sessionId])).rows;

    return { session: s, candidate: cand, job, application: app, turns };
  });
}

/* ------------------------------------------------------------------ *
 * queueing and placing
 * ------------------------------------------------------------------ */

/**
 * Queue a call. The database refuses the three cases that must never be
 * dialled (do-not-contact, no number, already in progress), so the check
 * cannot be forgotten by a caller.
 */
export async function queueCall(session, {
  candidateId, jobId, applicationId, recruiterId, campaignId, objective, language, toNumber,
}) {
  const id = newId('call');
  await withUser(session, (c) => c.query(
    `select ai_call_queue($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, candidateId, jobId || null, applicationId || null, recruiterId || null,
     campaignId || null, objective || 'screen', language || null, toNumber || null]));
  return id;
}

/**
 * Dial, and speak the opening line.
 *
 * Nothing is asked here. The first turn establishes who is on the line
 * and whether now is a reasonable time, which is what a person does.
 */
export async function startCall(sessionId) {
  const ctx = await loadContext(sessionId);
  if (!ctx) throw new Error('no such call session');

  const settings = await loadSettings();
  const candidate = toCandidate(ctx.candidate);
  const job = ctx.job ? { ...toJob(ctx.job), companyName: ctx.job.company_name } : null;
  const application = ctx.application ? { stage: ctx.application.stage, id: ctx.application.id } : null;

  const p = plan({ candidate, job, application, opts: { objective: ctx.session.objective } });
  const conv = startConversation({
    candidate, job, application, settings, plan: p,
    language: ctx.session.language !== 'en' ? ctx.session.language : candidate.preferredLanguage,
  });
  conv.job = job;
  conv.candidate = candidate;
  conv.sessionId = sessionId;
  conv.startedAt = Date.now();
  live.set(sessionId, conv);

  const provider = telephony();
  const webhookUrl = `${(config.telephony.publicWebhookBase || config.publicOrigin).replace(/\/$/, '')}`
    + '/api/ai-calling/webhooks/voice';

  await withUser(ENGINE, (c) => c.query(
    `select ai_call_event($1,'plan',null,$2::jsonb,null)`,
    [sessionId, JSON.stringify({ objective: p.objective, known: p.known, needed: p.needed })]));

  let placed;
  try {
    placed = await provider.placeCall({
      to: ctx.session.to_number,
      sessionId,
      webhookUrl,
      record: settings.recordingEnabled,
    });
  } catch (err) {
    await withUser(ENGINE, (c) => c.query(
      `select ai_call_event($1,'error.place',$2,null,$3)`, [sessionId, provider.name, err.message]));
    await failCall(sessionId, 'technical_failure', err.message);
    throw err;
  }

  await withUser(ENGINE, (c) => c.query(
    `select ai_call_status($1,'dialing',$2,$3)`, [sessionId, provider.name, placed.callId]));

  // Disclosures are recorded as consent events, never assumed.
  if (settings.discloseAi) await consent(sessionId, ctx.session.candidate_id, 'ai_disclosed');
  if (settings.recordingEnabled) {
    await consent(sessionId, ctx.session.candidate_id, 'recording_disclosed');
  }

  const first = openingTurn(conv, settings);
  await recordTurn(sessionId, 'agent', first.say, conv);
  conv.lastLine = first.say;

  if (provider.name === 'local') {
    await withUser(ENGINE, (c) => c.query(
      `select ai_call_status($1,'in_progress',$2,$3)`, [sessionId, provider.name, placed.callId]));
  }

  return { sessionId, providerCallId: placed.callId, provider: provider.name, say: first.say, plan: p };
}

/* ------------------------------------------------------------------ *
 * a turn
 * ------------------------------------------------------------------ */

/**
 * The candidate said something; work out the reply.
 *
 * This is the function both the local driver and every carrier webhook
 * funnel into, so there is exactly one implementation of the
 * conversation regardless of who is carrying the audio.
 */
export async function handleTurn(sessionId, transcript, meta = {}) {
  let conv = live.get(sessionId);
  const settings = await loadSettings();

  if (!conv) {
    // The process restarted mid-call. Rebuild rather than start over:
    // asking everything again is worse than dropping the call.
    conv = await rebuild(sessionId, settings);
    if (!conv) throw new Error('no such call session');
  }

  await recordTurn(sessionId, 'candidate', transcript || '(silence)', conv, {
    confidence: meta.confidence,
  });

  const turn = nextTurn(conv, transcript, settings);
  conv.lastLine = turn.say;
  await recordTurn(sessionId, 'agent', turn.say, conv);

  if (turn.action) await applyAction(sessionId, conv, turn.action);

  if (turn.end) {
    await finishCall(sessionId, conv, { status: 'completed' });
  }

  return {
    say: turn.say,
    end: !!turn.end,
    state: conv.state,
    language: conv.language,
    outcome: turn.outcome || null,
  };
}

/** Rebuild a conversation from its transcript after a restart. */
async function rebuild(sessionId, settings) {
  const ctx = await loadContext(sessionId);
  if (!ctx) return null;

  const candidate = toCandidate(ctx.candidate);
  const job = ctx.job ? { ...toJob(ctx.job), companyName: ctx.job.company_name } : null;
  const application = ctx.application ? { stage: ctx.application.stage } : null;
  const p = plan({ candidate, job, application, opts: { objective: ctx.session.objective } });

  const conv = startConversation({
    candidate, job, application, settings, plan: p, language: ctx.session.language,
  });
  conv.job = job;
  conv.candidate = candidate;
  conv.sessionId = sessionId;
  conv.state = ctx.session.state || 'identity_confirmation';
  conv.startedAt = new Date(ctx.session.answered_at || ctx.session.queued_at).getTime();

  // Replay the candidate's turns so the answers already given are not
  // asked for a second time.
  for (const t of ctx.turns.filter((x) => x.speaker === 'candidate')) {
    try { nextTurn(conv, t.text === '(silence)' ? '' : t.text, settings); } catch { /* ignore */ }
  }
  conv.state = ctx.session.state || conv.state;
  conv.ended = false;
  live.set(sessionId, conv);
  return conv;
}

async function recordTurn(sessionId, speaker, text, conv, extra = {}) {
  if (!text) return;
  await withUser(ENGINE, (c) => c.query(
    `select ai_call_turn($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId, speaker, String(text).slice(0, 4000), conv.language,
     speaker === 'candidate' ? conv.lastIntent || null : null,
     extra.confidence ?? null, conv.state]));
}

async function consent(sessionId, candidateId, kind, detail) {
  await withUser(ENGINE, (c) => c.query(
    `select ai_call_consent($1,$2,$3,$4)`, [candidateId, sessionId, kind, detail || null]))
    .catch(() => {});
}

/* ------------------------------------------------------------------ *
 * the things a turn can trigger
 * ------------------------------------------------------------------ */

async function applyAction(sessionId, conv, action) {
  const ctx = await loadContext(sessionId);
  if (!ctx) return;
  const s = ctx.session;

  if (Array.isArray(action.consent)) {
    for (const k of action.consent) await consent(sessionId, s.candidate_id, k);
  }

  if (action.doNotContact) {
    await consent(sessionId, s.candidate_id, 'do_not_contact', action.reason);
  }

  if (action.callback) {
    const when = action.at ? new Date(action.at) : parseWhen(action.raw || '');
    await withUser(ENGINE, (c) => c.query(
      `select ai_call_callback_create($1,$2,$3,$4,$5,'candidate',$6,$7,$8,null)`,
      [newId('cb'), sessionId, s.candidate_id, s.job_id, s.recruiter_id,
       when ? when.toISOString() : null, conv.language, action.reason || 'candidate asked for a callback']));
  }

  if (action.recruiterCallback) {
    await withUser(ENGINE, (c) => c.query(
      `select ai_call_callback_create($1,$2,$3,$4,$5,'recruiter',null,$6,$7,$8)`,
      [newId('cb'), sessionId, s.candidate_id, s.job_id, s.recruiter_id,
       conv.language, action.reason || 'candidate asked to speak to a recruiter',
       action.question || null]));
  }

  if (action.flagNumber) {
    await withUser(ENGINE, (c) => c.query(
      `select ai_call_event($1,'number.wrong',null,null,null)`, [sessionId]));
  }
}

/* ------------------------------------------------------------------ *
 * the end of the call, and everything that follows from it
 * ------------------------------------------------------------------ */

export async function finishCall(sessionId, conv, { status = 'completed' } = {}) {
  const c = conv || live.get(sessionId);
  const ctx = await loadContext(sessionId);
  if (!ctx) return null;
  if (ctx.session.ended_at) return null;               // already finished

  const settings = await loadSettings();
  const candidate = toCandidate(ctx.candidate);
  const job = ctx.job ? { ...toJob(ctx.job), companyName: ctx.job.company_name } : null;

  const duration = c?.startedAt
    ? Math.max(1, Math.round((Date.now() - c.startedAt) / 1000))
    : null;

  const result = c ? callResult(c, { durationSeconds: duration })
                   : { interestStatus: 'unknown', screening: {} };
  const summary = c ? summarise(c, { candidate, job }) : 'The call did not complete.';
  const transcript = ctx.turns
    .map((t) => `${t.speaker === 'agent' ? settings.agentName : candidate.name}: ${t.text}`)
    .join('\n');

  await withUser(ENGINE, (cl) => cl.query(
    `select ai_call_finish($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [sessionId, status, c?.outcome || 'call_completed',
     result.interestStatus, result.interestReason,
     JSON.stringify(result), summary, transcript, duration]));

  const ats = c ? atsAction(c) : { note: 'AI call ended', stage: null };
  await updateAts(ctx, ats, summary, result);
  const notify = await notifyRecruiter(ctx, ats, summary, result);

  live.delete(sessionId);
  return { summary, result, ats, notify };
}

/** A call that never got as far as a conversation. */
export async function failCall(sessionId, outcome, detail) {
  await withUser(ENGINE, (c) => c.query(
    `select ai_call_finish($1,$2,$3,null,null,'{}'::jsonb,$4,null,null)`,
    [sessionId, outcome === 'no_answer' ? 'no_answer' : 'failed', outcome,
     detail ? `The call could not be completed: ${detail}` : 'The call could not be completed.']))
    .catch(() => {});
  live.delete(sessionId);
}

/**
 * Write the result into the ATS the recruiter already uses.
 *
 * Deliberately conservative: the note and the screening data always land,
 * but the application's STAGE only moves for outcomes where the rule is
 * unambiguous. An AI call does not decide that somebody is selected.
 */
async function updateAts(ctx, ats, summary, result) {
  const s = ctx.session;
  if (!s.candidate_id) return;

  await withUser(ENGINE, async (c) => {
    // Facts the candidate confirmed on the phone belong on their profile.
    const sets = [];
    const vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

    if (result.expectedCtc) set('expected_ctc', result.expectedCtc);
    if (result.noticePeriod) set('notice_period', result.noticePeriod);
    if (result.language) set('preferred_language', result.language);
    if (sets.length) {
      vals.push(s.candidate_id);
      await c.query(`update candidates set ${sets.join(',')}, updated_at=now()
                      where id=$${vals.length}`, vals);
    }

    if (!ctx.application) return;

    // The note goes on every call. The stage moves only when the rule
    // says so, and only forward from a screening stage - a call must not
    // drag somebody back out of an interview they have already had.
    await c.query(`select set_config('app.stage_note', $1, true)`,
      [`${ats.note}: ${String(summary).slice(0, 400)}`]);

    if (ats.stage && ['applied', 'ai_screening', 'shortlisted'].includes(ctx.application.stage)) {
      await c.query(`update applications set stage=$1 where id=$2`,
        [ats.stage, ctx.application.id]);
    }

    await c.query(
      `select notify_create($1,$2,'candidate','AI_CALL',$3,$4,$5,$6,$7,null,'{}')`,
      [newId('ntf'), s.candidate_id, 'AI call completed',
       String(summary).slice(0, 400), s.job_id, ctx.application.id, s.candidate_id])
      .catch(() => {});
  }).catch((err) => {
    console.error('[ai-call] the ATS could not be updated:', err.message);
  });
}

/**
 * Tell the recruiter what happened — but only when it needs them.
 *
 * A notification for every call would be noise within a week. These are
 * the five outcomes a human actually has to act on.
 */
async function notifyRecruiter(ctx, ats, summary, result) {
  const worth = result.interestStatus === 'interested'
    || result.recruiterCallbackRequired
    || result.callbackRequired
    || result.doNotContact
    || (result.candidateConcerns || []).length > 0;
  if (!worth || !ctx.application) return { skipped: 'nothing to act on' };

  return dispatchEvent(ENGINE, 'AI_CALL_COMPLETED', {
    applicationId: ctx.application.id,
    summary,
    interest: result.interestStatus,
    recruiterAction: result.recruiterCallbackRequired ? 'recruiter callback requested'
      : result.callbackRequired ? 'callback scheduled'
      : result.doNotContact ? 'do not contact'
      : null,
  }).catch((err) => ({ error: err.message }));
}

/* ------------------------------------------------------------------ *
 * webhooks
 * ------------------------------------------------------------------ */

/** A carrier telling us the call's telephony state changed. */
export async function handleStatus(sessionId, status, providerCallId, payload) {
  const map = {
    initiated: 'dialing', queued: 'dialing', ringing: 'ringing', 'in-progress': 'in_progress',
    answered: 'in_progress', completed: 'completed', busy: 'busy', 'no-answer': 'no_answer',
    failed: 'failed', canceled: 'cancelled',
  };
  const mapped = map[String(status).toLowerCase()] || 'failed';
  const provider = telephony().name;

  await withUser(ENGINE, (c) => c.query(
    `select ai_call_status($1,$2,$3,$4)`, [sessionId, mapped, provider, providerCallId || null]));
  await withUser(ENGINE, (c) => c.query(
    `select ai_call_event($1,$2,$3,$4::jsonb,null)`,
    [sessionId, `provider:${status}`, provider, JSON.stringify(payload || {})]));

  // A call that rang out is not a conversation: close it and let the
  // retry policy decide whether to try again.
  if (['no_answer', 'busy', 'failed', 'cancelled'].includes(mapped)) {
    await failCall(sessionId, mapped === 'busy' ? 'busy' : mapped === 'no_answer' ? 'no_response' : 'technical_failure');
  }
  if (mapped === 'completed') {
    const conv = live.get(sessionId);
    if (conv && !conv.ended) await finishCall(sessionId, conv, { status: 'completed' });
  }
  return { status: mapped };
}

export { speechToText, live as liveConversations };
