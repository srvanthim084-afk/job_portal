/**
 * Who viewed my profile (0093), end to end against a real Postgres with
 * RLS on. Self-contained: it makes its own company (with an unusual name
 * that must never reach a candidate), staff, jobs and candidates.
 *
 * Nothing leaves the machine: email goes to the mock provider, WhatsApp
 * to a closed port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5463;
const API_PORT = 9983;
const MOCK_PORT = 9862;
const CLIENT_CO = 'Zyxqvor Pharmaworks';          // must never reach a candidate

let dbh, server, mock, base, raw, digest, hashPassword;
const ENGINE = { userId: '', role: 'admin', profileId: null };
const ids = {};

async function staff(table, role, id, name, email, extra = {}) {
  const hash = await hashPassword('Staff12345');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, hash, role])).rows[0].id;
  const cols = ['id', 'user_id', 'name', 'email', ...Object.keys(extra)];
  const vals = [id, u, name, email, ...Object.values(extra)];
  await raw(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Staff12345' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.userId = u;
  return c;
}

async function candidate(name, email) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Viewers123x', phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)),
    preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const viewRows = async (cand) => (await raw(
  `select viewer_role, job_id, view_count, viewer_first_name from candidate_profile_views
    where candidate_id = $1 order by id`, [cand])).rows;

let R, CL, AD, A, B;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'alerts@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AI_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { createApp } = await import('../src/app.js');
  ({ hashPassword } = await import('../src/auth.js'));
  digest = await import('../src/notify/profile-view-digest.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  await raw(`insert into companies (id, name) values ('co_pv', $1)`, [CLIENT_CO]);
  R = await staff('recruiters', 'recruiter', 'r_pv', 'Priya Sharma', 'priya.sharma@tl-sink.local', { company_id: 'co_pv' });
  CL = await staff('client_users', 'client', 'c_pv', 'Kiran Clientside', 'kiran.c@tl-sink.local', { company_id: 'co_pv' });
  AD = await staff('admins', 'admin', 'a_pv', 'Anil Admin', 'anil.admin@tl-sink.local');

  for (const [id, title, status] of [['jpv1', 'Medical Coder', 'open'], ['jpv2', 'Hidden Draft Role', 'draft']]) {
    await raw(`insert into jobs (id, title, company_id, recruiter_id, location, status, skills, published_at)
               values ($1,$2,'co_pv','r_pv','Nellore',$3,'{}',now())`, [id, title, status]);
  }
  A = await candidate('Asha Viewed', 'asha.viewed@tl-sink.local');
  B = await candidate('Bala Viewed', 'bala.viewed@tl-sink.local');
  // Both apply, so the recruiter's desk (0031) includes them.
  for (const c of [A, B]) {
    const r = await c.post('/api/applications', { jobId: 'jpv1' });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  }
});

test('the same viewer, same day, same job is one view with view_count 2', async () => {
  const one = await R.post(`/api/candidates/${A.id}/viewed`, { jobId: 'jpv1', source: 'profile' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(one.body, { recorded: true, reason: 'recorded' });
  const two = await R.post(`/api/candidates/${A.id}/viewed`, { jobId: 'jpv1', source: 'profile' });
  assert.equal(two.body.reason, 'repeat');
  const rows = await viewRows(A.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].view_count, 2);
  assert.equal(rows[0].viewer_role, 'recruiter');
  assert.equal(rows[0].viewer_first_name, 'Priya');
});

test('the viewer and role come from the session, never the body', async () => {
  const r = await R.post(`/api/candidates/${A.id}/viewed`, { jobId: 'jpv1', viewerRole: 'client', viewerUserId: CL.userId });
  assert.equal(r.status, 200);
  const rows = await viewRows(A.id);
  assert.equal(rows.length, 1, 'no client row was invented from the body');
  assert.equal(rows[0].viewer_role, 'recruiter');
});

test('a candidate viewing themselves, an impersonated session and the engine record nothing', async () => {
  const self = await A.post(`/api/candidates/${A.id}/viewed`, {});
  assert.equal(self.body.recorded, false);
  assert.equal(self.body.reason, 'self');

  // Admin "Login as" the recruiter: a new session that is marked.
  const imp = makeClient(base);
  await imp.get('/api/health');
  await imp.post('/api/auth/login', { email: 'anil.admin@tl-sink.local', password: 'Staff12345' });
  const as = await imp.post('/api/staff/recruiters/r_pv/login-as', {});
  assert.equal(as.status, 200, JSON.stringify(as.body));
  const v = await imp.post(`/api/candidates/${B.id}/viewed`, { jobId: 'jpv1' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.recorded, false);
  assert.equal(v.body.reason, 'impersonated');

  const { withUser } = await import('../src/db.js');
  const sys = await withUser(ENGINE, async (c) => (await c.query(
    `select profile_view_record($1,'jpv1','profile','') as r`, [B.id])).rows[0].r);
  assert.equal(sys, 'system');
  assert.equal((await viewRows(B.id)).length, 0, 'nothing recorded for B');
  assert.equal((await viewRows(A.id)).length, 1, 'self view added nothing for A');
});

test('a client is "A hiring team"; a recruiter is their first name', async () => {
  // The stage change writes application_stage_history itself (trigger).
  await raw(`update applications set stage = 'shortlisted' where candidate_id = $1`, [A.id]);
  const hist = (await raw(`select count(*)::int n from application_stage_history h join applications a on a.id = h.application_id
                            where a.candidate_id = $1 and h.to_stage = 'shortlisted'`, [A.id])).rows[0].n;
  assert.equal(hist, 1);
  const c = await CL.post(`/api/candidates/${A.id}/viewed`, { jobId: 'jpv1', source: 'application' });
  assert.equal(c.body.reason, 'recorded', JSON.stringify(c.body));

  const page = await A.get('/api/candidate/profile-viewers');
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const names = page.body.viewers.map((v) => v.displayName).sort();
  assert.deepEqual(names, ['A hiring team', 'Priya (TeamLink Recruiter)']);
  page.body.viewers.forEach((v) => assert.equal(v.roleTitle, 'Medical Coder'));
  assert.equal(page.body.summary.views30, 2);
  assert.equal(page.body.summary.shortlisted30, 1);
  assert.equal(page.body.summary.weeks.length, 8);
  assert.equal(page.body.summary.weeks[7].views, 2, 'this week holds both views');
});

test('the candidate never sees ids, emails, a company or a client name', async () => {
  const page = await A.get('/api/candidate/profile-viewers');
  const text = JSON.stringify(page.body);
  for (const bad of [R.userId, CL.userId, 'priya.sharma@', 'kiran.c@', 'Sharma', 'Kiran', CLIENT_CO, 'Zyxqvor',
    'co_pv', 'r_pv', 'c_pv', 'jpv1']) {
    assert.ok(!text.includes(bad), `the candidate's page contains ${bad}`);
  }
  assert.ok(!/client/i.test(text), 'the word "client" reached the candidate');
});

test('candidate B cannot read A\'s viewers, directly or through the view', async () => {
  const page = await B.get('/api/candidate/profile-viewers');
  assert.equal(page.status, 200);
  assert.equal(page.body.viewers.length, 0);
  const { withUser } = await import('../src/db.js');
  const bUser = (await raw(`select user_id from candidates where id = $1`, [B.id])).rows[0].user_id;
  const bs = { userId: bUser, role: 'candidate', profileId: B.id };
  const direct = await withUser(bs, async (c) => (await c.query(`select count(*)::int n from candidate_profile_views`)).rows[0].n);
  assert.equal(direct, 0);
  const viaView = await withUser(bs, async (c) => (await c.query(`select count(*)::int n from candidate_profile_viewers_v`)).rows[0].n);
  assert.equal(viaView, 0);
  await assert.rejects(withUser(bs, (c) => c.query(
    `insert into candidate_profile_views (candidate_id, viewer_user_id, viewer_role, viewed_on) values ($1, $2, 'recruiter', current_date)`,
    [A.id, bUser])));
  // Staff routes are refused too.
  assert.equal((await B.get('/api/admin/profile-viewer-settings')).status, 403);
});

test('names off: "A TeamLink recruiter"; a job the candidate cannot see has no role', async () => {
  const off = await AD.put('/api/admin/profile-viewer-settings', { showRecruiterNames: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.settings.showRecruiterNames, false);
  await R.post(`/api/candidates/${A.id}/viewed`, { jobId: 'jpv2', source: 'resume' });
  const page = await A.get('/api/candidate/profile-viewers');
  const names = page.body.viewers.map((v) => v.displayName);
  assert.ok(!names.some((n) => n.includes('Priya')), names.join(','));
  assert.ok(names.includes('A TeamLink recruiter'));
  const draftView = page.body.viewers.find((v) => v.source === 'resume');
  assert.equal(draftView.roleTitle, null, 'a draft job is not named to the candidate');
  assert.ok(!JSON.stringify(page.body).includes('Hidden Draft Role'));
  await AD.put('/api/admin/profile-viewer-settings', { showRecruiterNames: true });
});

test('search appearances count only the page shown, once, and skip hidden profiles', async () => {
  const s = await R.get('/api/candidates?q=Viewed&limit=50');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const got = s.body.candidates.map((c) => c.id);
  assert.ok(got.includes(A.id) && got.includes(B.id), got.join(','));
  assert.ok(s.body.appearanceToken, 'a search returns a token');

  // Not a search (no criteria) -> no token.
  const list = await R.get('/api/candidates?limit=10');
  assert.equal(list.body.appearanceToken, null);

  // B hides from search.
  const hide = await B.put('/api/prefs/teamlink_profile_visibility_v1', { value: { [B.id]: false } });
  assert.ok([200, 204].includes(hide.status), JSON.stringify(hide.body));

  // The page showed A and B (and an id the search never returned).
  const r1 = await R.post('/api/candidates/search-appearances',
    { token: s.body.appearanceToken, ids: [A.id, B.id, 'cand_not_returned'] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.credited, 1, 'only A: B is hidden, the third was not in the result');
  const again = await R.post('/api/candidates/search-appearances', { token: s.body.appearanceToken, ids: [A.id] });
  assert.equal(again.body.credited, 0, 'the same page is counted once');

  // A forged or someone else's token credits nothing.
  const forged = await R.post('/api/candidates/search-appearances',
    { token: s.body.appearanceToken.replace(/.$/, (m) => (m === 'A' ? 'B' : 'A')), ids: [A.id] });
  assert.equal(forged.body.credited, 0);
  const stolen = await AD.post('/api/candidates/search-appearances', { token: s.body.appearanceToken, ids: [A.id] });
  assert.equal(stolen.body.credited, 0);

  const pageA = await A.get('/api/candidate/profile-viewers');
  assert.equal(pageA.body.summary.appear30, 1);
  assert.equal(pageA.body.summary.searches[0].role, 'Viewed');
  const pageB = await B.get('/api/candidate/profile-viewers');
  assert.equal(pageB.body.summary.appear30, 0);
});

test('a search sample that names a company is not shown to the candidate', async () => {
  // A recruiter searching by a company name that matches A's record.
  await raw(`update candidates set current_company = $1 where id = $2`, [CLIENT_CO, A.id]);
  const s = await R.get(`/api/candidates?q=${encodeURIComponent('Zyxqvor')}`);
  assert.equal(s.status, 200);
  assert.ok(s.body.candidates.some((c) => c.id === A.id), 'the search found A');
  const r = await R.post('/api/candidates/search-appearances', { token: s.body.appearanceToken, ids: [A.id] });
  assert.equal(r.body.credited, 1, 'it still counts as an appearance');
  const page = await A.get('/api/candidate/profile-viewers');
  assert.equal(page.body.summary.appear30, 2);
  assert.ok(!JSON.stringify(page.body).includes('Zyxqvor'), 'but the company is never shown');
  await raw(`update candidates set current_company = null where id = $1`, [A.id]);
});

test('the 7 PM digest: once a day, only with new views, in-app always, email only when opted in', async () => {
  const before = mock.received.length;
  const optIn = await A.put('/api/candidate/profile-viewers/prefs', { digestEmail: true });
  assert.equal(optIn.status, 200);
  assert.equal(optIn.body.prefs.digestEmail, true);

  // Before 19:00 IST nothing happens.
  const morning = Date.UTC(2026, 9, 3, 3, 0, 0);     // 08:30 IST
  const early = await digest.runProfileViewDigest({ now: morning });
  assert.equal(early.skipped, 'before 7 PM IST');

  const r = await digest.runProfileViewDigest({ force: true });
  assert.equal(r.due, 1, 'only A had views today');
  assert.equal(r.inApp, 1);
  assert.equal(r.email, 1);

  const notes = (await A.get('/api/notifications')).body.notifications.filter((n) => n.type === 'PROFILE_VIEWS_DIGEST');
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /2 recruiters and hiring teams viewed your profile today/);
  assert.ok(!notes[0].message.includes('Priya') && !/client/i.test(notes[0].message));
  const mails = mock.received.slice(before).filter((m) => m.url === '/email');
  assert.equal(mails.length, 1);
  assert.ok(!JSON.stringify(mails[0].body).includes('Zyxqvor'));

  const again = await digest.runProfileViewDigest({ force: true });
  assert.equal(again.due, 0, 'never twice in a day');
  assert.equal(mock.received.slice(before).filter((m) => m.url === '/email').length, 1);

  const bNotes = (await B.get('/api/notifications')).body.notifications.filter((n) => n.type === 'PROFILE_VIEWS_DIGEST');
  assert.equal(bNotes.length, 0, 'no views, no digest');

  // Turned off by the administrator: nothing.
  await AD.put('/api/admin/profile-viewer-settings', { dailyDigest: false });
  const off = await digest.runProfileViewDigest({ force: true });
  assert.equal(off.skipped, 'turned off in settings');
  await AD.put('/api/admin/profile-viewer-settings', { dailyDigest: true });
});

test('rows older than 180 days are removed', async () => {
  await raw(`insert into candidate_profile_views (candidate_id, viewer_user_id, viewer_role, viewed_on)
             values ($1, $2, 'recruiter', current_date - 200)`, [A.id, R.userId]);
  await raw(`insert into candidate_search_appearances (candidate_id, day, count) values ($1, current_date - 200, 3)`, [A.id]);
  const out = await digest.runProfileViewCleanup();
  assert.equal(out.views, 1);
  assert.equal(out.appearances, 1);
  const left = (await raw(`select count(*)::int n from candidate_profile_views where candidate_id = $1`, [A.id])).rows[0].n;
  assert.equal(left, 3, 'recent views stay');
  const { withUser } = await import('../src/db.js');
  const adminSession = { userId: AD.userId, role: 'admin', profileId: 'a_pv' };
  await assert.rejects(withUser(adminSession, (c) => c.query(`select profile_views_cleanup()`)), /engine only/);
});

test('staff can read view rows for candidates they can see', async () => {
  const { withUser } = await import('../src/db.js');
  const rs = { userId: R.userId, role: 'recruiter', profileId: 'r_pv' };
  const n = await withUser(rs, async (c) => (await c.query(
    `select count(*)::int n from candidate_profile_views where candidate_id = $1`, [A.id])).rows[0].n);
  assert.ok(n >= 2);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
