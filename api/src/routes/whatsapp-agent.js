/**
 * The AI WhatsApp Agent.
 *
 *   GET  /api/whatsapp-agent/status    { configured, sending, webhook, engine, missing?, webhookPath? }
 *          what is set up - booleans for everybody; the NAMES of the missing
 *          environment variables and the webhook path only for an administrator.
 *          Never a value.
 *   POST /api/whatsapp-agent/chat      { text, jobIds? } -> { reply, jobs, usedTools, engine, identity, channel }
 *          the chat on the page. A signed-in candidate is answered about their
 *          own applications and interviews; anybody else can search open jobs.
 *   GET  /api/whatsapp-agent/webhook   Meta's verification handshake (WHATSAPP_VERIFY_TOKEN)
 *   POST /api/whatsapp-agent/webhook   a real WhatsApp message. Accepted only when
 *          WHATSAPP_APP_SECRET is set and the X-Hub-Signature-256 of the exact
 *          raw body matches; the sender's phone number identifies the candidate;
 *          the answer goes back through the existing WhatsApp provider.
 *
 * Nothing is sent or pretended when WhatsApp is not configured: the page says
 * so, and the webhook answers 503.
 *
 * Secrets stay in the server environment: WHATSAPP_API_KEY, WHATSAPP_PHONE_ID,
 * WHATSAPP_API_URL (existing), WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET.
 * Message text is not logged - only that a message was handled and how the
 * reply was sent.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { config } from '../config.js';
import { whatsappProvider } from '../notify/providers.js';
import { aiConfigured } from '../ai/career-assistant.js';
import { agentReply } from '../whatsapp/agent.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const isLocal = (u) => /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(String(u || ''));

/** The public origin the links in a reply point to. */
export function publicBase(req) {
  const s = String(process.env.PUBLIC_SHARE_URL || '').trim();
  if (s) return s.replace(/\/+$/, '');
  const o = String(process.env.PUBLIC_ORIGIN || '').trim();
  if (o && !isLocal(o)) return o.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The last jobs shown to a phone number, so "apply 2" knows which job. */
const LAST_JOBS = new Map();            // phone10 -> { ids, until }
const SEEN = new Map();                 // message id -> until (Meta retries a delivery)
const SENT = new Map();                 // phone10 -> [timestamps]
const TTL = 2 * 3600_000;
const HOURLY_PER_PHONE = Number(process.env.WHATSAPP_AGENT_HOURLY_PER_PHONE || 40);
function sweep(map) { const now = Date.now(); for (const [k, v] of map) if ((v.until || v) < now) map.delete(k); }

export function webhookStatus() {
  const hasSecret = !!process.env.WHATSAPP_APP_SECRET;
  const hasVerify = !!process.env.WHATSAPP_VERIFY_TOKEN;
  const sending = whatsappProvider.configured();
  const missing = [];
  if (!config.whatsappApiKey) missing.push('WHATSAPP_API_KEY');
  if (!config.whatsappPhoneId) missing.push('WHATSAPP_PHONE_ID');
  if (!hasVerify) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (!hasSecret) missing.push('WHATSAPP_APP_SECRET');
  return { sending, webhook: hasSecret && hasVerify, configured: sending && hasSecret && hasVerify, missing };
}

/** The candidate whose registered mobile this WhatsApp number is; null unless exactly one. */
async function candidateByPhone(phone10) {
  if (phone10.length < 10) return null;
  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select c.id, c.user_id from candidates c
      where c.user_id is not null
        and right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10) = $1 limit 3`, [phone10])).rows);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * One incoming WhatsApp text message. Exported so tests drive it directly.
 * Returns what was sent (status), never the text.
 */
export async function handleIncoming(msg, base) {
  sweep(SEEN); sweep(LAST_JOBS);
  const id = String(msg.id || '');
  if (id) { if (SEEN.has(id)) return { status: 'duplicate' }; SEEN.set(id, Date.now() + TTL); }

  const from = String(msg.from || '');
  const phone10 = from.replace(/\D/g, '').slice(-10);
  const stamps = (SENT.get(phone10) || []).filter((t) => t > Date.now() - 3600_000);
  if (stamps.length >= HOURLY_PER_PHONE) return { status: 'rate_limited' };
  stamps.push(Date.now()); SENT.set(phone10, stamps);

  let reply;
  if (msg.type !== 'text' || !msg.text || !String(msg.text.body || '').trim()) {
    reply = 'I can read text messages for now. Please type your question - for example "jobs in Hyderabad".';
  } else {
    const cand = await candidateByPhone(phone10);
    const session = cand ? { userId: cand.user_id, role: 'candidate', profileId: cand.id } : null;
    const known = LAST_JOBS.get(phone10);
    const out = await agentReply({
      session, text: String(msg.text.body).slice(0, 500), base,
      jobIds: known ? known.ids : [],
    });
    if (out.jobs && out.jobs.length) LAST_JOBS.set(phone10, { ids: out.jobs.map((j) => j.id), until: Date.now() + TTL });
    reply = out.reply;
  }
  const res = await whatsappProvider.send({ to: from, text: String(reply).slice(0, 3800) });
  console.log(`[whatsapp-agent] message handled, reply ${res.status}`);
  return { status: res.status, error: res.error };
}

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.WHATSAPP_CHAT_RATE_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'You are sending messages too quickly. Please wait a moment and try again.')),
});

const chatBody = z.object({
  text: z.string().trim().min(1, 'Type a message first.').max(500, 'Keep a message under 500 characters.'),
  jobIds: z.array(z.string().trim().max(80)).max(10).optional(),
}).strict();

export default function whatsappAgentRoutes() {
  const r = Router();

  r.get('/whatsapp-agent/status', wrap(async (req, res) => {
    const s = webhookStatus();
    const admin = !!(req.session && req.session.role === 'admin');
    res.json({
      configured: s.configured, sending: s.sending, webhook: s.webhook,
      engine: aiConfigured() ? 'ai' : 'rules',
      ...(admin ? { missing: s.missing, webhookPath: '/api/whatsapp-agent/webhook' } : {}),
    });
  }));

  r.post('/whatsapp-agent/chat', chatLimiter, wrap(async (req, res) => {
    const p = chatBody.safeParse(req.body || {});
    if (!p.success) {
      const i = p.error.issues[0];
      throw badRequest(i && /Type a message|Keep a message/.test(i.message) ? i.message : 'Please check your message and try again.');
    }
    const s = req.session;
    const session = s && s.role === 'candidate' ? { userId: s.userId, role: 'candidate', profileId: s.profileId || null } : null;
    let out;
    try {
      out = await agentReply({ session, text: p.data.text, base: publicBase(req), jobIds: p.data.jobIds || [] });
    } catch (err) {
      console.error('[whatsapp-agent] chat failed:', err && err.message);
      throw new ApiError(503, 'AGENT_UNAVAILABLE', 'The AI agent is temporarily unavailable. Please try again.');
    }
    res.json({ reply: out.reply, jobs: out.jobs, usedTools: out.usedTools, engine: out.engine, identity: out.identity, channel: 'web' });
  }));

  r.get('/whatsapp-agent/webhook', (req, res) => {
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!token) return res.status(503).type('text/plain').send('WhatsApp webhook is not configured.');
    if (req.query['hub.mode'] === 'subscribe' && same(req.query['hub.verify_token'] || '', token)) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    return res.sendStatus(403);
  });

  r.post('/whatsapp-agent/webhook', wrap(async (req, res) => {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) throw new ApiError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp Agent is not configured.');
    const header = String(req.get('x-hub-signature-256') || '');
    const raw = req.rawBody;
    const want = raw ? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` : '';
    if (!want || !same(header, want)) return res.sendStatus(403);

    res.sendStatus(200);              // Meta wants a quick answer; the work follows
    const base = publicBase(req);
    const msgs = [];
    for (const e of (req.body && req.body.entry) || []) {
      for (const ch of (e && e.changes) || []) {
        for (const m of (ch && ch.value && ch.value.messages) || []) msgs.push(m);
      }
    }
    for (const m of msgs) {
      try { await handleIncoming(m, base); } catch (err) { console.error('[whatsapp-agent] handling failed:', err && err.message); }
    }
  }));

  return r;
}
