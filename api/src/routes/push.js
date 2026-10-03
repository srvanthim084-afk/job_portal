/**
 * Phone notifications: a candidate's devices.
 *
 *   GET    /api/push/config              the public VAPID key, or why push is off
 *   POST   /api/push/subscribe           this browser's subscription (candidate)
 *   GET    /api/push/subscriptions       my devices
 *   DELETE /api/push/subscriptions/:id   remove one
 *   POST   /api/push/test                send a test notification to my devices
 *
 * The browser asks for permission and subscribes; this only stores what
 * the browser's push service returned. The server only ever POSTs to a
 * known push service (notify/webpush.js), never to an address a client
 * names.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  vapidConfig, endpointAllowed, sendPush, platformFrom, deviceLabel,
} from '../notify/webpush.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const newId = () => `push_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const shape = (r) => ({
  id: r.id,
  platform: r.platform || platformFrom(r.user_agent),
  device: deviceLabel(r.user_agent, r.platform || platformFrom(r.user_agent)),
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
});

const subscribeSchema = z.object({
  endpoint: z.string().trim().min(10).max(1000),
  keys: z.object({ p256dh: z.string().trim().min(80).max(120), auth: z.string().trim().min(16).max(40) }),
  platformHint: z.enum(['ios', 'android', 'desktop']).optional(),
});

export default function pushRoutes() {
  const r = Router();

  r.get('/push/config', wrap(async (_req, res) => {
    const cfg = vapidConfig();
    res.json(cfg.ok ? { configured: true, publicKey: cfg.publicKey }
      : { configured: false, error: cfg.error });
  }));

  r.post('/push/subscribe', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const cfg = vapidConfig();
    if (!cfg.ok) throw badRequest(`Phone notifications are not set up on the server: ${cfg.error}`);
    const out = subscribeSchema.safeParse(req.body || {});
    if (!out.success) throw badRequest('That subscription could not be read.', { subscription: out.error.issues[0].message });
    const b = out.data;
    if (!endpointAllowed(b.endpoint)) throw badRequest('That is not a push service this server sends to.');
    const ua = String(req.get('user-agent') || '');
    const platform = platformFrom(ua, b.platformHint);
    const row = await withUser(req.session, async (c) => (await c.query(
      `select * from push_subscribe($1,$2,$3,$4,$5,$6)`,
      [newId(), b.endpoint, b.keys.p256dh, b.keys.auth, ua, platform])).rows[0]);
    res.status(201).json({ subscription: shape(row) });
  }));

  r.get('/push/subscriptions', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from push_subscriptions order by created_at desc`)).rows);
    res.json({ subscriptions: rows.map(shape), configured: vapidConfig().ok });
  }));

  r.delete('/push/subscriptions/:id', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) => (await c.query(
      `delete from push_subscriptions where id = $1`, [req.params.id])).rowCount);
    if (!n) throw notFound('That device is not on your list.');
    res.json({ ok: true });
  }));

  r.post('/push/test', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const subs = await withUser(req.session, async (c) => (await c.query(
      `select * from push_subscriptions`)).rows);
    if (!subs.length) throw badRequest('Turn on phone notifications on a device first.');
    const results = [];
    for (const s of subs) {
      const out = await sendPush(s, {
        title: 'TeamLink', body: 'Phone notifications are working. New jobs for your saved searches will arrive here.',
        url: '/#/candidate/alerts', tag: 'tl-test',
      });
      const outcome = out.status === 'sent' ? 'sent' : out.status === 'gone' ? 'gone' : 'failed';
      if (out.status !== 'not_configured') {
        await withUser(ENGINE, (c) => c.query(`select push_engine_result($1,$2)`, [s.id, outcome]));
      }
      results.push({ id: s.id, device: deviceLabel(s.user_agent, s.platform), status: out.status, error: out.error || null });
    }
    res.json({ results, sent: results.filter((x) => x.status === 'sent').length });
  }));

  return r;
}
