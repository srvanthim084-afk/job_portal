/**
 * The AI Career Assistant.
 *
 * TWO ENGINES, AND THE ANSWER SAYS WHICH ONE SPOKE.
 *
 *   ai     AI_API_KEY is set: Claude, through the official SDK, with seven
 *          read-only tools that run as the candidate (RLS applies).
 *   rules  no key: the prototype's keyword rules (assistantReply in
 *          web/index.html), ported here and answered from the same reads
 *          the tools use. The UI labels this "Basic mode".
 *
 * Nothing pretends: without a key the reply is engine "rules", and when
 * the model cannot be reached the route says the assistant is
 * unavailable rather than quietly substituting a canned answer.
 *
 * THE MODEL CALL (spec Part A §2):
 *   - model AI_ASSISTANT_MODEL || claude-opus-5-5, effort low, max_tokens 16000
 *   - no `thinking` parameter at all (disabled / budget_tokens 400 on this
 *     model) and no assistant prefill
 *   - server-side refusal fallback: betas server-side-fallback-2026-07-01,
 *     fallbacks "default"; stop_reason is checked before content is read
 *   - the system prompt is the frozen Part B text with cache_control;
 *     candidate data travels only in tool results
 *   - the last 20 turns of history; tool rounds capped at 5; every
 *     tool_result of a round in ONE user message; failures is_error
 *   - ~30s timeout; SDK typed errors handled one by one
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { toJob } from '../shapes.js';
import { CAREER_ASSISTANT_PROMPT } from './career-assistant-prompt.js';
import { TOOL_DEFS, runTool, reads, matchSummary } from './career-assistant-tools.js';
import { REPLY_LANGS, T, detectLanguage, intentOf, fieldNames } from './career-assistant-i18n.js';

export const MODEL = process.env.AI_ASSISTANT_MODEL || 'claude-opus-5-5';
const TIMEOUT_MS = Number(process.env.AI_ASSISTANT_TIMEOUT_MS || 30_000);
const MAX_RETRIES = Number(process.env.AI_ASSISTANT_MAX_RETRIES ?? 1);
export const MAX_TOOL_ROUNDS = 5;
export const HISTORY_TURNS = 20;

export const REFUSAL_REPLY = 'Sorry, I can\'t help with that. I can help with your job search, your profile and resume, '
  + 'your applications and interview preparation - what would you like to work on?';

/** A typed failure the route turns into a 503 "unavailable". */
export class AssistantUnavailable extends Error {
  constructor(reason, cause) { super(reason); this.reason = reason; this.cause = cause; }
}

export function aiConfigured() { return !!config.aiApiKey; }

