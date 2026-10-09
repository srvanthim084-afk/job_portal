/**
 * Admin -> Audit Log: what RECRUITERS did, and how long they were in the
 * portal (0125).
 *
 *   GET /api/admin/recruiter-activity          rows, filters, summary cards
 *   GET /api/admin/recruiter-activity/export   the filtered rows as CSV
 *
 * RECRUITERS ONLY, IN THE QUERY. Every row is joined to the acting user
 * and kept only when users.role = 'recruiter': an administrator,
 * candidate, client, BDE or the system never reaches the response, whatever
 * the page asks for. The role is the account's role, not the role a row
 * claims for itself.
 *
 * Sessions: sign-in, sign-out and the 30-minute idle sign-out are rows of
 * the same log ('auth.*', entity 'session'), joined to portal_sessions for
 * the times. Idle sessions are closed (portal_session_sweep) before
 * anything is read, so "Active now" is never a browser closed an hour ago.
 *
 * The action codes and their labels are api/src/audit/recruiter-activity.js.
 */
import { Router } from 'express';
import { withUser } from '../db.js';
import { requireAuth, requireRole, sweepIdleSessions } from '../auth.js';
import { wrap } from '../errors.js';
import { ACTIONS } from './ats-record.js';
import {
  ACTIVITY, IDLE_MINUTES, MODULES, LOGIN_CODES, LOGOUT_CODES, formatDuration,
} from '../audit/recruiter-activity.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IST = 'Asia/Kolkata';

const label = (code) => (ACTIVITY.find((a) => a.code === code) || {}).label || ACTIONS[code] || code;

/* Recruiters' rows only, with the code the page filters on: a stage move
   to Shortlisted is its own action, "Candidate shortlisted". */
const EVENTS = `
  select e.id, e.at, e.actor_user_id, e.action, e.entity, e.entity_id, e.detail,
         case when e.action = 'status.changed' and e.detail->>'to' = 'shortlisted'
              then 'candidate.shortlisted' else e.action end as code
    from admin_audit_events e
    join users u on u.id = e.actor_user_id
   where u.role = 'recruiter'`;

function filters(q) {
  const where = []; const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\$/g, `$${vals.length}`)); };
  const who = String(q.recruiter || '').trim();
  if (UUID.test(who)) add('ev.actor_user_id = $$::uuid', who);
  const action = String(q.action || '').trim().slice(0, 60);
  if (action) add('ev.code = $$', action);
  /* India dates, both ends inclusive. */
  const from = DAY.test(String(q.from || '')) ? String(q.from) : '';
  const to = DAY.test(String(q.to || '')) ? String(q.to) : '';
  if (from) add(`ev.at >= ($$::date::timestamp at time zone '${IST}')`, from);
  if (to) add(`ev.at < (($$::date + 1)::timestamp at time zone '${IST}')`, to);
  return { w: where.length ? 'where ' + where.join(' and ') : '', vals };
}

const SELECT = (w) => `
  with ev as (${EVENTS})
  select ev.*, ps.login_at, ps.logout_at, ps.last_activity_at, ps.end_reason, ps.login_method,
         host(ps.ip) as ip, ps.user_agent
    from ev
    left join portal_sessions ps on ev.entity = 'session' and ps.id::text = ev.entity_id
    ${w}`;

/* Names for whoever and whatever the rows mention. */
async function namesFor(c, rows) {
  const ids = (kind) => [...new Set(rows.filter((r) => r.entity === kind).map((r) => r.entity_id))].slice(0, 500);
  const names = {};
  const grab = async (kind, sql, list) => {
    if (!list.length) return;
    for (const r of (await c.query(sql, [list])).rows) names[`${kind}:${r.id}`] = r.name;
  };
  await grab('job', `select id, title as name from jobs where id = any($1)`, ids('job'));
  await grab('candidate', `select id, name from candidates where id = any($1)`, ids('candidate'));
  await grab('application', `select a.id::text as id, c.name || ' · ' || j.title as name
                               from applications a join candidates c on c.id = a.candidate_id
                               join jobs j on j.id = a.job_id where a.id::text = any($1)`, ids('application'));
  await grab('interview', `select i.id::text as id, c.name as name from interviews i
                             join candidates c on c.id = i.candidate_id where i.id::text = any($1)`, ids('interview'));
  return names;
}

