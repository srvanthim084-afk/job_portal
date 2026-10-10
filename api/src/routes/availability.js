/**
 * The candidate's availability status (migration 0092).
 *
 *   GET  /api/candidate/availability           the candidate's own status
 *   PUT  /api/candidate/availability           change it (candidate only)
 *   PUT  /api/candidates/:id/availability      the same path a recruiter might
 *                                              try - refused for anybody but
 *                                              the candidate themselves
 *   GET  /api/availability/reply?t=&a=         the link in "Still looking?":
 *                                              a page that asks to confirm,
 *                                              no login
 *   POST /api/availability/reply               the confirmation (single-use)
 *   GET  /api/admin/availability/report        counts per status, checks sent
 *                                              vs answered
 *   POST /api/admin/availability/run           run the re-confirm sweep now
 *   GET  /api/admin/availability/summary       the Admin module's four cards:
 *                                              Total Candidates, Attended
 *                                              Interviews, Moved to ATS, Not Looking
 *   GET  /api/admin/availability/candidates    the list behind a card (search,
 *                                              filters, pages)
 *
 * Recruiters, BDEs and admins read the status on candidate rows (the
 * candidate routes attach it); clients never see it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, forbidden, notFound } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { ANSWERS, tokenSigned, tokenHash, runAvailabilitySweep } from '../notify/availability-checks.js';

export const STATUS_LABEL = {
  actively_looking: 'Actively looking',
  open_to_offers: 'Open to offers',
  not_looking: 'Not looking',
  placed: 'Placed',
  unknown: 'Status unknown',
};
export const JOIN_IN = ['Immediate', '15 days', '30 days', '60 days', '90 days'];

const iso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * The availability fields of a candidate row, for STAFF responses only.
 * Never call this on a response a client or another candidate reads.
 */
export function availabilityOf(row) {
  if (!row || row.availability_status === undefined) return null;
  const status = row.availability_status || 'unknown';
  const notConfirmed = !!row.availability_stale_at && ['actively_looking', 'open_to_offers'].includes(status);
  return {
    status,
    label: notConfirmed ? 'Not confirmed' : STATUS_LABEL[status] || status,
    notConfirmed,
    updatedAt: iso(row.availability_updated_at),
    confirmedAt: iso(row.availability_confirmed_at),
    source: row.availability_source || null,
    placedAt: iso(row.availability_placed_at),
    canJoinIn: row.can_join_in || null,
    preferredRoles: Array.isArray(row.preferred_roles) ? row.preferred_roles : [],
    preferredCities: Array.isArray(row.preferred_cities) ? row.preferred_cities : [],
  };
}

/** The candidate reading their own - the same fields, minus nothing. */
const AV_COLS = `availability_status, availability_updated_at, availability_confirmed_at,
  availability_source, availability_stale_at, availability_placed_at, can_join_in,
  preferred_roles, preferred_cities`;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The reply page. Served by the API, works without a login, and asks the
 * candidate to CONFIRM: a link that changed something the moment it was
 * opened would be "answered" by every mail scanner and chat preview that
 * fetches links on the candidate's behalf.
 */
function replyPage({ title, line, token, answer, done }) {
  const form = token && answer && !done ? `
  <form id="f" method="post" action="/api/availability/reply">
    <input type="hidden" name="t" value="${esc(token)}">
    <input type="hidden" name="a" value="${esc(answer)}">
    <button type="submit" id="go">Confirm: ${esc(ANSWERS[answer] || answer)}</button>
  </form>
  <p class="alt">Not what you meant? ${Object.keys(ANSWERS).filter((k) => k !== answer).map((k) =>
    `<a href="/api/availability/reply?t=${encodeURIComponent(token)}&amp;a=${k}">${esc(ANSWERS[k])}</a>`).join(' · ')}</p>
  <script>
  /* Sent WITHOUT cookies, so a candidate who happens to be signed in on
     this browser is not asked for a CSRF token they cannot have. The
     plain form above still works without JavaScript. */
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var b = document.getElementById('go'); b.disabled = true; b.textContent = 'Saving…';
    fetch('/api/availability/reply', { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ t: ${JSON.stringify(String(token))}, a: ${JSON.stringify(String(answer))} }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        document.getElementById('m').innerHTML = '<h1>' + r.title + '</h1><p>' + r.line + '</p>';
      })
      .catch(function () { b.disabled = false; b.textContent = 'Try again'; });
  });
  </script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · TeamLink</title>
<style>body{margin:0;background:#f4f7fb;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202c}
main{max-width:480px;margin:10vh auto;padding:28px 26px;background:#fff;border:1px solid #e6ebf2;border-radius:14px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#42505f}a{color:#1d6ff2;font-weight:700}
button{background:#1490b3;color:#fff;border:0;border-radius:9px;padding:12px 18px;font:inherit;font-weight:800;cursor:pointer;width:100%}
.alt{font-size:13px;margin-top:14px}</style></head>
<body><main id="m"><h1>${esc(title)}</h1><p>${line}</p>${form}</main></body></html>`;
}