let client = null;
let clientKey = '';
function sdk() {
  const key = config.aiApiKey;
  if (!client || clientKey !== key + '|' + (process.env.AI_API_BASE_URL || '')) {
    client = new Anthropic({
      apiKey: key,
      // tests point this at a local mock server; production leaves it unset
      baseURL: process.env.AI_API_BASE_URL || undefined,
      timeout: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
    clientKey = key + '|' + (process.env.AI_API_BASE_URL || '');
  }
  return client;
}

/* ------------------------------------------------------------------ *
 * the model
 * ------------------------------------------------------------------ */

const SYSTEM = [{ type: 'text', text: CAREER_ASSISTANT_PROMPT, cache_control: { type: 'ephemeral' } }];

/**
 * @param session   the candidate's session (tools run as them)
 * @param history   [{ role:'user'|'assistant', text }] oldest first (already stored)
 * @param text      the new message
 * @param context   optional extra text block for this message (e.g. the interview it came from)
 * @returns { reply, usedTools, inputTokens, outputTokens, refused }
 */
export async function askModel(session, { history, text, context }) {
  const messages = [];
  for (const m of history.slice(-HISTORY_TURNS)) {
    if (!messages.length && m.role !== 'user') continue;   // history must start with the candidate
    messages.push({ role: m.role, content: m.text });
  }
  const content = [{ type: 'text', text }];
  if (context) content.push({ type: 'text', text: context });
  messages.push({ role: 'user', content });

  const used = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const count = (u) => {
    if (!u) return;
    inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    outputTokens += u.output_tokens || 0;
  };

  for (let round = 0; ; round += 1) {
    const lastRound = round >= MAX_TOOL_ROUNDS;
    let res;
    try {
      res = await sdk().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        tools: TOOL_DEFS,
        // After five rounds of lookups the model answers with what it has.
        ...(lastRound ? { tool_choice: { type: 'none' } } : {}),
        messages,
      });
    } catch (err) {
      throw classify(err);
    }
    count(res.usage);

    if (res.stop_reason === 'refusal') {
      return { reply: REFUSAL_REPLY, usedTools: used, inputTokens, outputTokens, refused: true };
    }

    if (res.stop_reason === 'tool_use' && !lastRound) {
      const calls = res.content.filter((b) => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: res.content });
      // every result of this round, in one user message, failures marked
      const results = await withUser(session, async (c) => {
        const out = [];
        for (const call of calls) {
          if (!used.includes(call.name)) used.push(call.name);
          // a savepoint each, so one failed read does not abort the others
          await c.query('savepoint tool');
          try {
            const data = await runTool(c, call.name, call.input);
            await c.query('release savepoint tool');
            out.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(data) });
          } catch (err) {
            await c.query('rollback to savepoint tool');
            out.push({ type: 'tool_result', tool_use_id: call.id, is_error: true,
                       content: `Could not run ${call.name}: ${toolError(err)}` });
          }
        }
        return out;
      }).catch((err) => calls.map((call) => ({
        type: 'tool_result', tool_use_id: call.id, is_error: true,
        content: `Could not run ${call.name}: ${toolError(err)}`,
      })));
      messages.push({ role: 'user', content: results });
      continue;
    }

    const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!reply) throw new AssistantUnavailable('empty reply');
    return { reply: reply.slice(0, 8000), usedTools: used, inputTokens, outputTokens, refused: false };
  }
}

/** What the model is told about a failed read - never a raw database error. */
function toolError(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return 'the data could not be read right now';
  return String((err && err.message) || err).slice(0, 200);
}

/** SDK errors, most specific first. Nothing about the key reaches the log. */
function classify(err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AssistantUnavailable('timeout', err);
  if (err instanceof Anthropic.APIConnectionError) return new AssistantUnavailable('connection', err);
  if (err instanceof Anthropic.AuthenticationError) return new AssistantUnavailable('auth', err);
  if (err instanceof Anthropic.RateLimitError) return new AssistantUnavailable('rate_limited', err);
  if (err instanceof Anthropic.BadRequestError) return new AssistantUnavailable('bad_request', err);
  if (err instanceof Anthropic.APIError) return new AssistantUnavailable(`api_${err.status || 'error'}`, err);
  return new AssistantUnavailable('unknown', err);
}

/* ------------------------------------------------------------------ *
 * the rules engine ("Basic mode")
 *
 * The prototype's assistantReply(), intent for intent and in the same
 * order, answered from the database instead of from the browser's copy:
 *   improve/profile/resume -> job/match/recommend -> should I apply ->
 *   career path -> interview prep -> salary -> skill gap -> help
 * plus one the prototype did not have and the system prompt insists on:
 * a fee for a job is fraud.
 *
 * In the candidate's language (career-assistant-i18n.js): Telugu or
 * Hindi script, romanized Telugu or Hindi, or English - detected from
 * the message, the stored preferred language when the message does not
 * say. Only the words around the data change.
 * ------------------------------------------------------------------ */

const link = (j) => `[${j.title}](#/job/${j.job_id || j.id})`;

async function topMatches(c, cand, n = 3) {
  const rows = (await c.query(`${reads.OPEN}
    where j.id not in (select job_id from hidden_jobs where candidate_id = app_candidate_id())
      and j.id not in (select job_id from applications where candidate_id = app_candidate_id())
    order by j.published_at desc nulls last limit 300`)).rows;
  return rows.map((r) => ({ row: r, job: toJob(r), m: matchSummary(toJob(r), cand) }))
    .sort((a, b) => b.m.score - a.m.score).slice(0, n);
}

