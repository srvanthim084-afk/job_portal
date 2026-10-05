/**
 * "Tell me about similar new jobs" (0110).
 *
 *   GET  /api/saved-job-alerts/settings        the candidate's switch (ON unless turned off)
 *   PUT  /api/saved-job-alerts/settings        { enabled: boolean }
 *   GET  /api/saved-job-alerts/stop?token=     the email's unsubscribe link, no sign-in needed
 *
 * The switch is the candidate's own row (RLS, 0110). The stop link is a
 * signed token naming the candidate (saved-job-alerts.js stopToken); the
 * API verifies it and turns the switch off as the engine.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { verifyStopToken, dailyCap } from '../notify/saved-job-alerts.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);

function page(title, line) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · TeamLink</title>
<style>body{margin:0;background:#f4f7fb;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202c}
main{max-width:480px;margin:12vh auto;padding:28px 26px;background:#fff;border:1px solid #e6ebf2;border-radius:14px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#42505f}a{color:#1d6ff2;font-weight:700}</style></head>
<body><main><h1>${esc(title)}</h1><p>${line}</p><p><a href="/#/candidate/saved">Open your saved jobs</a></p></main></body></html>`;
}

const settingsBody = z.object({ enabled: z.boolean() }).strict();

async function readSettings(c, candidateId) {
  const row = (await c.query(
    `select enabled, changed_via, updated_at from candidate_saved_job_alert_settings where candidate_id = $1`,
    [candidateId])).rows[0];
  return {
    enabled: row ? row.enabled !== false : true,
    changedVia: row ? row.changed_via : null,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    dailyCap: dailyCap(),
  };
}

export default function savedJobAlertRoutes() {
  const r = Router();

  r.get('/saved-job-alerts/stop', wrap(async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    const id = verifyStopToken(req.query.token);
    if (!id) {
      return res.status(400).send(page('That link is not valid',
        'It may have been cut short by your email app. You can switch these emails off on your Saved Jobs page instead.'));
    }
    const done = await withUser(ENGINE, async (c) => {
      const known = (await c.query(`select 1 from candidates where id = $1`, [id])).rowCount > 0;
      if (!known) return false;
      await c.query(
        `insert into candidate_saved_job_alert_settings (candidate_id, enabled, changed_via, updated_at)
         values ($1, false, 'email_link', now())
         on conflict (candidate_id) do update set enabled = false, changed_via = 'email_link', updated_at = now()`,
        [id]);
      return true;
    });
    if (!done) {
      return res.status(404).send(page('Nothing to stop', 'That profile no longer exists, so there is nothing left to send.'));
    }
    return res.send(page('Similar-job emails stopped',
      'You will not be told about new jobs like the ones you saved any more. Your saved jobs are still there, '
      + 'and you can switch this back on from your Saved Jobs page whenever you like.'));
  }));

  r.get('/saved-job-alerts/settings', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const out = await withUser(req.session, (c) => readSettings(c, req.session.profileId));
    res.json({ settings: out });
  }));

  r.put('/saved-job-alerts/settings', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const b = settingsBody.safeParse(req.body || {});
    if (!b.success) throw badRequest('Send { enabled: true } or { enabled: false }.', { enabled: 'Must be true or false.' });
    const out = await withUser(req.session, async (c) => {
      await c.query(
        `insert into candidate_saved_job_alert_settings (candidate_id, enabled, changed_via, updated_at)
         values ($1, $2, 'page', now())
         on conflict (candidate_id) do update set enabled = excluded.enabled, changed_via = 'page', updated_at = now()`,
        [req.session.profileId, b.data.enabled]);
      return readSettings(c, req.session.profileId);
    });
    res.json({ settings: out });
  }));

  return r;
}