const RESULT = {
  ok: (a) => ['Thank you', `Your status is now <b>${esc(ANSWERS[a])}</b>. You can change it any time from your TeamLink profile.`],
  used: () => ['Already answered', 'This link has already been used. You can change your status any time from your TeamLink profile.'],
  expired: () => ['This link has expired', 'Links in our messages work for 14 days. Sign in to TeamLink to update your status from your profile.'],
  unknown: () => ['That link is not valid', 'It may have been cut short by your messaging app. Sign in to TeamLink to update your status from your profile.'],
  invalid: () => ['That link is not valid', 'Sign in to TeamLink to update your status from your profile.'],
};

export default function availabilityRoutes() {
  const r = Router();

  /* ---- the candidate ------------------------------------------------ */
  r.get('/candidate/availability', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => (await c.query(
      `select ${AV_COLS} from candidates where id = $1`, [req.session.profileId])).rows[0]);
    if (!row) throw notFound('Your profile could not be found.');
    res.json({ availability: availabilityOf(row), options: { statuses: Object.keys(ANSWERS), canJoinIn: JOIN_IN } });
  }));

  const setSchema = z.object({
    status: z.enum(['actively_looking', 'open_to_offers', 'not_looking']).optional(),
    canJoinIn: z.enum(JOIN_IN).optional(),
    preferredRoles: z.array(z.string().trim().max(80)).max(10).optional(),
    preferredCities: z.array(z.string().trim().max(80)).max(10).optional(),
  }).strict();

  async function setOwn(req, res) {
    const p = setSchema.safeParse(req.body || {});
    if (!p.success) {
      const details = {};
      for (const i of p.error.issues) details[i.path.join('.') || 'form'] = i.message;
      throw badRequest('Please choose one of the options shown.', details);
    }
    const b = p.data;
    if (!b.status && !b.canJoinIn && !b.preferredRoles && !b.preferredCities) {
      throw badRequest('Nothing to update.');
    }
    const row = await withUser(req.session, async (c) => {
      await c.query(`select availability_candidate_set($1,$2,$3,$4)`,
        [b.status || null, b.canJoinIn || null, b.preferredRoles || null, b.preferredCities || null]);
      return (await c.query(`select ${AV_COLS}, notice_period from candidates where id = $1`,
        [req.session.profileId])).rows[0];
    });
    res.json({ availability: availabilityOf(row), noticePeriod: row.notice_period || null });
  }

  r.put('/candidate/availability', requireAuth(), requireRole('candidate'), wrap(setOwn));

  /* The obvious path for a recruiter to try. Refused, on the server, for
     anybody but the candidate whose record it is. */
  r.put('/candidates/:id/availability', requireAuth(), wrap(async (req, res) => {
    if (req.session.role !== 'candidate' || req.session.profileId !== req.params.id) {
      throw forbidden('Only the candidate can change their availability. Log a call to record what they told you.');
    }
    return setOwn(req, res);
  }));

  /* ---- the reply link ------------------------------------------------ */
  r.get('/availability/reply', wrap(async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const token = String(req.query.t || '');
    const answer = String(req.query.a || '');
    if (!tokenSigned(token) || !ANSWERS[answer]) {
      const [t, l] = RESULT.invalid();
      return res.status(400).send(replyPage({ title: t, line: l }));
    }
    const peek = await withUser(null, async (c) => (await c.query(
      `select * from availability_reply_peek($1)`, [tokenHash(token)])).rows[0]);
    if (!peek) { const [t, l] = RESULT.unknown(); return res.status(404).send(replyPage({ title: t, line: l })); }
    if (peek.answered) { const [t, l] = RESULT.used(); return res.send(replyPage({ title: t, line: l })); }
    if (peek.expired) { const [t, l] = RESULT.expired(); return res.status(410).send(replyPage({ title: t, line: l })); }
    return res.send(replyPage({
      title: peek.first_name ? `Hi ${peek.first_name}` : 'Your job search',
      line: `Tap below to tell recruiters: <b>${esc(ANSWERS[answer])}</b>.`,
      token, answer,
    }));
  }));

  r.post('/availability/reply', wrap(async (req, res) => {
    const token = String((req.body && (req.body.t || req.body.token)) || '');
    const answer = String((req.body && (req.body.a || req.body.answer)) || '');
    let result = 'invalid';
    if (tokenSigned(token) && ANSWERS[answer]) {
      result = await withUser(null, async (c) => (await c.query(
        `select availability_reply($1,$2) as r`, [tokenHash(token), answer])).rows[0].r);
    }
    const [title, line] = (RESULT[result] || RESULT.invalid)(answer);
    const status = result === 'ok' || result === 'used' ? 200 : result === 'expired' ? 410 : 400;
    if (String(req.get('accept') || '').includes('application/json') || req.is('application/json')) {
      return res.status(status).json({ result, title, line });
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(status).send(replyPage({ title, line, done: true }));
  }));

  /* ---- admin --------------------------------------------------------- */
  r.get('/admin/availability/report', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const report = await withUser(req.session, async (c) => (await c.query(
      `select availability_report($1) as r`, [days])).rows[0].r);
    res.json({ report });
  }));

  r.post('/admin/availability/run', requireAuth(), requireRole('admin'), wrap(async (_req, res) => {
    res.json({ run: await runAvailabilitySweep() });
  }));

  /* ---- admin: the four cards and the lists behind them ---------------- *
   * One candidate is counted once (by candidates.id), whatever number of
   * applications, interviews or moves they have. Sample rows (is_demo) are
   * not evidence of anything.
   *
   *   Attended Interviews  attendance RECORDED - never a scheduled interview:
   *                        an interview marked Completed; an AI interview the
   *                        candidate finished (completed / evaluating / evaluated);
   *                        a walk-in marked Attended or Interviewed (attended_at /
   *                        interviewed_at, set by the walk-in ATS).
   *   Moved to ATS         a RECORDED move into the hiring pipeline: a row in
   *                        application_stage_history (append-only, written by the
   *                        database on every stage change) to a pipeline stage -
   *                        anything past Applied / AI screening / walk-in
   *                        registration, and not Rejected, On hold or No show.
   *                        The date is the first such move.
   *   Not Looking          candidates.availability_status = 'not_looking' (said
   *                        by the candidate; nothing is inferred).
   * ---------------------------------------------------------------------- */
  const NOT_ATS = ['applied', 'ai_screening', 'registered', 'rejected', 'hold', 'no_show'];
  const FACTS = `
    att as (
      select candidate_id, max(at) at,
             (array_agg(kind order by at desc nulls last))[1] kind,
             (array_agg(job_id order by at desc nulls last))[1] job_id
        from (
          select i.candidate_id, coalesce(i.completed_at, i.scheduled_date::timestamptz) at, 'interview' kind, i.job_id
            from interviews i where i.status = 'Completed' and not i.is_demo
          union all
          select ai.candidate_id, ai.completed_at, 'ai', ai.job_id
            from ai_interviews ai where ai.status in ('completed', 'evaluating', 'evaluated')
          union all
          select a.candidate_id, coalesce(a.interviewed_at, a.attended_at, a.updated_at), 'walkin', a.job_id
            from applications a
           where not a.is_demo and (a.attended_at is not null or a.interviewed_at is not null or a.stage in ('attended', 'interviewed'))
        ) x
       group by candidate_id
    ),
    ats as (
      select a.candidate_id, min(h.created_at) at
        from application_stage_history h join applications a on a.id = h.application_id
       where not a.is_demo and h.to_stage <> all($1::text[])
       group by a.candidate_id
    )`;

  r.get('/admin/availability/summary', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => (await c.query(
      `with ${FACTS}
       select (select count(*) from candidates)::int total,
              (select count(*) from att join candidates c on c.id = att.candidate_id)::int attended,
              (select count(*) from ats join candidates c on c.id = ats.candidate_id)::int ats,
              (select count(*) from candidates where availability_status = 'not_looking')::int not_looking`,
      [NOT_ATS])).rows[0]);
    res.json({ summary: { totalCandidates: row.total, attendedInterviews: row.attended, movedToAts: row.ats, notLooking: row.not_looking } });
  }));

  const METRICS = ['total', 'attended', 'ats', 'not_looking'];
  r.get('/admin/availability/candidates', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const metric = METRICS.includes(String(req.query.metric)) ? String(req.query.metric) : 'total';
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 5), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const recruiter = String(req.query.recruiterId || '').trim();
    const avail = String(req.query.availability || '').trim();
    const stage = String(req.query.stage || '').trim();

    const p = [NOT_ATS];
    const where = [];
    if (metric === 'attended') where.push('att.candidate_id is not null');
    if (metric === 'ats') where.push('ats.candidate_id is not null');
    if (metric === 'not_looking') where.push(`c.availability_status = 'not_looking'`);
    if (q) {
      p.push(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      const n = p.length;
      where.push(`(c.name ilike $${n} or c.email ilike $${n} or c.phone ilike $${n} or c.candidate_code ilike $${n}
                   or coalesce(la.job_title, '') ilike $${n} or coalesce(c.preferred_role, c.title, '') ilike $${n})`);
    }
    if (recruiter === 'none') where.push('coalesce(c.owner_recruiter_id, la.recruiter_id) is null');
    else if (recruiter) { p.push(recruiter); where.push(`coalesce(c.owner_recruiter_id, la.recruiter_id) = $${p.length}`); }
    if (avail && STATUS_LABEL[avail]) { p.push(avail); where.push(`c.availability_status = $${p.length}`); }
    if (stage) { p.push(stage); where.push(`la.stage = $${p.length}`); }
    const order = metric === 'attended' ? 'att.at desc nulls last, c.id'
      : metric === 'ats' ? 'ats.at desc nulls last, c.id'
      : metric === 'not_looking' ? 'c.availability_updated_at desc nulls last, c.id'
      : 'c.created_at desc nulls last, c.id';

    const out = await withUser(req.session, async (c) => {
      const base = `with ${FACTS},
        la as (
          select distinct on (a.candidate_id) a.candidate_id, a.id application_id, a.stage, coalesce(a.recruiter_id, j.recruiter_id) recruiter_id, a.applied_at, j.title job_title
            from applications a join jobs j on j.id = a.job_id
           where not a.is_demo
           order by a.candidate_id, a.updated_at desc nulls last, a.id
        ),
        iv as (
          select distinct on (i.candidate_id) i.candidate_id, i.status, i.scheduled_date, i.type
            from interviews i where not i.is_demo
           order by i.candidate_id, i.scheduled_date desc nulls last, i.created_at desc
        )
        select c.id, c.candidate_code, c.name, c.email, c.phone, c.preferred_role, c.title, c.created_at,
               c.availability_status, c.availability_stale_at, c.availability_updated_at,
               coalesce(c.owner_recruiter_id, la.recruiter_id) recruiter_id, r.name recruiter_name,
               la.job_title, la.stage, s.label stage_label, la.applied_at,
               att.at attended_at, att.kind attended_kind, aj.title attended_job,
               iv.status iv_status, iv.scheduled_date iv_date, iv.type iv_type,
               ats.at ats_at, count(*) over() n
          from candidates c
          left join la on la.candidate_id = c.id
          left join att on att.candidate_id = c.id
          left join jobs aj on aj.id = att.job_id
          left join ats on ats.candidate_id = c.id
          left join iv on iv.candidate_id = c.id
          left join recruiters r on r.id = coalesce(c.owner_recruiter_id, la.recruiter_id)
          left join stages s on s.id = la.stage
         ${where.length ? 'where ' + where.join(' and ') : ''}
         order by ${order}
         limit ${pageSize} offset ${(page - 1) * pageSize}`;
      const rows = (await c.query(base, p)).rows;
      const recruiters = (await c.query(`select id, name from recruiters order by name`)).rows;
      const stages = (await c.query(
        `select distinct a.stage id, coalesce(s.label, a.stage) label from applications a left join stages s on s.id = a.stage
          where not a.is_demo order by 2`)).rows;
      return { rows, recruiters, stages };
    });

    const KIND = { interview: 'Interview completed', ai: 'AI interview completed', walkin: 'Walk-in attended' };
    const total = out.rows.length ? Number(out.rows[0].n) : 0;
    res.json({
      metric, page, pageSize, total,
      rows: out.rows.map((x) => {
        const notConfirmed = !!x.availability_stale_at && ['actively_looking', 'open_to_offers'].includes(x.availability_status);
        return {
          id: x.id,
          candidateCode: x.candidate_code || null,
          name: x.name,
          email: x.email || null,
          phone: x.phone || null,
          job: x.job_title || null,
          preferredRole: x.preferred_role || x.title || null,
          recruiterId: x.recruiter_id || null,
          recruiterName: x.recruiter_name || null,
          interview: x.attended_at
            ? { status: KIND[x.attended_kind] || 'Attended', date: iso(x.attended_at), job: x.attended_job || null, attended: true }
            : x.iv_status ? { status: x.iv_status, date: x.iv_date ? new Date(x.iv_date).toISOString().slice(0, 10) : null, attended: false } : null,
          ats: x.ats_at ? { status: x.stage_label || x.stage || null, movedAt: iso(x.ats_at) } : null,
          stage: x.stage || null,
          stageLabel: x.stage_label || x.stage || null,
          availability: {
            status: x.availability_status || 'unknown',
            label: notConfirmed ? 'Not confirmed' : STATUS_LABEL[x.availability_status] || 'Status unknown',
            updatedAt: iso(x.availability_updated_at),
          },
          registeredAt: iso(x.created_at),
        };
      }),
      filters: {
        recruiters: out.recruiters.map((x) => ({ id: x.id, name: x.name })),
        stages: out.stages.map((x) => ({ id: x.id, label: x.label })),
        availability: Object.keys(STATUS_LABEL).map((k) => ({ id: k, label: STATUS_LABEL[k] })),
      },
    });
  }));

  return r;
}