async function recruiterList(c) {
  return (await c.query(
    `select r.user_id, r.name, u.email from recruiters r join users u on u.id = r.user_id
      where u.role = 'recruiter' order by r.name`)).rows
    .map((r) => ({ userId: r.user_id, name: r.name, email: r.email }));
}

function sessionOf(x, nowMs) {
  if (x.entity !== 'session' || !x.login_at) return null;
  const login = new Date(x.login_at).getTime();
  const last = x.last_activity_at ? new Date(x.last_activity_at).getTime() : login;
  const idleMs = IDLE_MINUTES * 60_000;
  const open = !x.logout_at;
  const active = open && nowMs - last <= idleMs;
  /* Closed sessions end at logout; an open one not yet swept ended at its
     last activity; an active one is still running. */
  const end = x.logout_at ? new Date(x.logout_at).getTime() : (active ? nowMs : last);
  return {
    id: x.entity_id, loginAt: iso(x.login_at), logoutAt: iso(x.logout_at),
    lastActivityAt: iso(x.last_activity_at), endReason: x.end_reason || (open && !active ? 'auto_timeout' : null),
    method: x.login_method || null, ip: x.ip || null, userAgent: x.user_agent || null,
    active, durationSeconds: Math.max(0, Math.round((end - login) / 1000)),
  };
}

/** Time in portal per recruiter, today and this week (India time),
    overlapping sessions merged so two browsers do not count twice. */
async function summary(c, recruiters, nowMs) {
  const b = (await c.query(
    `select (date_trunc('day', now() at time zone '${IST}') at time zone '${IST}') as day0,
            (date_trunc('week', now() at time zone '${IST}') at time zone '${IST}') as week0`)).rows[0];
  const day0 = new Date(b.day0).getTime();
  const week0 = new Date(b.week0).getTime();
  const rows = (await c.query(
    `select ps.user_id, ps.login_at, ps.logout_at, ps.last_activity_at
       from portal_sessions ps join users u on u.id = ps.user_id and u.role = 'recruiter'
      where coalesce(ps.logout_at, now()) >= $1
      order by ps.user_id, ps.login_at`, [new Date(week0)])).rows;

  const idleMs = IDLE_MINUTES * 60_000;
  const per = new Map();
  for (const r of rows) {
    const login = new Date(r.login_at).getTime();
    const last = new Date(r.last_activity_at).getTime();
    const active = !r.logout_at && nowMs - last <= idleMs;
    const end = r.logout_at ? new Date(r.logout_at).getTime() : (active ? nowMs : last);
    const p = per.get(r.user_id) || { spans: [], active: false, activeSince: null };
    p.spans.push([login, end]);
    if (active) { p.active = true; p.activeSince = p.activeSince ? Math.min(p.activeSince, login) : login; }
    per.set(r.user_id, p);
  }
  const within = (spans, from) => {
    let total = 0; let curA = null; let curB = null;
    for (const [a0, b0] of spans.slice().sort((x, y) => x[0] - y[0])) {
      const a = Math.max(a0, from); const bb = b0;
      if (bb <= a) continue;
      if (curB == null || a > curB) { if (curB != null) total += curB - curA; curA = a; curB = bb; }
      else if (bb > curB) curB = bb;
    }
    if (curB != null) total += curB - curA;
    return Math.round(total / 1000);
  };
  const byName = new Map(recruiters.map((r) => [r.userId, r.name]));
  const list = [...per.entries()].map(([userId, p]) => ({
    userId, name: byName.get(userId) || null,
    todaySeconds: within(p.spans, day0), weekSeconds: within(p.spans, week0),
    active: p.active, activeSince: p.activeSince ? new Date(p.activeSince).toISOString() : null,
  })).filter((x) => x.todaySeconds || x.weekSeconds || x.active)
    .sort((x, y) => y.todaySeconds - x.todaySeconds || y.weekSeconds - x.weekSeconds);
  const sum = (k) => list.reduce((s, x) => s + x[k], 0);
  return {
    activeNow: list.filter((x) => x.active).length,
    today: { totalSeconds: sum('todaySeconds'), recruiters: list.filter((x) => x.todaySeconds || x.active).length, since: new Date(day0).toISOString() },
    week: { totalSeconds: sum('weekSeconds'), recruiters: list.filter((x) => x.weekSeconds || x.active).length, since: new Date(week0).toISOString() },
    byRecruiter: list,
  };
}

