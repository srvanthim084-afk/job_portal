/**
 * The candidate's AI Career Assistant.
 *
 *   POST   /api/career-assistant/messages          { conversationId?, text, context?: { interviewId? } }
 *            -> { conversationId, reply, usedTools, engine: "ai" | "rules", message }
 *   GET    /api/career-assistant/conversations     the candidate's conversations, newest first
 *   GET    /api/career-assistant/conversations/:id the messages of one
 *   DELETE /api/career-assistant/conversations/:id "Clear chat"
 *   GET    /api/career-assistant/suggestion        the home page's "AI career suggestions" card:
 *            -> { reply, engine, language, usedTools, cached }
 *
 * Candidate only. Session auth, CSRF and the API-wide rate limiter apply
 * like everywhere else; on top of that a candidate may send 30 messages
 * an hour - counted in career_assistant_usage, which neither a restart nor
 * "Clear chat" resets - and the 31st gets a 429 that says when to try again.
 *
 * Row level security (0100) keeps each conversation to its candidate.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  aiConfigured, askModel, rulesReply, AssistantUnavailable, HISTORY_TURNS,
} from '../ai/career-assistant.js';
import { SUGGESTION_QUESTION } from '../ai/career-assistant-i18n.js';

export const HOURLY_LIMIT = Number(process.env.CAREER_ASSISTANT_HOURLY_LIMIT || 30);

const SUGGESTION_TTL_MS = Number(process.env.CAREER_ASSISTANT_SUGGESTION_TTL_MS || 6 * 3600_000);
const suggestionCache = new Map();   // `${userId}|${lang}` -> { body, until }

const newId = () => `ca_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const body = z.object({
  conversationId: z.string().trim().max(60).optional().nullable(),
  text: z.string().trim().min(1, 'Type a message first.').max(2000, 'Keep a message under 2000 characters.'),
  context: z.object({ interviewId: z.string().trim().max(60).optional() }).strict().optional(),
}).strict();

const shapeMessage = (m) => ({
  id: String(m.id),
  role: m.role,
  text: m.text,
  engine: m.engine || null,
  usedTools: Array.isArray(m.tools_used) ? m.tools_used : [],
  createdAt: m.created_at ? new Date(m.created_at).toISOString() : null,
});

export default function careerAssistantRoutes() {
  const r = Router();
  const candidate = [requireAuth(), requireRole('candidate')];

  r.post('/career-assistant/messages', ...candidate, wrap(async (req, res) => {
    const parsed = body.safeParse(req.body || {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw badRequest(i && /Type a message|Keep a message/.test(i.message) ? i.message : 'Please check your message and try again.');
    }
    const b = parsed.data;

    // Who, what came before, and how many this hour - one read.
    const pre = await withUser(req.session, async (c) => {
      const used = (await c.query(
        `select count(*)::int n, min(created_at) first from career_assistant_usage
          where candidate_id = app_candidate_id() and created_at > now() - interval '1 hour'`)).rows[0];
      let conv = null;
      if (b.conversationId) {
        conv = (await c.query(`select * from career_assistant_conversations where id = $1`, [b.conversationId])).rows[0];
        if (!conv) throw notFound('That conversation could not be found. It may have been cleared.');
      }
      const history = conv ? (await c.query(
        `select role, text from (select * from career_assistant_messages where conversation_id = $1
           order by id desc limit $2) x order by id`, [conv.id, HISTORY_TURNS])).rows : [];
      let interview = null;
      if (b.context && b.context.interviewId) {
        interview = (await c.query(
          `select i.id, i.type, i.scheduled_date, i.scheduled_time, j.title from interviews i
             left join jobs j on j.id = i.job_id
            where i.id = $1 and i.candidate_id = app_candidate_id()`, [b.context.interviewId])).rows[0] || null;
      }
      return { used, conv, history, interview };
    });

    if (pre.used.n >= HOURLY_LIMIT) {
      const wait = Math.max(1, Math.ceil((new Date(pre.used.first).getTime() + 3600_000 - Date.now()) / 60000));
      res.setHeader('retry-after', String(wait * 60));
      throw new ApiError(429, 'ASSISTANT_RATE_LIMITED',
        `You have sent ${HOURLY_LIMIT} messages to the assistant in the last hour. Please try again in about ${wait} minute${wait === 1 ? '' : 's'}.`);
    }

    // The interview prep kit can open the assistant on one interview.
    const context = pre.interview
      ? `(The candidate opened this chat from the prep kit for their interview ${pre.interview.id}: `
        + `${String(pre.interview.type || 'Interview').replace(/\bclient\b/gi, 'Company')} for "${pre.interview.title || 'a job'}"`
        + `${pre.interview.scheduled_date ? ` on ${pre.interview.scheduled_date}` : ''}. Use get_my_interviews for its details.)`
      : null;

    let answer;
    let engine;
    if (aiConfigured()) {
      engine = 'ai';
      try {
        answer = await askModel(req.session, { history: pre.history, text: b.text, context });
      } catch (err) {
        if (err instanceof AssistantUnavailable) {
          console.error('[career-assistant] model unavailable:', err.reason,
            err.cause && err.cause.status ? `status ${err.cause.status}` : '');
          throw new ApiError(503, 'ASSISTANT_UNAVAILABLE', 'Assistant is unavailable right now, please try again.');
        }
        throw err;
      }
    } else {
      engine = 'rules';
      answer = await rulesReply(req.session, b.text, { interviewId: pre.interview && pre.interview.id });
    }

    const saved = await withUser(req.session, async (c) => {
      let convId = pre.conv && pre.conv.id;
      if (!convId) {
        convId = newId();
        await c.query(`insert into career_assistant_conversations (id, candidate_id) values ($1, app_candidate_id())`, [convId]);
      }
      await c.query(
        `insert into career_assistant_messages (conversation_id, candidate_id, role, text)
         values ($1, app_candidate_id(), 'user', $2)`, [convId, b.text]);
      await c.query(`insert into career_assistant_usage (candidate_id, engine) values (app_candidate_id(), $1)`, [engine]);
      const m = (await c.query(
        `insert into career_assistant_messages (conversation_id, candidate_id, role, text, tools_used, engine,
                                                input_tokens, output_tokens)
         values ($1, app_candidate_id(), 'assistant', $2, $3::jsonb, $4, $5, $6) returning *`,
        [convId, answer.reply, JSON.stringify(answer.usedTools || []), engine,
         answer.inputTokens ?? null, answer.outputTokens ?? null])).rows[0];
      return { convId, m };
    });

    res.json({
      conversationId: saved.convId,
      reply: answer.reply,
      usedTools: answer.usedTools || [],
      engine,
      ...(answer.language ? { language: answer.language } : {}),
      message: shapeMessage(saved.m),
      remainingThisHour: Math.max(0, HOURLY_LIMIT - pre.used.n - 1),
    });
  }));

  /*
   * The home page's small "AI career suggestions" card. It used to be
   * the browser's cpAnswer() keyword matching; it is now the same engine
   * as the chat, asked one fixed question ("What skills should I
   * learn?") in the candidate's preferred language.
   *
   * NOT A CHAT MESSAGE: nothing is added to the conversation, so opening
   * Home does not fill the chat with a question the candidate never typed.
   *
   *   rules  answered fresh from the database every time (cheap; real data).
   *   ai     one model call per candidate and language per
   *          CAREER_ASSISTANT_SUGGESTION_TTL_MS (6 h), kept in memory; each
   *          call counts in career_assistant_usage like a chat message and
   *          the hourly limit applies. When the model cannot be reached the
   *          card is told so (503) - no substitute answer.
   */
  r.get('/career-assistant/suggestion', ...candidate, wrap(async (req, res) => {
    const pref = await withUser(req.session, async (c) => {
      const row = (await c.query(`select preferred_language from candidates where id = app_candidate_id()`)).rows[0];
      return (row && row.preferred_language) || 'en';
    });
    const lang = ['en', 'te', 'hi'].includes(pref) ? pref : 'en';
    const question = SUGGESTION_QUESTION[lang];

    if (!aiConfigured()) {
      const out = await rulesReply(req.session, question, { lang });
      res.json({ reply: out.reply, engine: 'rules', language: out.language, usedTools: out.usedTools, cached: false });
      return;
    }

    const key = `${req.session.userId}|${lang}`;
    const hit = suggestionCache.get(key);
    if (hit && hit.until > Date.now()) {
      res.json({ ...hit.body, cached: true });
      return;
    }
    const used = await withUser(req.session, async (c) => (await c.query(
      `select count(*)::int n from career_assistant_usage
        where candidate_id = app_candidate_id() and created_at > now() - interval '1 hour'`)).rows[0].n);
    if (used >= HOURLY_LIMIT) {
      throw new ApiError(429, 'ASSISTANT_RATE_LIMITED', 'Suggestions are paused for a while - you have used the assistant a lot in the last hour.');
    }
    let answer;
    try {
      answer = await askModel(req.session, { history: [], text: question, context: null });
    } catch (err) {
      if (err instanceof AssistantUnavailable) {
        console.error('[career-assistant] suggestion: model unavailable:', err.reason);
        throw new ApiError(503, 'ASSISTANT_UNAVAILABLE', 'Assistant is unavailable right now, please try again.');
      }
      throw err;
    }
    await withUser(req.session, (c) => c.query(
      `insert into career_assistant_usage (candidate_id, engine) values (app_candidate_id(), 'ai')`));
    const body = { reply: answer.reply, engine: 'ai', language: lang, usedTools: answer.usedTools || [] };
    if (suggestionCache.size > 5000) suggestionCache.clear();
    if (!answer.refused) suggestionCache.set(key, { body, until: Date.now() + SUGGESTION_TTL_MS });
    res.json({ ...body, cached: false });
  }));

  r.get('/career-assistant/conversations', ...candidate, wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select c.id, c.created_at, c.updated_at,
              (select count(*)::int from career_assistant_messages m where m.conversation_id = c.id) as messages
         from career_assistant_conversations c order by c.updated_at desc limit 20`)).rows);
    res.json({
      conversations: rows.map((x) => ({
        id: x.id, messages: x.messages,
        createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(),
      })),
      engine: aiConfigured() ? 'ai' : 'rules',
    });
  }));

  r.get('/career-assistant/conversations/:id', ...candidate, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const conv = (await c.query(`select * from career_assistant_conversations where id = $1`, [req.params.id])).rows[0];
      if (!conv) return null;
      const msgs = (await c.query(
        `select * from (select * from career_assistant_messages where conversation_id = $1 order by id desc limit 200) x
          order by id`, [conv.id])).rows;
      return { conv, msgs };
    });
    if (!out) throw notFound('That conversation could not be found.');
    res.json({
      conversationId: out.conv.id,
      messages: out.msgs.map(shapeMessage),
      engine: aiConfigured() ? 'ai' : 'rules',
    });
  }));

  r.delete('/career-assistant/conversations/:id', ...candidate, wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) =>
      (await c.query(`delete from career_assistant_conversations where id = $1`, [req.params.id])).rowCount);
    if (!n) throw notFound('That conversation could not be found.');
    res.json({ ok: true });
  }));

  return r;
}