/**
 * @param opts.interviewId  the interview the prep kit opened the chat on (already checked as the candidate's)
 * @param opts.lang         force the reply language ('en' | 'te' | 'hi' | 'te-Latn' | 'hi-Latn');
 *                          otherwise it is detected from the message, falling back to the
 *                          candidate's preferred language (0102)
 * @returns { reply, usedTools, language }
 */
export async function rulesReply(session, textRaw, { interviewId, lang } = {}) {
  const t = String(textRaw || '').toLowerCase();
  return withUser(session, async (c) => {
    const cand = await reads.me(c);
    const first = String(cand.name || '').split(' ')[0];
    const language = REPLY_LANGS.includes(lang) ? lang : detectLanguage(textRaw, cand.preferredLanguage);
    const L = T[language];
    const used = [];
    const say = (reply) => ({ reply, usedTools: used, language });
    const intent = intentOf(t);

    if (intent === 'fee') return say(L.fee());

    if (intent === 'profile') {
      used.push('get_my_profile');
      const p = await reads.getMyProfile(c);
      if (!p.missing_fields.length) return say(L.profileComplete(p.resume_on_file));
      return say(L.profileMissing(fieldNames(language, p.missing_fields.slice(0, 4)), p.resume_on_file));
    }

    if (intent === 'jobs') {
      used.push('search_open_jobs', 'match_me_to_job');
      const top = await topMatches(c, cand);
      if (!top.length) return say(L.noJobs());
      return say([L.jobsHead(), ...top.map((x) => L.jobLine(link(x.row), x.row.location, x.m.score)), L.jobsTail()].join('\n'));
    }

    if (intent === 'apply') {
      used.push('match_me_to_job');
      const [best] = await topMatches(c, cand, 1);
      if (!best) return say(L.noJobToEvaluate());
      const s = best.m.score;
      return say(L.applyLine(link(best.row), s, L.verdict(s))
        + (best.m.missing_skills.length ? L.applyMissing(best.m.missing_skills.slice(0, 4)) : ''));
    }

    if (intent === 'career') {
      used.push('get_my_profile', 'search_open_jobs');
      const top = await topMatches(c, cand, 8);
      const gaps = {};
      top.forEach((x) => x.m.missing_skills.forEach((s) => { gaps[s] = (gaps[s] || 0) + 1; }));
      const list = Object.entries(gaps).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
      const role = cand.preferredRole || cand.title;
      return say((role ? L.careerRole(role) : L.careerNoRole()) + (list.length ? L.careerGaps(list) : '') + L.careerTail());
    }

    if (intent === 'interview') {
      used.push('get_my_interviews');
      const ivs = await reads.getMyInterviews(c);
      const pick = (interviewId && ivs.upcoming.find((i) => i.interview_id === interviewId)) || ivs.upcoming[0];
      if (!pick) return say(L.noInterview());
      return say(L.interview({ type: pick.type, title: pick.job_title, date: pick.date, time: pick.time }));
    }

    if (intent === 'salary') {
      used.push('get_my_profile', 'match_me_to_job');
      if (cand.expectedCtc == null) return say(L.salaryNoExpected());
      const [best] = await topMatches(c, cand, 1);
      if (!best) return say(L.salaryNoJob());
      const lo = best.job.salaryMin; const hi = best.job.salaryMax;
      if (lo == null && hi == null) return say(L.salaryNoRange(link(best.row), cand.expectedCtc));
      const fits = hi == null ? cand.expectedCtc >= (lo || 0) : cand.expectedCtc <= hi;
      return say(L.salaryCompare(cand.expectedCtc, link(best.row), best.job.pay || `₹${lo ?? '?'}-${hi ?? '?'} LPA`, fits));
    }

    if (intent === 'skills') {
      used.push('match_me_to_job');
      const top = await topMatches(c, cand, 8);
      const gaps = {};
      top.forEach((x) => x.m.missing_skills.forEach((s) => { gaps[s] = (gaps[s] || 0) + 1; }));
      const list = Object.entries(gaps).sort((a, b) => b[1] - a[1]).slice(0, 4);
      return say(list.length ? L.skillsGaps(list.map(([s, n]) => L.skillItem(s, n))) : L.skillsNone());
    }

    return say(L.help(first));
  });
}