function shape(x, names, recNames, nowMs) {
  const session = sessionOf(x, nowMs);
  const isLogin = LOGIN_CODES.includes(x.code) || /^auth\.login/.test(x.code);
  const isLogout = LOGOUT_CODES.includes(x.code);
  /* Time in Portal: on the Logout row; "Active now" on the Login row of a
     session still running. */
  let timeInPortal = null;
  if (session && isLogout) {
    timeInPortal = { seconds: Number(x.detail && x.detail.durationSeconds) || session.durationSeconds, active: false };
  } else if (session && isLogin && session.active) {
    timeInPortal = { seconds: session.durationSeconds, active: true, since: session.loginAt };
  }
  const targetName = x.entity === 'session' ? null
    : (names[`${x.entity}:${x.entity_id}`] || (x.detail && x.detail.title) || null);
  return {
    id: x.id, at: iso(x.at), code: x.code, action: label(x.code),
    recruiter: { userId: x.actor_user_id, name: recNames.get(x.actor_user_id) || null },
    module: MODULES[x.entity] || x.entity,
    target: x.entity === 'session' ? null : { kind: x.entity, id: x.entity_id, name: targetName },
    timeInPortal: timeInPortal && { ...timeInPortal, label: timeInPortal.active ? 'Active now' : formatDuration(timeInPortal.seconds) },
    session,
    detail: x.detail || {},
  };
}

const pageOf = (q) => ({
  pageSize: Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100),
  page: Math.max(parseInt(q.page, 10) || 1, 1),
});

const csvCell = (v) => {
  const t = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
};

export default function recruiterActivityRoutes() {
  const r = Router();

  r.get('/admin/recruiter-activity', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    await sweepIdleSessions();
    const { page, pageSize } = pageOf(req.query);
    const { w, vals } = filters(req.query);
    const nowMs = Date.now();
    const out = await withUser(req.session, async (c) => {
      const total = (await c.query(`with ev as (${EVENTS}) select count(*)::int n from ev ${w}`, vals)).rows[0].n;
      const rows = (await c.query(`${SELECT(w)} order by ev.at desc, ev.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}`, vals)).rows;
      const recruiters = await recruiterList(c);
      return { total, rows, recruiters, names: await namesFor(c, rows), summary: await summary(c, recruiters, nowMs) };
    });
    const recNames = new Map(out.recruiters.map((x) => [x.userId, x.name]));
    res.json({
      total: out.total, page, pageSize, now: new Date(nowMs).toISOString(), idleMinutes: IDLE_MINUTES,
      actions: ACTIVITY.map(({ code, label: l, group }) => ({ code, label: l, group })),
      recruiters: out.recruiters,
      summary: out.summary,
      rows: out.rows.map((x) => shape(x, out.names, recNames, nowMs)),
    });
  }));

  r.get('/admin/recruiter-activity/export', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    await sweepIdleSessions();
    const { w, vals } = filters(req.query);
    const nowMs = Date.now();
    const out = await withUser(req.session, async (c) => {
      const rows = (await c.query(`${SELECT(w)} order by ev.at desc, ev.id desc limit 5000`, vals)).rows;
      await c.query(`select audit_write('AUDIT_LOG_EXPORTED', 'setting', 'recruiter_activity', $1::jsonb)`,
        [JSON.stringify({ rows: rows.length, filters: Object.fromEntries(['recruiter', 'action', 'from', 'to']
          .filter((k) => req.query[k]).map((k) => [k, String(req.query[k]).slice(0, 80)])) })]);
      return { rows, recruiters: await recruiterList(c), names: await namesFor(c, rows) };
    });
    const recNames = new Map(out.recruiters.map((x) => [x.userId, x.name]));
    const head = ['Date and Time (IST)', 'Recruiter', 'Action', 'Job / Module', 'Time in Portal', 'IP', 'Device'];
    const when = (d) => new Date(d).toLocaleString('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
    const lines = [head.join(',')].concat(out.rows.map((x) => {
      const s = shape(x, out.names, recNames, nowMs);
      return [when(s.at), s.recruiter.name || '', s.action,
        s.target ? `${s.module}: ${s.target.name || s.target.id}` : s.module,
        s.timeInPortal ? s.timeInPortal.label : '', s.session ? s.session.ip : '', s.session ? s.session.userAgent : '',
      ].map(csvCell).join(',');
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="recruiter-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  }));

  return r;
}
