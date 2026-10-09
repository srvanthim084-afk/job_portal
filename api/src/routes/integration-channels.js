/**
 * Administration -> Integrations -> Email (SMTP), SMS Gateway, WhatsApp Business (0122).
 *
 *   GET  /api/admin/integration-channels                  the three cards (secrets: saved / last 4 only)
 *   PUT  /api/admin/integration-channels/:channel         Save & Connect  (a blank secret keeps, "-" clears)
 *   POST /api/admin/integration-channels/:channel/connect       Connect / Reconnect what is saved
 *   POST /api/admin/integration-channels/:channel/disconnect
 *   POST /api/admin/integration-channels/:channel/test    a REAL message through the real provider
 *   GET  /api/admin/integration-channels/:channel/events  the history
 *
 * Super Admin only (the one `admin` role). No response carries a credential, and request bodies are
 * never logged.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  channelKey, listChannels, saveChannel, connectChannel, disconnectChannel, testChannel, eventsOf,
} from '../notify/channel-config.js';

const admin = [requireAuth(), requireRole('admin')];

export default function integrationChannelRoutes() {
  const r = Router();

  r.get('/admin/integration-channels', ...admin, wrap(async (req, res) => {
    res.json(await listChannels(req.session));
  }));

  r.get('/admin/integration-channels/:channel/events', ...admin, wrap(async (req, res) => {
    res.json({ events: await eventsOf(req.session, channelKey(req.params.channel)) });
  }));

  r.put('/admin/integration-channels/:channel', ...admin, wrap(async (req, res) => {
    const channel = channelKey(req.params.channel);
    const body = z.object({
      config: z.record(z.any()).optional(),
      secrets: z.record(z.any()).optional(),
      connect: z.boolean().optional(),
    }).safeParse(req.body || {});
    if (!body.success) throw badRequest('Please check the form and try again.');
    res.json({ channel: await saveChannel(req.session, channel, body.data) });
  }));

  r.post('/admin/integration-channels/:channel/connect', ...admin, wrap(async (req, res) => {
    res.json({ channel: await connectChannel(req.session, channelKey(req.params.channel)) });
  }));

  r.post('/admin/integration-channels/:channel/disconnect', ...admin, wrap(async (req, res) => {
    res.json({ channel: await disconnectChannel(req.session, channelKey(req.params.channel)) });
  }));

  r.post('/admin/integration-channels/:channel/test', ...admin, wrap(async (req, res) => {
    const channel = channelKey(req.params.channel);
    let to = String((req.body && req.body.to) || '').trim();
    if (channel === 'email') {
      /* no address given: the administrator's own */
      if (!to) {
        to = await withUser(req.session, async (c) => ((await c.query(`select email from users where id=$1`, [req.session.userId])).rows[0] || {}).email || '');
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw badRequest('Enter the email address to send the test to.', { to: 'Enter a valid email address' });
    } else if (String(to).replace(/\D/g, '').length < 10) {
      throw badRequest('Enter the mobile number to send the test to.', { to: 'Enter a valid mobile number' });
    }
    const out = await testChannel(req.session, channel, to);
    res.json({ ok: out.ok, message: out.message, channel: out.view });
  }));

  return r;
}
