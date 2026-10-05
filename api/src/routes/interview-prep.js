/**
 * Interview prep kit (0098).
 *
 * Candidate
 *   GET  /api/candidate/interviews/prep                 my interviews, with kit status
 *   GET  /api/candidate/interviews/:id/prep-kit         the kit page (no company, ever)
 *   POST /api/candidate/interviews/:id/prep-kit/viewed  first open is recorded
 *   PUT  /api/candidate/interviews/:id/prep-kit/checklist  {itemKey, done}
 *   GET  /api/candidate/interviews/:id/prep-kit.ics     calendar file, no company
 *
 * Recruiter and admin - never a client, never a BDE
 *   GET  /api/interviews/prep-status?ids=a,b            sent / viewed / checklist n of m
 *   GET  /api/interviews/:id/prep-kit                   kit + candidate preview + messages
 *   PUT  /api/interviews/:id/prep-kit                   edit questions / tips / bring list
 *   POST /api/interviews/:id/prep-kit/regenerate        from scratch (edits cleared)
 *   POST /api/interviews/:id/prep-kit/send              send (or re-send) the kit now
 *   PUT  /api/interviews/:id/prep                       venue / link / duration / contact /
 *                                                       instructions / release
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  ENGINE, candidateView, readKitStaff, ensureKit, editKit, sendInterviewMessage, savePrepFields,
  prepFieldsSchema, buildIcs, statusOf,
} from '../interview/kit-service.js';

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

async function myKit(session, id) {
  return withUser(session, async (c) => {
    const row = (await c.query(`select * from candidate_interview_prep_v where interview_id=$1`, [id])).rows[0];
    if (!row) return null;
    const ticks = row.kit_id ? (await c.query(
      `select item_key, done from interview_prep_checklist where kit_id=$1`, [row.kit_id])).rows : [];
    // 0102: tips, bring-list and headings in the candidate's own language.
    const lang = (await c.query(
      `select preferred_language from candidates where id = app_candidate_id()`)).rows[0]?.preferred_language || 'en';
    return { row, ticks, lang };
  });
}

async function staffName(session) {
  try {
    return await withUser(session, async (c) => {
      const t = session.role === 'admin' ? 'admins' : 'recruiters';
      const r = (await c.query(`select name from ${t} where id=$1`, [session.profileId])).rows[0];
      return (r && r.name) || session.email || session.role;
    });
  } catch { return session.role; }
}

export default function interviewPrepRoutes() {
  const r = Router();
  const cand = [requireAuth(), requireRole('candidate')];
  const staff = [requireAuth(), requireRole('recruiter', 'admin')];
  const writer = [requireAuth(), requireRole('recruiter', 'admin')];

  /* ---------------- candidate ---------------- */

  r.get('/candidate/interviews/prep', ...cand, wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select interview_id, kit_id, status, scheduled_date, scheduled_time, viewed_at
         from candidate_interview_prep_v order by scheduled_date nulls last`)).rows);
    res.json({ interviews: rows.map((x) => ({
      interviewId: x.interview_id, kitReady: !!x.kit_id, status: x.status, viewed: !!x.viewed_at,
    })) });
  }));

  r.get('/candidate/interviews/:id/prep-kit', ...cand, wrap(async (req, res) => {
    const k = await myKit(req.session, String(req.params.id).slice(0, 80));
    if (!k) throw notFound('That interview could not be found.');
    res.json({ kit: candidateView(k.row, k.ticks, { lang: k.lang }) });
  }));

  r.post('/candidate/interviews/:id/prep-kit/viewed', ...cand, wrap(async (req, res) => {
    const at = await withUser(req.session, async (c) => (await c.query(
      `select prep_kit_mark_viewed($1) as at`, [String(req.params.id).slice(0, 80)])).rows[0].at);
    res.json({ viewedAt: at });
  }));

  r.put('/candidate/interviews/:id/prep-kit/checklist', ...cand, wrap(async (req, res) => {
    const b = parse(z.object({ itemKey: z.string().trim().min(1).max(40), done: z.boolean() }), req.body);
    const k = await myKit(req.session, String(req.params.id).slice(0, 80));
    if (!k || !k.row.kit_id) throw notFound('That prep kit could not be found.');
    if (!(k.row.bring_list || []).some((x) => x.key === b.itemKey)) throw badRequest('That item is not on the checklist.');
    await withUser(req.session, (c) => c.query(
      `insert into interview_prep_checklist (kit_id, item_key, done, done_at) values ($1,$2,$3, case when $3 then now() end)
       on conflict (kit_id, item_key) do update set done=excluded.done, done_at=excluded.done_at`,
      [k.row.kit_id, b.itemKey, b.done]));
    const again = await myKit(req.session, String(req.params.id).slice(0, 80));
    res.json({ kit: candidateView(again.row, again.ticks, { lang: again.lang }) });
  }));

  r.get('/candidate/interviews/:id/prep-kit.ics', ...cand, wrap(async (req, res) => {
    const k = await myKit(req.session, String(req.params.id).slice(0, 80));
    if (!k) throw notFound('That interview could not be found.');
    const ics = buildIcs(candidateView(k.row, k.ticks));
    if (!ics) throw badRequest('This interview has no date yet.');
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="teamlink-interview.ics"');
    res.send(ics);
  }));

  /* ---------------- recruiter ---------------- */

  r.get('/interviews/prep-status', ...staff, wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
    const out = await withUser(req.session, async (c) => {
      const kits = (await c.query(
        `select k.* from interview_prep_kits k where k.interview_id = any($1)`, [ids])).rows;
      const ticks = kits.length ? (await c.query(
        `select kit_id, item_key, done from interview_prep_checklist where kit_id = any($1)`, [kits.map((k) => k.id)])).rows : [];
      return ids.map((id) => {
        const k = kits.find((x) => x.interview_id === id);
        return { interviewId: id, ...statusOf(k, k ? ticks.filter((t) => t.kit_id === k.id) : []) };
      });
    });
    res.json({ statuses: out });
  }));

  r.get('/interviews/:id/prep-kit', ...staff, wrap(async (req, res) => {
    const out = await readKitStaff(req.session, String(req.params.id).slice(0, 80));
    if (!out) throw notFound('That interview could not be found.');
    res.json(out);
  }));

  const canWrite = async (session, id) => {
    const ok = await withUser(session, async (c) => (await c.query(`select prep_kit_staff_ok($1) as ok`, [id])).rows[0].ok);
    if (!ok) throw notFound('That interview could not be found.');
  };

  r.put('/interviews/:id/prep-kit', ...writer, wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const b = parse(z.object({
      questions: z.array(z.object({ q: z.string().max(300), why: z.string().max(220).optional(), topic: z.string().max(60).optional() })).max(10),
      tips: z.array(z.string().max(220)).max(10),
      bringList: z.array(z.object({ key: z.string().max(40).optional(), text: z.string().max(160) })).max(12).optional(),
    }), req.body);
    await canWrite(req.session, id);
    let out;
    try { out = await editKit(req.session, id, b, await staffName(req.session)); }
    catch (err) { if (err.status === 400) throw badRequest(err.message); throw err; }
    if (!out) throw notFound('That prep kit could not be found.');
    res.json(out);
  }));

  r.post('/interviews/:id/prep-kit/regenerate', ...writer, wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    await canWrite(req.session, id);
    await ensureKit(id, { regenerate: true, by: await staffName(req.session) });
    res.json(await readKitStaff(req.session, id));
  }));

  r.post('/interviews/:id/prep-kit/send', ...writer, wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    await canWrite(req.session, id);
    const iv = await withUser(ENGINE, async (c) => (await c.query(`select status, application_id from interviews where id=$1`, [id])).rows[0]);
    if (!iv) throw notFound('That interview could not be found.');
    if (iv.status === 'Cancelled') throw badRequest('This interview is cancelled.');
    await ensureKit(id);
    const out = await sendInterviewMessage(id, 'kit', { withKit: true });
    res.json({ ok: true, delivery_status: out.delivery_status, ...(await readKitStaff(req.session, id)) });
  }));

  r.put('/interviews/:id/prep', ...writer, wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const b = parse(prepFieldsSchema, req.body);
    await canWrite(req.session, id);
    const before = await withUser(ENGINE, async (c) => (await c.query(`select * from interviews where id=$1`, [id])).rows[0]);
    const after = await savePrepFields(req.session, id, b);
    if (!after) throw forbidden('You cannot change this interview.');
    if (before && (before.location_type || null) !== (after.location_type || null)) await ensureKit(id);
    res.json(await readKitStaff(req.session, id));
  }));

  return r;
}
