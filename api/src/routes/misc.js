/**
 * Notifications, interviews, offers and per-user preferences.
 *
 * Notifications answer requirement 12 — "Do not show unrelated candidate
 * notifications". The handler contains no ownership check at all: the
 * policy on `notifications` only ever returns rows addressed to the
 * caller, so there is nothing here to get wrong.
 *
 * `user_prefs` is the destination for the ~35 localStorage keys that hold
 * per-user settings (DATA-MAPPING §4.4). It keeps a get/set shape so the
 * browser-side `tlStore` shim can stand in for localStorage without any
 * call site changing.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { toRupees } from '../money.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { dispatchEvent } from '../notify/events.js';
import { toNotification, toInterview, toOffer } from '../shapes.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export default function miscRoutes() {
  const r = Router();

  /* ---------------- notifications ---------------- */

  r.get('/notifications', requireAuth(), wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const out = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select * from notifications ${unreadOnly ? 'where not read' : ''}
         order by created_at desc limit $1`, [limit]);
      const unread = await c.query(`select count(*)::int n from notifications where not read`);
      return { rows, unread: unread.rows[0].n };
    });
    res.json({ notifications: out.rows.map(toNotification), unread: out.unread });
  }));

  r.put('/notifications/:id/read', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const { rowCount } = await c.query(
        `update notifications set read=true where id=$1`, [req.params.id]);
      const unread = await c.query(`select count(*)::int n from notifications where not read`);
      return { rowCount, unread: unread.rows[0].n };
    });
    if (!out.rowCount) throw notFound('That notification no longer exists.');
    res.json({ ok: true, unread: out.unread });
  }));

  r.put('/notifications/read-all', requireAuth(), wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) => {
      const { rowCount } = await c.query(`update notifications set read=true where not read`);
      return rowCount;
    });
    res.json({ ok: true, marked: n, unread: 0 });
  }));

  /* ---------------- interviews ---------------- */

  r.get('/interviews', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (req.query.candidateId) { params.push(req.query.candidateId); where.push(`candidate_id=$${params.length}`); }
      if (req.query.jobId)       { params.push(req.query.jobId);       where.push(`job_id=$${params.length}`); }
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const { rows } = await c.query(
        `select * from interviews ${clause} order by scheduled_date desc nulls last`, params);
      return rows;
    });
    res.json({ interviews: rows.map(toInterview) });
  }));

  r.post('/interviews', requireAuth(), requireRole('recruiter', 'client', 'admin'),
    wrap(async (req, res) => {
      const schema = z.object({
        candidateId: z.string().trim().min(1).max(64),
        jobId: z.string().trim().min(1).max(64),
        type: z.string().trim().max(60).optional(),
        date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.').optional(),
        time: z.string().trim().max(20).optional(),
        mode: z.string().trim().max(60).optional(),
        interviewer: z.string().trim().max(160).optional(),
      });
      const p = schema.safeParse(req.body || {});
      if (!p.success) {
        const details = {};
        for (const i of p.error.issues) details[i.path.join('.') || 'form'] = i.message;
        throw badRequest('Please check the interview details.', details);
      }
      const b = p.data;

      const row = await withUser(req.session, async (c) => {
        const app = await c.query(
          `select id from applications where candidate_id=$1 and job_id=$2 limit 1`,
          [b.candidateId, b.jobId]);

        const { rows } = await c.query(
          `insert into interviews
             (id, candidate_id, job_id, application_id, type, scheduled_date,
              scheduled_time, mode, status, interviewer)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'Scheduled',$9) returning *`,
          [newId('iv'), b.candidateId, b.jobId, app.rows[0]?.id || null,
           b.type || 'Technical (Human)', b.date || null, b.time || null,
           b.mode || 'Video Call', b.interviewer || null]);

        // keep the pipeline honest: scheduling an interview moves the stage
        if (app.rowCount) {
          await c.query(
            `update applications set stage='interview_scheduled'
              where id=$1 and stage not in ('selected','rejected','offer_extended')`,
            [app.rows[0].id]);
        }

        const job = await c.query(`select title from jobs where id=$1`, [b.jobId]);
        await c.query(
          `select notify_create($1,$2,'candidate','INTERVIEW_SCHEDULED',$3,$4,$5,$6,$7,null,'{}')`,
          [newId('ntf'), b.candidateId, 'Interview Scheduled',
           `An interview has been scheduled for ${job.rows[0]?.title || 'your application'}` +
           (b.date ? ` on ${b.date}${b.time ? ' at ' + b.time : ''}.` : '.'),
           b.jobId, app.rows[0]?.id || null, b.candidateId]);

        return { row: rows[0], applicationId: app.rows[0]?.id || null };
      });

      // Same channels as every other event, after the commit.
      const notify = row.applicationId
        ? await dispatchEvent(req.session, 'INTERVIEW_SCHEDULED', {
            applicationId: row.applicationId,
            scheduledAt: b.date ? `${b.date}${b.time ? ' ' + b.time : ''}` : null,
            mode: b.mode || null,
            interviewer: b.interviewer || null,
          })
        : null;

      res.status(201).json({ interview: toInterview(row.row), notify });
    }));

  r.put('/interviews/:id', requireAuth(), requireRole('recruiter', 'client', 'admin'),
    wrap(async (req, res) => {
      const { status, aiScore, feedback, date, time } = req.body || {};
      const row = await withUser(req.session, async (c) => {
        // What it was, so the change can be described rather than
        // guessed at: "rescheduled" only means something against a
        // previous date.
        const before = (await c.query(
          `select * from interviews where id=$1`, [req.params.id])).rows[0];
        if (!before) throw notFound('That interview no longer exists.');

        const sets = [], vals = [];
        if (status)   { vals.push(status);   sets.push(`status=$${vals.length}`); }
        if (date)     { vals.push(date);     sets.push(`scheduled_date=$${vals.length}`); }
        if (time)     { vals.push(time);     sets.push(`scheduled_time=$${vals.length}`); }
        if (aiScore !== undefined) { vals.push(aiScore); sets.push(`ai_score=$${vals.length}`); }
        if (feedback !== undefined) {
          vals.push(JSON.stringify(feedback)); sets.push(`feedback=$${vals.length}::jsonb`);
        }
        if (!sets.length) throw badRequest('Nothing to update.');
        vals.push(req.params.id);
        const upd = await c.query(
          `update interviews set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
        if (!upd.rowCount) throw notFound('That interview no longer exists.');
        return { before, after: upd.rows[0] };
      });

      /*
       * Tell the candidate what changed.
       *
       * The status and the time could be edited and nobody was told, so
       * a cancelled interview stayed in somebody's calendar and a moved
       * one was attended at the old hour. Two cases are worth a message:
       *
       *   cancelled     the interview is off
       *   rescheduled   still on, at a different date or time
       *
       * Anything else - a score, feedback, a no-show recorded after the
       * fact - is recruiter bookkeeping and is not the candidate's news.
       */
      const wasCancelled = row.after.status === 'Cancelled'
        && row.before.status !== 'Cancelled';
      const moved = row.after.status !== 'Cancelled'
        && (String(row.before.scheduled_date || '') !== String(row.after.scheduled_date || '')
            || String(row.before.scheduled_time || '') !== String(row.after.scheduled_time || ''));

      let delivery;
      if ((wasCancelled || moved) && row.after.application_id) {
        const when = (d) => (d
          ? new Date(d).toLocaleDateString('en-GB',
              { day: 'numeric', month: 'short', year: 'numeric' })
          : undefined);

        delivery = await dispatchEvent(req.session,
          wasCancelled ? 'INTERVIEW_CANCELLED' : 'INTERVIEW_RESCHEDULED', {
            applicationId: row.after.application_id,
            candidateId: row.after.candidate_id,
            jobId: row.after.job_id,
            // A cancellation quotes the slot that is being cancelled;
            // a reschedule quotes the new one.
            interviewDate: when(wasCancelled ? row.before.scheduled_date : row.after.scheduled_date),
            interviewTime: (wasCancelled ? row.before.scheduled_time : row.after.scheduled_time)
              || undefined,
            interviewType: row.after.type || row.after.mode || undefined,
          });
      }

      res.json({ interview: toInterview(row.after), delivery: delivery || undefined });
    }));

  /* ---------------- offers ---------------- */

  r.get('/offers', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from offers order by extended_at desc`);
      return rows;
    });
    res.json({ offers: rows.map(toOffer) });
  }));

  r.post('/offers', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const { applicationId, ctc, joiningDate, notes } = req.body || {};
    if (!applicationId) throw badRequest('An application is required to extend an offer.');

    // "18,00,000" is how the offer is written on the screen, and `ctc` is a
    // numeric column: handed over unchanged it fails with `invalid input
    // syntax for type numeric` and the recruiter is shown a 500 for typing
    // a number the normal way.
    const hasCtc = ctc !== undefined && ctc !== null && String(ctc).trim() !== '';
    const ctcValue = hasCtc ? toRupees(ctc) : null;
    if (hasCtc && ctcValue === null) {
      throw badRequest('That CTC could not be read. Try "18,00,000" or "18 LPA".');
    }

    const row = await withUser(req.session, async (c) => {
      const app = await c.query(`select * from applications where id=$1`, [applicationId]);
      if (!app.rowCount) throw notFound('That application no longer exists.');
      const a = app.rows[0];

      const { rows } = await c.query(
        `insert into offers (id, application_id, candidate_id, job_id, ctc, joining_date, notes, extended_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [newId('off'), a.id, a.candidate_id, a.job_id,
         ctcValue, joiningDate || null, notes || null,
         req.session.role === 'recruiter' ? req.session.profileId : null]);

      await c.query(`update applications set stage='offer_extended' where id=$1`, [a.id]);
      await c.query(
        `select notify_create($1,$2,'candidate','OFFER_EXTENDED',$3,$4,$5,$6,$7,null,'{}')`,
        [newId('ntf'), a.candidate_id, 'Offer Extended',
         'Congratulations — an offer has been extended for your application.',
         a.job_id, a.id, a.candidate_id]);

      return { row: rows[0], applicationId: a.id, ctc: ctcValue, joiningDate };
    });

    const notify = await dispatchEvent(req.session, 'OFFER_EXTENDED', {
      applicationId: row.applicationId,
      ctc: row.ctc ?? null,
      joiningDate: row.joiningDate || null,
    });

    res.status(201).json({ offer: toOffer(row.row), notify });
  }));

  r.put('/offers/:id', requireAuth(), wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['accepted', 'declined', 'withdrawn'].includes(status)) {
      throw badRequest('Status must be accepted, declined or withdrawn.');
    }
    const row = await withUser(req.session, async (c) => {
      const upd = await c.query(
        `update offers set status=$1, responded_at=now() where id=$2 returning *`,
        [status, req.params.id]);
      if (!upd.rowCount) throw notFound('That offer no longer exists.');
      if (status === 'accepted') {
        await c.query(`update applications set stage='selected' where id=$1`,
          [upd.rows[0].application_id]);
      }
      return upd.rows[0];
    });
    res.json({ offer: toOffer(row) });
  }));

  /* ---------------- per-user preferences ---------------- */

  r.get('/prefs', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select key, value from user_prefs`);
      return rows;
    });
    const prefs = {};
    for (const row of rows) prefs[row.key] = row.value;
    res.json({ prefs });
  }));

  r.put('/prefs/:key', requireAuth(), wrap(async (req, res) => {
    const key = String(req.params.key).slice(0, 120);
    if (!/^[\w.:-]+$/.test(key)) throw badRequest('Invalid preference key.');
    const value = req.body?.value;
    if (value === undefined) throw badRequest('A value is required.');

    // A preference blob is user-controlled, so it is capped. Without this
    // anyone could fill the table with megabytes of JSON.
    const encoded = JSON.stringify(value);
    if (encoded.length > 256 * 1024) throw badRequest('That preference is too large to store.');

    await withUser(req.session, (c) => c.query(
      `insert into user_prefs (user_id, key, value) values ($1,$2,$3::jsonb)
       on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`,
      [req.session.userId, key, encoded]));

    res.json({ ok: true });
  }));

  r.delete('/prefs/:key', requireAuth(), wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(
      `delete from user_prefs where user_id=$1 and key=$2`,
      [req.session.userId, String(req.params.key)]));
    res.json({ ok: true });
  }));

  /* ---------------- saved / hidden jobs ---------------- */

  r.post('/saved-jobs/:jobId', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(
      `insert into saved_jobs (candidate_id, job_id) values ($1,$2) on conflict do nothing`,
      [req.session.profileId, req.params.jobId]));
    res.json({ ok: true });
  }));

  r.delete('/saved-jobs/:jobId', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(
      `delete from saved_jobs where candidate_id=$1 and job_id=$2`,
      [req.session.profileId, req.params.jobId]));
    res.json({ ok: true });
  }));

  r.get('/saved-jobs', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const saved  = await c.query(`select job_id from saved_jobs`);
      const hidden = await c.query(`select job_id from hidden_jobs`);
      return { saved: saved.rows.map((r) => r.job_id), hidden: hidden.rows.map((r) => r.job_id) };
    });
    res.json(rows);
  }));

  return r;
}
