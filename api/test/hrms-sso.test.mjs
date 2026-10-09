/**
 * 0127: single sign-on from TeamLink HRMS, end to end against a real
 * Postgres with RLS on, and a stand-in HRMS back channel on a local port.
 *
 * The token contract (docs/HRMS-SSO.md): HS256 with HRMS_SSO_SECRET, 60 s,
 * single use, iss/aud checked; the role map; account match by email; the
 * session it opens; "Login (via HRMS)" once per HRMS session; the shared
 * inactivity timeout and logout in both directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5527;
const API_PORT = 9927;
const HRMS_PORT = 9928;
const SECRET = 'test-only-hrms-sso-secret-0123456789abcdefghijklmnop';
const EXPIRED = 'Session expired. Please open the Job Portal from HRMS again.';

let dbh, server, base, raw, sso, hrms;
const hrmsState = new Map();            // sid -> { active, lastSeenAt }
const hrmsCalls = [];
let hrmsMode = 'ok';                    // 'ok' | 'error'

function launchToken(over = {}, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'teamlink-hrms', aud: 'teamlink-job-portal', iat, exp: iat + 60, jti: randomUUID(),
    sub: 'hrms-user-1', email: 'sso.rec@tl-sink.local', name: 'Sso Recruiter', role: 'RECRUITER', sid: 'sid-A',
    ...over,
  };
  if (header.alg !== 'HS256') {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b(header)}.${b(claims)}.x`;
  }
  return sso.signHs256(claims, secret);
}
function backchannel(claims, aud = 'teamlink-job-portal-backchannel') {
  const iat = Math.floor(Date.now() / 1000);
  return sso.signHs256({ iss: 'teamlink-hrms', aud, iat, exp: iat + 60, jti: randomUUID(), ...claims }, SECRET);
}
async function account(role, email, id) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, await hashPassword('Staff123pass'), role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id,name,email,company_id,user_id) values ($1,$2,$3,'co_sso',$4)`, [id, 'Rec ' + id, email, u]);
  if (role === 'admin') await raw(`insert into admins (id,name,email,user_id) values ($1,'Admin',$2,$3)`, [id, email, u]);
  return u;
}
async function browser() {
  const c = makeClient(base);
  await c.get('/api/health');
  return c;
}
const auditCount = async (userId) => (await raw(
  `select count(*)::int n from audit_log where action='auth.login_hrms' and actor_user_id=$1`, [userId])).rows[0].n;
const sessionsOf = async (sid) => (await raw(`select count(*)::int n from sessions where hrms_sid=$1`, [sid])).rows[0].n;

let recUser, adminUser;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`, DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '', AI_API_KEY: '',
    OUTBOUND_ALLOWLIST: '', AVAILABILITY_RECONFIRM_MESSAGES: 'false',
    HRMS_SSO_SECRET: SECRET, HRMS_URL: 'http://hrms.test', HRMS_API_URL: `http://127.0.0.1:${HRMS_PORT}`,
    HRMS_SSO_CHECK_SECONDS: '60', HRMS_SSO_IDLE_MINUTES: '30',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  sso = await import('../src/sso/hrms.js');

  // The stand-in HRMS: the two back-channel endpoints the portal calls.
  hrms = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (hrmsMode === 'error') return send(500, { error: 'down' });
      let claims;
      try {
        claims = sso.verifyHs256(JSON.parse(body).token, SECRET, { aud: 'teamlink-hrms-backchannel', iss: 'teamlink-job-portal' });
      } catch { return send(401, { error: 'bad token' }); }
      hrmsCalls.push({ path: req.url, ...claims });
      const st = hrmsState.get(claims.sid);
      if (req.url === '/api/sso/job-portal/logout') {
        if (st) st.active = false;
        return send(200, { ok: true });
      }
      if (!st || !st.active) return send(200, { active: false });
      const claimed = claims.lastActiveAt ? Date.parse(claims.lastActiveAt) : 0;
      st.lastSeenAt = Math.max(st.lastSeenAt, claimed);
      return send(200, { active: true, lastSeenAt: new Date(st.lastSeenAt).toISOString() });
    });
  });
  await new Promise((r) => hrms.listen(HRMS_PORT, '127.0.0.1', r));

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  await raw(`insert into companies (id,name) values ('co_sso','SSO Staffing')`);
  recUser = await account('recruiter', 'sso.rec@tl-sink.local', 'rsso1');
  adminUser = await account('admin', 'sso.admin@tl-sink.local', 'asso1');
  await raw(`insert into users (email,password_hash,role) values ('sso.cand@tl-sink.local','x','candidate')`);
  await account('recruiter', 'sso.off@tl-sink.local', 'rsso2');
  await raw(`update users set status='suspended' where email='sso.off@tl-sink.local'`);
  hrmsState.set('sid-A', { active: true, lastSeenAt: Date.now() });
});

test('token rules: HS256 only, iss/aud, at most 60 s, not expired', () => {
  const cfg = sso.ssoConfig();
  assert.equal(cfg.enabled, true);
  const ok = sso.verifyLaunchToken(launchToken(), cfg);
  assert.equal(ok.hrmsRole, 'RECRUITER');
  assert.equal(ok.email, 'sso.rec@tl-sink.local');
  const code = (fn) => { try { fn(); return 'accepted'; } catch (e) { return e.code; } };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({ iat: now - 120, exp: now - 60 }), cfg)), 'TOKEN_EXPIRED');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({ exp: now + 3600 }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({}, { secret: 'another-secret-another-secret-another!!' }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({}, { header: { alg: 'none' } }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({ aud: 'someone-else' }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({ iss: 'someone-else' }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken(launchToken({ sid: '' }), cfg)), 'TOKEN_INVALID');
  assert.equal(code(() => sso.verifyLaunchToken('not.a.token', cfg)), 'TOKEN_INVALID');
});

test('next: only a page of the role, otherwise home', async () => {
  const { safeNext } = await import('../src/routes/hrms-sso.js');
  assert.equal(safeNext('#/recruiter/jobs', 'recruiter'), '#/recruiter/jobs');
  assert.equal(safeNext('#/admin/users', 'recruiter'), '#/recruiter/home');
  assert.equal(safeNext('javascript:alert(1)', 'recruiter'), '#/recruiter/home');
  assert.equal(safeNext('//evil.example/#/recruiter', 'admin'), '#/admin/users');
  assert.equal(safeNext('#/admin/audit-log', 'admin'), '#/admin/audit-log');
});

let rec;
test('a valid token opens a recruiter session; the token cannot be used twice', async () => {
  rec = await browser();
  const st0 = await rec.get('/api/auth/hrms-sso/status');
  assert.deepEqual([st0.body.enabled, st0.body.viaHrms, st0.body.hrmsUrl, st0.body.idleMinutes], [true, false, 'http://hrms.test', 30]);

  const tok = launchToken();
  const r = await rec.post('/api/auth/hrms-sso', { token: tok, next: '#/recruiter/jobs' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.role, r.body.next], ['recruiter', '#/recruiter/jobs']);
  assert.ok(rec.jar.get('tl_session'), 'session cookie set');
  assert.ok(!JSON.stringify(r.body).includes(tok), 'the token is never echoed');

  const me = await rec.get('/api/auth/me');
  assert.equal(me.body.session.role, 'recruiter');
  assert.equal((await rec.get('/api/auth/hrms-sso/status')).body.viaHrms, true);
  assert.equal(await auditCount(recUser), 1, 'Login (via HRMS) written once');

  const replay = await (await browser()).post('/api/auth/hrms-sso', { token: tok });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'SSO_TOKEN_INVALID');
  assert.equal(replay.body.error.message, EXPIRED);
});

test('moving between HRMS and the portal in one HRMS session: no duplicate login row', async () => {
  const again = await rec.post('/api/auth/hrms-sso', { token: launchToken() });
  assert.equal(again.status, 200);
  assert.equal(again.body.reused, true, 'the open session is kept');
  const other = await browser();                       // a second browser, same HRMS session
  assert.equal((await other.post('/api/auth/hrms-sso', { token: launchToken() })).status, 200);
  assert.equal(await auditCount(recUser), 1, 'still one Login (via HRMS)');
  assert.equal(await sessionsOf('sid-A'), 2);

  hrmsState.set('sid-B', { active: true, lastSeenAt: Date.now() });
  const nextDay = await browser();                     // a NEW HRMS session is a new login
  assert.equal((await nextDay.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-B' }) })).status, 200);
  assert.equal(await auditCount(recUser), 2);
});

test('expired and invalid tokens: the "Session expired" answer', async () => {
  const now = Math.floor(Date.now() / 1000);
  const c = await browser();
  const old = await c.post('/api/auth/hrms-sso', { token: launchToken({ iat: now - 200, exp: now - 140 }) });
  assert.equal(old.status, 401);
  assert.deepEqual([old.body.error.code, old.body.error.message], ['SSO_TOKEN_EXPIRED', EXPIRED]);
  const forged = await c.post('/api/auth/hrms-sso', { token: launchToken({}, { secret: 'x'.repeat(40) }) });
  assert.deepEqual([forged.status, forged.body.error.message], [401, EXPIRED]);
  const none = await c.post('/api/auth/hrms-sso', {});
  assert.equal(none.status, 401);
  assert.equal((await c.get('/api/auth/me')).body.session, null);
});

test('role and account rules: Access denied', async () => {
  const c = await browser();
  const deny = async (over) => {
    const r = await c.post('/api/auth/hrms-sso', { token: launchToken(over) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'SSO_ACCESS_DENIED');
    return r.body.error.message;
  };
  assert.match(await deny({ role: 'EMPLOYEE' }), /role does not include/);
  assert.match(await deny({ role: 'ACCOUNTANT' }), /role does not include/);
  assert.match(await deny({ email: 'nobody@tl-sink.local' }), /no Job Portal account/);
  assert.match(await deny({ email: 'sso.cand@tl-sink.local' }), /not a recruiter account/);
  assert.match(await deny({ email: 'sso.admin@tl-sink.local' }), /not a recruiter account/, 'HRMS recruiter cannot open a portal admin');
  assert.match(await deny({ email: 'sso.off@tl-sink.local' }), /not active/);
  assert.equal((await c.get('/api/auth/me')).body.session, null);
});

let adm;
test('HRMS admin -> portal admin; the audit log shows "Login (via HRMS)"; a recruiter stays a recruiter', async () => {
  hrmsState.set('sid-ADM', { active: true, lastSeenAt: Date.now() });
  adm = await browser();
  const r = await adm.post('/api/auth/hrms-sso', {
    token: launchToken({ email: 'SSO.Admin@tl-sink.local', role: 'ADMIN', sid: 'sid-ADM' }), next: '#/admin/audit-log',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.role, r.body.next], ['admin', '#/admin/audit-log']);
  const log = await adm.get('/api/admin/audit-log?action=auth.login_hrms');
  assert.equal(log.status, 200, JSON.stringify(log.body));
  const row = log.body.rows.find((x) => x.user === 'sso.rec@tl-sink.local');
  assert.ok(row, 'the recruiter login is listed');
  assert.equal(row.actionLabel, 'Login (via HRMS)');
  assert.ok(row.at, 'with its date and time');
  assert.ok(log.body.actions.some((a) => a.id === 'auth.login_hrms' && a.label === 'Login (via HRMS)'));

  assert.equal((await rec.get('/api/admin/audit-log')).status, 403, 'the recruiter session is a recruiter session');
});

test('HRMS logs out -> every portal session of that HRMS session ends', async () => {
  const c = await browser();
  const bad = await c.post('/api/auth/hrms-sso/logout', { token: backchannel({ sid: 'sid-A' }, 'teamlink-job-portal') });
  assert.equal(bad.status, 401, 'a launch-audience token is not a logout');
  assert.equal(await sessionsOf('sid-A'), 2);

  const r = await c.post('/api/auth/hrms-sso/logout', { token: backchannel({ sid: 'sid-A' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ended, 2);
  assert.equal((await rec.get('/api/auth/me')).body.session, null);
  assert.equal((await rec.get('/api/candidates')).status, 401);
});

test('shared inactivity: HRMS says the session ended -> the portal session ends', async () => {
  hrmsState.set('sid-C', { active: true, lastSeenAt: Date.now() });
  const c = await browser();
  assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-C' }) })).status, 200);
  hrmsState.get('sid-C').active = false;              // HRMS timed out / logged out
  await raw(`update sessions set hrms_checked_at = now() - interval '2 minutes' where hrms_sid='sid-C'`);
  const st = await c.get('/api/auth/hrms-sso/status');
  assert.deepEqual([st.body.viaHrms, st.body.ended], [false, true]);
  assert.equal(await sessionsOf('sid-C'), 0);
});

test('shared inactivity: idle here but busy in HRMS -> still signed in; HRMS down + idle -> signed out', async () => {
  hrmsState.set('sid-D', { active: true, lastSeenAt: Date.now() });
  const c = await browser();
  assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-D' }) })).status, 200);
  await raw(`update sessions set hrms_active_at = now() - interval '31 minutes', hrms_checked_at = now() - interval '31 minutes' where hrms_sid='sid-D'`);
  const before = hrmsCalls.length;
  const st = await c.get('/api/auth/hrms-sso/status');
  assert.equal(st.body.viaHrms, true, 'HRMS saw activity, so the shared session lives');
  assert.ok(hrmsCalls.length > before, 'HRMS was asked');
  const seen = (await raw(`select extract(epoch from now() - hrms_active_at)::int s from sessions where hrms_sid='sid-D'`)).rows[0].s;
  assert.ok(seen < 60, `hrms_active_at moved to HRMS's activity (${seen}s ago)`);

  hrmsMode = 'error';
  try {
    await raw(`update sessions set hrms_active_at = now() - interval '31 minutes', hrms_checked_at = now() - interval '31 minutes' where hrms_sid='sid-D'`);
    const gone = await c.get('/api/auth/hrms-sso/status');
    assert.deepEqual([gone.body.viaHrms, gone.body.ended], [false, true]);
  } finally { hrmsMode = 'ok'; }
});

test('polling is not activity: x-tl-idle-ms', async () => {
  hrmsState.set('sid-E', { active: true, lastSeenAt: Date.now() });
  const c = await browser();
  assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-E' }) })).status, 200);
  await raw(`update sessions set hrms_active_at = now() - interval '10 minutes' where hrms_sid='sid-E'`);
  const ago = async () => (await raw(`select extract(epoch from now() - hrms_active_at)::int s from sessions where hrms_sid='sid-E'`)).rows[0].s;
  await c.get('/api/auth/hrms-sso/status', { headers: { 'x-tl-idle-ms': String(20 * 60_000) } });
  assert.ok(await ago() >= 595, 'a poll from an idle page does not move it');
  await c.get('/api/auth/hrms-sso/status', { headers: { 'x-tl-idle-ms': '0' } });
  assert.ok(await ago() < 5, 'a click does');
});

test('logging out of the portal logs HRMS out too', async () => {
  hrmsState.set('sid-F', { active: true, lastSeenAt: Date.now() });
  const c = await browser();
  assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-F' }) })).status, 200);
  const r = await c.post('/api/auth/logout', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(hrmsCalls.some((x) => x.path === '/api/sso/job-portal/logout' && x.sid === 'sid-F'), 'HRMS was told');
  assert.equal(hrmsState.get('sid-F').active, false);
  assert.equal((await c.get('/api/auth/me')).body.session, null);
});

test('an admin-made login with a temporary password is not asked to change it when opened from HRMS', async () => {
  await raw(`update users set must_change_password = true where id = $1`, [recUser]);
  try {
    hrmsState.set('sid-G', { active: true, lastSeenAt: Date.now() });
    const c = await browser();
    assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-G' }) })).status, 200);
    assert.equal((await c.get('/api/auth/me')).body.session.mustChangePassword, false);
    assert.equal((await c.get('/api/bootstrap')).body.session.mustChangePassword, false);
    const pw = await browser();
    await pw.post('/api/auth/login', { email: 'sso.rec@tl-sink.local', password: 'Staff123pass', role: 'recruiter' });
    assert.equal((await pw.get('/api/auth/me')).body.session.mustChangePassword, true, 'a password sign-in still is');
  } finally {
    await raw(`update users set must_change_password = false where id = $1`, [recUser]);
  }
});

test('with 0125 recruiter session tracking present: one login row, portal session opened and closed', async () => {
  // 0125 (recruiter time in portal) lives on another branch. When it is in
  // this database, its real portal_sessions are checked; otherwise stand-ins
  // with the same signatures record what they were asked.
  const real = (await raw(`select to_regprocedure('portal_session_touch(text,integer)') is not null as r`)).rows[0].r;
  if (!real) {
    await raw(`alter table sessions add column if not exists portal_session_id bigint`);
    await raw(`create table if not exists zz_ps_calls (id bigserial primary key, fn text, method text, action text, reason text, at timestamptz)`);
    await raw(`create or replace function portal_session_start(p_token_hash text, p_method text, p_action text)
      returns bigint language plpgsql security definer set search_path = public as $$
      declare v_id bigint; v_user uuid;
      begin
        insert into zz_ps_calls (fn, method, action) values ('start', p_method, p_action) returning id into v_id;
        update sessions set portal_session_id = v_id where token_hash = p_token_hash returning user_id into v_user;
        insert into audit_log (actor_user_id, actor_role, action, entity, entity_id, detail)
        values (v_user, 'recruiter', p_action, 'session', v_id::text, jsonb_build_object('method', p_method));
        return v_id;
      end $$`);
    await raw(`create or replace function portal_session_close(p_id bigint, p_reason text, p_at timestamptz)
      returns void language sql security definer set search_path = public as $$
        insert into zz_ps_calls (fn, reason, at) values ('close', p_reason, p_at) $$`);
    await raw(`do $$ begin if exists (select 1 from pg_roles where rolname='app_api') then
      grant execute on function portal_session_start(text,text,text) to app_api; end if; end $$`);
  }
  const opened = async (sid) => (real
    ? (await raw(`select ps.login_method method, l.action from sessions s join portal_sessions ps on ps.id = s.portal_session_id
                   left join audit_log l on l.entity = 'session' and l.entity_id = ps.id::text and l.action like 'auth.login%'
                   where s.hrms_sid = $1`, [sid])).rows
    : (await raw(`select method, action from zz_ps_calls where fn='start' order by id desc limit 1`)).rows);
  const closes = async () => (real
    ? (await raw(`select end_reason reason, logout_at at from portal_sessions where login_method='hrms' and logout_at is not null order by id`)).rows
    : (await raw(`select reason, at from zz_ps_calls where fn='close' order by id`)).rows);
  try {
    const before = await auditCount(recUser);
    hrmsState.set('sid-T', { active: true, lastSeenAt: Date.now() });
    const c = await browser();
    assert.equal((await c.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-T' }) })).status, 200);
    await c.get('/api/auth/me');   // resolving the session must not add a second "login"
    assert.deepEqual(await opened('sid-T'), [{ method: 'hrms', action: 'auth.login_hrms' }], 'opened as an HRMS login');
    assert.equal(await auditCount(recUser), before + 1, 'exactly one Login (via HRMS) row');
    // A second browser in the same HRMS sign-in: no second login of any kind.
    const loginish = async () => (await raw(
      `select count(*)::int n from audit_log where actor_user_id=$1 and action like 'auth.%' and action not like 'auth.%logout'`, [recUser])).rows[0].n;
    const l0 = await loginish();
    const c2 = await browser();
    assert.equal((await c2.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-T' }) })).status, 200);
    await c2.get('/api/auth/me');
    assert.equal(await loginish(), l0, 'neither a Login nor a "session carried over" row');
    if (real) {
      const ps = (await raw(`select count(distinct portal_session_id)::int n from sessions where hrms_sid='sid-T'`)).rows[0].n;
      assert.equal(ps, 1, 'both browsers share the one portal session');
    }

    const n0 = (await closes()).length;
    assert.equal((await (await browser()).post('/api/auth/hrms-sso/logout', { token: backchannel({ sid: 'sid-T' }) })).body.ended, 2);
    const afterLogout = await closes();
    assert.equal(afterLogout.length, n0 + 1);
    assert.equal(afterLogout.at(-1).reason, 'logout', 'HRMS logout closes it as Logout');

    hrmsState.set('sid-U', { active: true, lastSeenAt: Date.now() });
    const d = await browser();
    assert.equal((await d.post('/api/auth/hrms-sso', { token: launchToken({ sid: 'sid-U' }) })).status, 200);
    hrmsMode = 'error';
    try {
      await raw(`update sessions set hrms_active_at = now() - interval '40 minutes', hrms_checked_at = now() - interval '40 minutes' where hrms_sid='sid-U'`);
      // (0125 never dates a logout before its login, so the login moves back too.)
      if (real) await raw(`update portal_sessions set login_at = now() - interval '45 minutes' where id = (select portal_session_id from sessions where hrms_sid='sid-U')`);
      assert.equal((await d.get('/api/auth/hrms-sso/status')).body.ended, true);
    } finally { hrmsMode = 'ok'; }
    const idle = (await closes()).at(-1);
    assert.equal(idle.reason, 'auto_timeout');
    const ago = (Date.now() - new Date(idle.at).getTime()) / 1000;
    assert.ok(ago >= 2390, `closed at the last real activity, not now (${Math.round(ago)}s ago)`);
  } finally {
    if (!real) {
      await raw(`drop function if exists portal_session_start(text,text,text)`);
      await raw(`drop function if exists portal_session_close(bigint,text,timestamptz)`);
    }
  }
});

test('a password session is untouched by any of this', async () => {
  const c = await browser();
  const before = hrmsCalls.length;
  const r = await c.post('/api/auth/login', { email: 'sso.rec@tl-sink.local', password: 'Staff123pass', role: 'recruiter' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 3; i += 1) assert.equal((await c.get('/api/auth/me')).body.session.role, 'recruiter');
  assert.equal((await c.get('/api/auth/hrms-sso/status')).body.viaHrms, false);
  assert.equal((await c.post('/api/auth/logout', {})).status, 200);
  assert.equal(hrmsCalls.length, before, 'HRMS never called for a password session');
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => hrms.close(r));
  await dbh.stop();
});
