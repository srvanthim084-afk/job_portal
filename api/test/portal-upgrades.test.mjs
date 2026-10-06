/**
 * Job portal upgrades (0095), end to end against a real Postgres with RLS:
 * quick filter chips, match reasons, sharing, one-click apply + Undo, the
 * last date and urgent hiring, and the urgent / last-date candidate alerts.
 *
 * Self-contained: it makes its own company, recruiter, jobs and candidates.
 * Nothing leaves the machine - email goes to a local mock that can be told
 * to fail, so "one channel down, the other still delivered, the failure
 * retried" is tested against a real HTTP refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5465;
const API_PORT = 9985;
const MOCK_PORT = 9863;
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const CLIENT_NAME = 'Acme Hospitals';

let dbh, server, base, raw, core, alerts;
let recruiter, admin;
const mail = { received: [], failEmail: false };

async function startMock() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch { json = { raw: body }; }
      if (req.url.startsWith('/email') && mail.failEmail) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mail server down' }));
        return;
      }
      mail.received.push({ url: req.url, body: json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock_' + mail.received.length }));
    });
  });
  await new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', r));
  return srv;
}
let mock;
const emailsWith = (re) => mail.received.filter((m) => m.url.startsWith('/email') && re.test(String(m.body.subject || '')));

let seq = 0;
async function job(f = {}) {
  seq += 1;
  const id = f.id || `jpu${seq}`;
  await raw(`insert into jobs (id, title, company_id, recruiter_id, location, mode, exp_label, pay_label,
                               salary_min, salary_max, employment_type, posting_kind, status, skills,
                               description, published_at, expires_at, urgent, walkin_date)
             values ($1,$2,'co_pu','rpu1',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, f.title || 'Java Developer', f.location || 'Nellore', f.mode || 'Onsite', f.exp || '2-4 yrs',
     f.pay || '₹4-6 LPA', f.salaryMin ?? 4, f.salaryMax ?? 6, f.type || 'Full-time', f.kind || 'job',
     f.status || 'open', f.skills || ['Java', 'Spring', 'AWS', 'SQL'], f.desc || 'A role.',
     f.publishedAt || new Date(), f.expiresAt || null, !!f.urgent, f.walkinDate || null]);
  return id;
}

async function candidate(name, profile = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now().toString(36)}@tl-sink.local`;
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Portal123up', phone: '9' + String(100000000 + Math.floor(Math.random() * 899999999)),
    preferredLocation: 'Nellore', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.email = email;
  await setProfile(c.id, profile);
  return c;
}
async function setProfile(id, p) {
  const full = { location: 'Nellore', exp: '3 yrs', exp_years: 3, skills: ['Java', 'Spring'], resume_file: 'cv.pdf', ...p };
  await raw(`update candidates set location=$2, exp=$3, exp_years=$4, skills=$5, resume_file=$6,
                                   technical_skills='{}', education=''
              where id=$1`, [id, full.location, full.exp, full.exp_years, full.skills, full.resume_file]);
}
const log = (jobId, candId) => raw(
  `select channel, status, event_type, match_percent, attempts, next_retry_at, error
     from notification_log where job_id=$1 and candidate_id=$2 order by event_type, channel`, [jobId, candId])
  .then((r) => r.rows);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'jobs@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    NOTIFY_MATCH_THRESHOLD: '60',
    PORTAL_ALERT_RETRY_MS: '60000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  await raw(`insert into companies (id, name) values ('co_pu', $1)`, [CLIENT_NAME]);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('rpu@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('rpu1','Rec PU','rpu@tl-sink.local','co_pu',$1)`, [ru]);
  const au = (await raw(`insert into users (email,password_hash,role) values ('apu@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('apu1','Admin PU','apu@tl-sink.local',$1)`, [au]);

  const { createApp } = await import('../src/app.js');
  core = await import('../src/portal/core.js');
  alerts = await import('../src/portal/alerts.js');
  const app = createApp({ serveStatic: WEB, logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = makeClient(base);
  await recruiter.get('/api/health');
  assert.equal((await recruiter.post('/api/auth/login', { email: 'rpu@tl-sink.local', password: 'Staff123pass', role: 'recruiter' })).status, 200);
  admin = makeClient(base);
  await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'apu@tl-sink.local', password: 'Staff123pass', role: 'admin' })).status, 200);
});

/* ------------------------------------------------------------------ *
 * 1. quick filters
 * ------------------------------------------------------------------ */

test('the chip list comes from app_settings and the admin can reorder and hide chips', async () => {
  const anon = makeClient(base);
  const r = await anon.get('/api/quick-filters');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.chips.map((c) => c.key),
    ['fresher', 'wfh', 'immediate', 'near_me', 'today', 'urgent', 'salary3', 'walkin', 'walkin_today', 'walkin_week', 'internship']);

  assert.equal((await recruiter.put('/api/admin/quick-filters', { chips: [{ key: 'urgent' }] })).status, 403);
  const put = await admin.put('/api/admin/quick-filters', {
    chips: [{ key: 'urgent', label: 'Urgent' }, { key: 'fresher' }, { key: 'walkin', enabled: false }, { key: 'bogus' }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after = (await anon.get('/api/quick-filters')).body.chips;
  assert.deepEqual(after.slice(0, 2).map((c) => [c.key, c.label]), [['urgent', 'Urgent'], ['fresher', 'Fresher']]);
  assert.equal(after.some((c) => c.key === 'walkin'), false, 'a hidden chip is not offered');
  assert.equal(after.some((c) => c.key === 'bogus'), false);
  /* restore the default order for the UI tests */
  await admin.put('/api/admin/quick-filters', { chips: core.QUICK_CHIPS.map((c) => ({ ...c, enabled: true })) });
});

test('chips filter the job board in SQL', async () => {
  const yesterday = new Date(Date.now() - 3 * 86400000);
  const fresher = await job({ title: 'Store Helper', exp: 'Fresher', salaryMax: 2, publishedAt: yesterday });
  const wfh = await job({ title: 'Support Agent', mode: 'Remote', exp: '1-3 yrs', salaryMax: 3.5, publishedAt: yesterday });
  const immediate = await job({ title: 'Driver', desc: 'Immediate joining required.', exp: '1-2 yrs', salaryMax: 2, publishedAt: yesterday });
  const walk = await job({ title: 'Nurse', type: 'Walk-in', kind: 'walkin', exp: '1-2 yrs', salaryMax: 2, publishedAt: yesterday });
  const urgent = await job({ title: 'Cook', urgent: true, exp: '1-2 yrs', salaryMax: 2, publishedAt: yesterday });
  const today = await job({ title: 'Cashier', exp: '1-2 yrs', salaryMax: 2, location: 'Hyderabad' });

  const ids = async (q) => {
    const r = await makeClient(base).get(`/api/jobs?quick=${q}&ids=1`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.ids;
  };
  assert.deepEqual(await ids('fresher'), [fresher]);
  assert.deepEqual(await ids('wfh'), [wfh]);
  assert.deepEqual(await ids('immediate'), [immediate]);
  assert.deepEqual(await ids('walkin'), [walk]);
  assert.deepEqual(await ids('urgent'), [urgent]);
  assert.deepEqual((await ids('today')).filter((x) => [fresher, wfh, immediate, walk, urgent, today].includes(x)), [today]);
  assert.ok((await ids('salary3')).includes(wfh));
  assert.equal((await ids('salary3')).includes(fresher), false);
  assert.deepEqual(await ids('fresher,wfh'), [], 'chips combine with AND');

  const near = await makeClient(base).get('/api/jobs?quick=near_me&near=Hyderabad&ids=1');
  assert.ok(near.body.ids.includes(today));
  assert.equal(near.body.ids.includes(fresher), false, 'a Nellore job is not near Hyderabad');

  const full = await makeClient(base).get('/api/jobs?quick=urgent');
  assert.equal(full.body.jobs[0].id, urgent);
  assert.equal(full.body.jobs[0].urgent, true);
  /* without ?quick= the ordinary board answers */
  const plain = await makeClient(base).get('/api/jobs');
  assert.equal(plain.status, 200);
  assert.equal(plain.body.chips, undefined);
  await raw(`update jobs set status='closed' where id = any($1)`, [[fresher, wfh, immediate, walk, urgent, today]]);
});

/* ------------------------------------------------------------------ *
 * 2. match reasons
 * ------------------------------------------------------------------ */

test('explain is the AI Match - JD skills matched / required, nothing else - with reasons; candidates only, 50 at most', async () => {
  const j = await job({ title: 'Java Developer' });
  const c = await candidate('Explain Same', { skills: ['Java', 'Spring', 'SQL'] });

  const ex = await c.get(`/api/job-matches/explain?jobIds=${j}`);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  const m = ex.body.matches[0];
  assert.equal(m.score, 75, '3 of the 4 JD skills');
  assert.equal(m.basis, 'skills');
  assert.deepEqual([m.matchedCount, m.required], [3, 4]);
  assert.deepEqual(m.matchedSkills, ['Java', 'Spring', 'SQL']);
  assert.deepEqual(m.missingSkills, ['AWS']);
  assert.equal(m.experience.ok, true);
  assert.equal(m.location.ok, true);
  assert.deepEqual(m.line.map((x) => [x.ok, x.text]), [[true, 'Java, Spring, SQL'], [true, '3 yrs'], [false, 'AWS']]);
  assert.ok(m.reasons.some((x) => x.key === 'skills') && m.reasons.some((x) => x.key === 'location'), JSON.stringify(m.reasons));
  assert.equal(typeof m.recommendation, 'string');
  assert.equal(/\d+%/.test(m.recommendation), false, 'the recommendation quotes no second number');

  /* location, experience and salary do not move it */
  await raw(`update candidates set location='Chennai', preferred_location='Chennai', exp='12 yrs', exp_years=12, expected_ctc=40 where id=$1`, [c.id]);
  const moved = (await c.get(`/api/job-matches/explain?jobIds=${j}`)).body.matches[0];
  assert.equal(moved.score, 75, 'location, experience and salary changed; the AI Match did not');
  assert.equal(moved.location.ok, false);
  await setProfile(c.id, { skills: ['Java', 'Spring', 'SQL'] });

  /* a JD with no skills has no AI Match - not 0% */
  const none = await job({ title: 'Staff Nurse', skills: [] });
  const n = (await c.get(`/api/job-matches/explain?jobIds=${none}`)).body.matches[0];
  assert.equal(n.score, null);
  assert.equal(n.skillsStated, false);

  /* recruiter screening keeps its own multi-factor score; it is not the candidate's AI Match */
  const applied = await c.post('/api/applications', { jobId: j });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(typeof applied.body.screening.score, 'number');
  const row = (await raw(`select match_score from applications where id=$1`, [applied.body.application.id])).rows[0];
  assert.equal(Number(row.match_score), applied.body.screening.score);

  assert.equal((await makeClient(base).get(`/api/job-matches/explain?jobIds=${j}`)).status, 401);
  assert.equal((await recruiter.get(`/api/job-matches/explain?jobIds=${j}`)).status, 403);
  const many = Array.from({ length: 51 }, (_, i) => `x${i}`).join(',');
  assert.equal((await c.get(`/api/job-matches/explain?jobIds=${many}`)).status, 400);
});

/* ------------------------------------------------------------------ *
 * 4. one-click apply + Undo
 * ------------------------------------------------------------------ */

test('one-click: refused with the missing fields, idempotent, Undo within 10 s by the owner only', async () => {
  const j = await job({ title: 'One Click Role' });
  const c = await candidate('One Clicker', { resume_file: null, skills: [] });
  const other = await candidate('Someone Else');

  const check = await c.get('/api/applications/one-click/check');
  assert.deepEqual(check.body, { ready: false, missing: ['skills', 'resume'] });
  const refused = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body.error.details.missing, ['skills', 'resume']);
  assert.match(refused.body.error.message, /Fill 2 things to apply/);

  await setProfile(c.id, {});
  const first = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.application.id, first.body.application.id);
  assert.equal((await raw(`select count(*)::int n from applications where job_id=$1`, [j])).rows[0].n, 1);

  const id = first.body.application.id;
  assert.equal((await other.del(`/api/applications/${id}`)).status, 403, 'not the owner');
  assert.equal((await recruiter.del(`/api/applications/${id}`)).status, 403);
  const undo = await c.del(`/api/applications/${id}`);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal((await raw(`select count(*)::int n from applications where id=$1`, [id])).rows[0].n, 0);

  const re = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(re.status, 201);
  await raw(`update applications set applied_at = now() - interval '11 seconds' where id=$1`, [re.body.application.id]);
  const late = await c.del(`/api/applications/${re.body.application.id}`);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'UNDO_EXPIRED');
});

test('applying is limited to 30 an hour per candidate (configurable)', async () => {
  const c = await candidate('Rate Limited');
  process.env.APPLY_RATE_PER_HOUR = '2';
  try {
    const a = await job({ title: 'Rate A' }), b = await job({ title: 'Rate B' }), d = await job({ title: 'Rate C' });
    assert.equal((await c.post('/api/applications/one-click', { jobId: a })).status, 201);
    assert.equal((await c.post('/api/applications', { jobId: b })).status, 201);
    const third = await c.post('/api/applications/one-click', { jobId: d });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
  } finally { delete process.env.APPLY_RATE_PER_HOUR; }
});

/* ------------------------------------------------------------------ *
 * 5. last date + urgent hiring
 * ------------------------------------------------------------------ */

test('the last date is the end of that day in India, and an expired job refuses applications', async () => {
  const j = await job({ title: 'Deadline Role' });
  const d = await recruiter.put(`/api/jobs/${j}/deadline`, { lastDate: '2026-12-31' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.job.expiresAt, '2026-12-31T18:29:59.999Z');
  assert.equal(core.daysLeft('2026-12-31T18:29:59.999Z', Date.parse('2026-12-29T03:00:00Z')), 2);
  assert.equal(core.daysLeft('2026-12-31T18:29:59.999Z', Date.parse('2026-12-31T18:00:00Z')), 0);

  const c = await candidate('Too Late');
  await raw(`update jobs set expires_at = now() - interval '1 minute' where id=$1`, [j]);
  const r1 = await c.post('/api/applications', { jobId: j });
  assert.equal(r1.status, 409);
  assert.match(r1.body.error.message, /Applications closed/);
  const r2 = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(r2.status, 409);
  assert.match(r2.body.error.message, /Applications closed/);

  /* the daily pass closes it and tells the recruiter */
  const closed = await alerts.closeExpiredJobs();
  assert.ok(closed.includes(j));
  assert.equal((await raw(`select status from jobs where id=$1`, [j])).rows[0].status, 'closed');
  const n = (await raw(`select title from notifications where recipient_id='rpu1' and type='JOB_CLOSED_EXPIRED' and job_id=$1`, [j])).rows;
  assert.equal(n.length, 1);
});

test('urgent hiring lasts 14 days and switches itself off', async () => {
  const j = await job({ title: 'Urgent Role' });
  const r = await recruiter.put(`/api/jobs/${j}/deadline`, { urgent: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.job.urgent, true);
  const days = (Date.parse(r.body.job.urgentUntil) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days < 14.1, `urgent_until is ${days} days away`);

  await raw(`update jobs set urgent_until = now() - interval '1 second' where id=$1`, [j]);
  const shown = (await makeClient(base).get(`/api/jobs/${j}`)).body.job;
  assert.equal(shown.urgent, undefined, 'past its 14 days it is not shown as urgent');
  const off = await alerts.expireUrgent();
  assert.ok(off.includes(j));
  assert.equal((await raw(`select urgent from jobs where id=$1`, [j])).rows[0].urgent, false);
  await raw(`update jobs set status='closed' where id=$1`, [j]);
});

test('the recruiter is reminded two days before the last date, once', async () => {
  const now = Date.now();
  const j = await job({ title: 'Reminder Role', expiresAt: core.endOfIstDay(core.istDay(now + 2 * 86400000)) });
  const a = await alerts.remindRecruiters({ now });
  assert.ok(a.includes(j));
  const b = await alerts.remindRecruiters({ now });
  assert.equal(b.includes(j), false);
  const rows = (await raw(`select message from notifications where type='JOB_DEADLINE_REMINDER' and job_id=$1`, [j])).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /Extend the last date or let it close/);
  await raw(`update jobs set status='closed' where id=$1`, [j]);
});

/* ------------------------------------------------------------------ *
 * 3. sharing
 * ------------------------------------------------------------------ */

test('share: the link moves to PUBLIC_SHARE_URL (path and ?ref kept); blank fields are left out', async () => {
  const { toPublicUrl, shareText } = await import('../src/portal/core.js');
  assert.equal(toPublicUrl('http://localhost:4323/job/j1?ref=abc123', 'https://jobs.example.in'),
    'https://jobs.example.in/job/j1?ref=abc123');
  assert.equal(toPublicUrl('http://localhost:4323/job/j1?ref=abc123', ''), 'http://localhost:4323/job/j1?ref=abc123');
  assert.equal(toPublicUrl('https://jobs.example.in/job/j1', 'https://jobs.example.in'), 'https://jobs.example.in/job/j1');
  const t = shareText({ title: 'Staff Nurse', location: 'undefined', type: null }, 'https://x.test/job/j1');
  assert.equal(t.includes('Location'), false);
  assert.equal(t.includes('Job Type'), false);
  assert.equal(t.includes('undefined'), false);
  assert.match(t, /🏥 \*Staff Nurse\*/);
  /* no title: no title line, never a placeholder */
  const empty = shareText({}, 'https://x.test/job/j2');
  assert.equal(empty.includes('🏥'), false);
  assert.ok(empty.includes('🔗 https://x.test/job/j2'));

  const j = await job({ title: 'Public Share Role', location: 'Guntur', pay: '₹3 LPA' });
  process.env.PUBLIC_SHARE_URL = 'https://jobs.example.in';
  try {
    const s = await makeClient(base).post(`/api/jobs/${j}/share`, { channel: 'whatsapp' });
    assert.equal(s.status, 201);
    assert.equal(s.body.url, `https://jobs.example.in/job/${j}?ref=${s.body.code}`);
    assert.equal(s.body.publicLink, true);
    assert.ok(s.body.text.includes(`https://jobs.example.in/job/${j}?ref=${s.body.code}`));
  } finally {
    delete process.env.PUBLIC_SHARE_URL;
  }
});

test('share: a walk-in job carries its walk-in block; a regular job never does; empty fields are left out', async () => {
  const w = await job({ title: 'HR Recruiter', location: 'KPHB, Hyderabad', pay: '₹3 LPA', exp: '0-Any', kind: 'walkin',
    type: 'Walk-in', urgent: true, walkinDate: '2026-10-10' });
  await raw(`update jobs set education='Any Degree', requirements=$2, walkin_from='10:00', walkin_to='16:00',
             walkin_venue='TeamLink Consultants (OPC) Pvt. Ltd.', walkin_contact='HR Desk', walkin_phone='9032321414'
             where id=$1`, [w, ['Good Communication Skills', 'Telugu & English are Mandatory']]);
  await raw(`update jobs set urgent_until = now() + interval '7 days' where id=$1`, [w]);
  const ws = await makeClient(base).post(`/api/jobs/${w}/share`, { channel: 'whatsapp' });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const t = ws.body.text;
  /* the job-opportunity format (owner, 2026-10-06), with the walk-in block before the apply CTA */
  for (const line of ['*🚀 NEW JOB OPPORTUNITY – KPHB, Hyderabad*',
    'Hi! 👋 We found a job opportunity that could be a great match for your profile!',
    '🏥 *HR Recruiter*', '🎓 Qualification: Any Degree', '💼 Experience: *0-Any*',
    '💰 Salary: *₹3 LPA*', '📍 Location: *KPHB, Hyderabad*', "*⭐ What We're Looking For*", '✅ Telugu & English are Mandatory',
    '*🚶 Walk-In Interview*', '📅 Walk-In Date: 10 October 2026', '⏰ Interview Time: 10:00 AM – 4:00 PM',
    '📄 Please carry:', '• Updated Resume – Hard Copy', '• A copy of this Job Post',
    '⚠️ Important: The job post copy must be shown at the main gate entrance.', '📍 Venue:',
    'TeamLink Consultants (OPC) Pvt. Ltd.', '📞 Contact: HR Desk – 9032321414',
    '*👉 Interested? Explore the complete job details and apply now:*',
    `🔗 ${base}/job/${w}?ref=${ws.body.code}`, "📩 Don't miss this opportunity — apply today!"]) {
    assert.ok(t.split('\n').includes(line), `missing line: ${line}\n---\n${t}`);
  }
  const tl = t.split('\n');
  assert.ok(tl.indexOf('*🚶 Walk-In Interview*') < tl.indexOf('*👉 Interested? Explore the complete job details and apply now:*'),
    'the walk-in block comes before the apply CTA');
  assert.equal(/Job Type: Walk-in/.test(t), false, 'walk-in is not shown as a job type line');
  /* the WhatsApp link decodes back to exactly the message: emojis, ₹, &, new lines survive */
  assert.equal(decodeURIComponent(ws.body.links.whatsapp.replace('https://wa.me/?text=', '')), t);
  assert.equal(/[\s]/.test(ws.body.links.whatsapp.slice('https://wa.me/?text='.length)), false, 'unencoded characters in the link');

  const r = await job({ title: 'Software Developer', location: 'Hyderabad', pay: '₹5-8 LPA', exp: '1-3 yrs', mode: 'Hybrid' });
  const rs = await makeClient(base).post(`/api/jobs/${r}/share`, { channel: 'copy' });
  const rt = rs.body.text;
  assert.match(rt, /🏥 \*Software Developer\*/);
  assert.match(rt, /🕐 Job Type: Full-time/);
  assert.match(rt, /🏠 Work From Home: Hybrid/);
  for (const word of ['Walk-In', 'Venue', 'main gate', 'Hard Copy', 'Please carry']) {
    assert.equal(rt.includes(word), false, `"${word}" in a regular job's share`);
  }

  const m = await job({ title: 'Field Assistant', location: '', pay: '', exp: '' });
  await raw(`update jobs set location=null, pay_label=null, exp_label=null, education=null, mode=null, employment_type=null where id=$1`, [m]);
  const ms = await makeClient(base).post(`/api/jobs/${m}/share`, { channel: 'copy' });
  const mt = ms.body.text;
  for (const word of ['undefined', 'null', 'NaN', 'Salary', 'Location', 'Experience', 'Qualification', 'Job Type']) {
    assert.equal(mt.includes(word), false, `"${word}" in a share of a job without it:\n${mt}`);
  }
  assert.match(mt, /🏥 \*Field Assistant\*/);
});

test('share: code, text and link preview without the client name; clicks and applies counted', async () => {
  const j = await job({ title: 'Share Role', location: 'Nellore', pay: '₹3-4 LPA' });
  const anon = makeClient(base);
  const s = await anon.post(`/api/jobs/${j}/share`, { channel: 'whatsapp' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const link = `${base}/job/${j}?ref=${s.body.code}`;
  assert.equal(s.body.url, link);
  assert.equal(s.body.text, [
    '*🚀 NEW JOB OPPORTUNITY – Nellore*', '',
    'Hi! 👋 We found a job opportunity that could be a great match for your profile!', '',
    '🏥 *Share Role*', `🏢 *${CLIENT_NAME}*`, '',
    '💼 Experience: *2-4 yrs*', '💰 Salary: *₹3-4 LPA*', '📍 Location: *Nellore*', '🕐 Job Type: Full-time',
    '🏠 Work From Home: Not Available', '',
    '*👉 Interested? Explore the complete job details and apply now:*',
    `🔗 ${link}`,
    "📩 Don't miss this opportunity — apply today!", '',
    `*${CLIENT_NAME}*`].join('\n'));
  assert.equal(s.body.body, s.body.text.split('\n').filter((l) => l !== `🔗 ${link}`).join('\n'),
    'body = the message without its link line');
  assert.equal(decodeURIComponent(s.body.links.whatsapp.replace('https://wa.me/?text=', '')), s.body.text);
  assert.equal(s.body.publicLink, false, 'a 127.0.0.1 link is reported as not public');
  assert.ok(s.body.links.whatsapp.startsWith('https://wa.me/?text='));
  /* The owner's share spec shows the company the card shows; nothing about
     the sharer and nothing internal. */
  for (const word of ['undefined', 'null', 'NaN', 'rpu1', 'Rec PU', 'cand', 'stage', 'score']) {
    assert.equal(s.body.text.includes(word), false, `"${word}" in the share`);
  }

  /* a link-preview robot reads the tags and is not counted */
  const bot = await fetch(`${base}/job/${j}?ref=${s.body.code}`, { headers: { 'user-agent': 'WhatsApp/2.23' } });
  const html = await bot.text();
  assert.equal(bot.status, 200);
  assert.match(html, /<meta property="og:title" content="Share Role – Acme Hospitals">/);
  assert.match(html, /og:description" content="2-4 yrs \| Nellore \| ₹3-4 LPA"/);
  assert.match(html, /og:image" content="[^"]+\/icons\/icon-512\.png"/);
  assert.match(html, /history\.replaceState\(null,'',"\/\?ref=[^"]+#\/job\//);

  /* a person opening it is counted, and their application credited */
  const c = await candidate('Shared With');
  const open = await c.get(`/job/${j}?ref=${s.body.code}`);
  assert.equal(open.status, 200);
  assert.ok(c.jar.get('tl_share_ref'), 'the share is remembered for this job');
  const applied = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));

  await new Promise((r) => setTimeout(r, 300));
  const stats = await recruiter.get(`/api/jobs/${j}/share-stats`);
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  assert.deepEqual({ shares: stats.body.shares, clicks: stats.body.clicks, applies: stats.body.applies },
    { shares: 1, clicks: 1, applies: 1 });
  assert.equal((await c.get(`/api/jobs/${j}/share-stats`)).status, 403);

  /* a closed job cannot be shared */
  await raw(`update jobs set status='closed' where id=$1`, [j]);
  assert.equal((await anon.post(`/api/jobs/${j}/share`, { channel: 'copy' })).status, 404);
  /* the hash route still works for an unknown job: the page is served */
  assert.equal((await fetch(`${base}/job/nope`)).status, 200);
});

/* ------------------------------------------------------------------ *
 * candidate alerts: urgent hiring and the last date
 * ------------------------------------------------------------------ */

let AJ, at60, at80, applied100, dnc;

test('urgent hiring alert: above 60% only, both channels, applied skipped, never twice', async () => {
  assert.equal(core.aboveThreshold(60, 60), false);
  assert.equal(core.aboveThreshold(60.01, 60), true);
  assert.equal(core.aboveThreshold(59.99, 60), false);

  /* only the four profiles below match anything from here on */
  await raw(`update candidates set skills='{}', technical_skills='{}'`);
  /* five JD skills, so the AI Match lands on 60 / 80 / 100 exactly */
  AJ = await job({ title: 'Alert Java Developer', skills: ['Java', 'Spring', 'AWS', 'SQL', 'Docker'] });
  at60 = await candidate('Sixty Exactly', { skills: ['Java', 'Spring', 'AWS'] });
  at80 = await candidate('Eighty Match', { skills: ['Java', 'Spring', 'AWS', 'SQL'] });
  applied100 = await candidate('Already Applied', { skills: ['Java', 'Spring', 'AWS', 'SQL', 'Docker'] });
  dnc = await candidate('Do Not Contact', { skills: ['Java', 'Spring', 'AWS', 'SQL'] });
  await raw(`update candidates set do_not_contact = true where id=$1`, [dnc.id]);

  const s60 = (await at60.get(`/api/job-matches/explain?jobIds=${AJ}`)).body.matches[0].score;
  const s80 = (await at80.get(`/api/job-matches/explain?jobIds=${AJ}`)).body.matches[0].score;
  assert.equal(s60, 60, 'this profile scores exactly 60');
  assert.equal(s80, 80);
  assert.equal((await applied100.post('/api/applications', { jobId: AJ })).status, 201);

  const before = emailsWith(/^Urgent hiring:/).length;
  const r = await recruiter.put(`/api/jobs/${AJ}/deadline`, { urgent: true });
  assert.equal(r.status, 200);
  const runs = await alerts.runPendingUrgent({ jobId: AJ });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].skippedApplied, 1);

  assert.deepEqual(await log(AJ, at60.id), [], '60 exactly gets nothing');
  assert.deepEqual(await log(AJ, applied100.id), [], 'already applied gets nothing');
  const l80 = await log(AJ, at80.id);
  assert.deepEqual(l80.map((x) => [x.channel, x.status, x.event_type, Number(x.match_percent)]),
    [['email', 'sent', 'urgent_hiring', 80], ['in_app', 'sent', 'urgent_hiring', 80]]);

  const inbox = (await raw(`select title, message, metadata from notifications where recipient_id=$1 and type='URGENT_HIRING'`, [at80.id])).rows;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, 'Urgent hiring');
  /* the inbox entry is the full job-opportunity message (owner, 2026-10-06) */
  assert.match(inbox[0].message, /^\*🚀 URGENT HIRING – Nellore\*\n\nHi! 👋 We found an urgent job opening that could be a great match for your profile \(80% match\)!/);
  assert.ok(inbox[0].message.includes('🏥 *Alert Java Developer*'));
  assert.ok(inbox[0].message.includes(`🏢 *${CLIENT_NAME}*`));
  assert.ok(inbox[0].message.includes(`🔗 ${process.env.PUBLIC_ORIGIN.replace(/\/$/, '')}/#/job/${AJ}`), inbox[0].message);
  assert.equal(inbox[0].metadata.format, 'job_opportunity');
  assert.equal(inbox[0].metadata.applyUrl, `#/job/${AJ}`);
  assert.equal(inbox[0].metadata.cta, 'Apply now');
  /* the candidate reads it through the API */
  const mine = await at80.get('/api/bootstrap');
  assert.ok(mine.body.data.notifications.some((n) => n.type === 'URGENT_HIRING' && n.metadata.matchPercent === 80));

  const sent = emailsWith(/^Urgent hiring:/).slice(before);
  assert.equal(sent.length, 1, 'one email: the 80% candidate (DNC is skipped)');
  assert.equal(sent[0].body.subject, `Urgent hiring: Alert Java Developer at ${CLIENT_NAME}`);
  assert.deepEqual(sent[0].body.to, [at80.email]);
  assert.match(sent[0].body.html, /80% match/);
  assert.match(sent[0].body.html, />Apply now</);
  assert.equal(/\bclient\b/i.test(sent[0].body.text), false, 'never the word Client');

  const ld = await log(AJ, dnc.id);
  assert.deepEqual(ld.map((x) => [x.channel, x.status]), [['email', 'skipped'], ['in_app', 'sent']]);

  /* run it again, and again with the announcement re-armed: nothing new */
  await alerts.runPendingUrgent({ jobId: AJ });
  await raw(`update jobs set urgent_alerted_at = null where id=$1`, [AJ]);
  await alerts.runPendingUrgent({ jobId: AJ });
  assert.equal(emailsWith(/^Urgent hiring:/).length - before, 1, 'no second email');
  assert.equal((await log(AJ, at80.id)).length, 2, 'no second log row');
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id=$1 and type='URGENT_HIRING'`, [at80.id])).rows[0].n, 1);
});

test('last-date alerts: two days before and on the day, match recomputed when sent', async () => {
  const now = Date.now();
  await raw(`update jobs set expires_at=$2, urgent=false where id=$1`, [AJ, core.endOfIstDay(core.istDay(now + 2 * 86400000))]);
  const b = await alerts.runDeadlineAlerts({ now });
  assert.ok(b.some((r) => r.jobId === AJ && r.event === 'deadline_2d'));
  assert.deepEqual((await log(AJ, at80.id)).filter((x) => x.event_type === 'deadline_2d')
    .map((x) => [x.channel, x.status, Number(x.match_percent)]), [['email', 'sent', 80], ['in_app', 'sent', 80]]);
  const subj = emailsWith(/^Last date to apply:/);
  assert.ok(subj.some((m) => m.body.subject.startsWith('Last date to apply: Alert Java Developer – ')));
  assert.equal((await log(AJ, at60.id)).length, 0);

  /* the profiles change before the last day: the 60 becomes 80 and the 80 becomes 60 */
  await setProfile(at60.id, { skills: ['Java', 'Spring', 'AWS', 'SQL'] });
  await setProfile(at80.id, { skills: ['Java', 'Spring', 'AWS'] });
  await raw(`update jobs set expires_at=$2 where id=$1`, [AJ, core.endOfIstDay(core.istDay(now))]);
  const c = await alerts.runDeadlineAlerts({ now });
  assert.ok(c.some((r) => r.jobId === AJ && r.event === 'deadline_today'));
  assert.deepEqual((await log(AJ, at60.id)).map((x) => [x.event_type, x.channel, x.status, Number(x.match_percent)]),
    [['deadline_today', 'email', 'sent', 80], ['deadline_today', 'in_app', 'sent', 80]]);
  assert.equal((await log(AJ, at80.id)).filter((x) => x.event_type === 'deadline_today').length, 0,
    'now at 60, they are not told');
  const today = (await raw(`select title from notifications where recipient_id=$1 and type='DEADLINE_TODAY'`, [at60.id])).rows;
  assert.deepEqual(today.map((x) => x.title), ['Last day to apply']);

  /* the daily pass runs once per IST day */
  const first = await alerts.runDailyIfDue({ now, force: true });
  assert.ok(first);
  const second = await alerts.runDailyIfDue({ now: now + 60000 });
  assert.equal(second, null);
});

test('one channel failing: the other is delivered and the failure is retried', async () => {
  const j = await job({ title: 'Retry Java Developer' });
  const c = await candidate('Retry Person', { skills: ['Java', 'Spring', 'AWS'] });
  await raw(`update candidates set skills='{}' where id = any($1)`, [[at60.id, at80.id, applied100.id, dnc.id]]);

  mail.failEmail = true;
  await raw(`update jobs set urgent=true where id=$1`, [j]);
  await alerts.runPendingUrgent({ jobId: j });
  let l = await log(j, c.id);
  assert.deepEqual(l.map((x) => [x.channel, x.status, x.attempts]), [['email', 'failed', 1], ['in_app', 'sent', 1]]);
  assert.ok(l[0].next_retry_at, 'a retry is scheduled');
  assert.match(l[0].error, /HTTP 503/);

  mail.failEmail = false;
  const early = await alerts.retryAlerts({ now: Date.now() });
  assert.equal(early.considered, 0, 'not before its retry time');
  const r = await alerts.retryAlerts({ now: Date.now() + 120000 });
  assert.equal(r.sent, 1);
  l = await log(j, c.id);
  assert.deepEqual(l.map((x) => [x.channel, x.status, x.attempts]), [['email', 'sent', 2], ['in_app', 'sent', 1]]);

  /* and the other way round: the inbox write fails, the email still goes */
  const j2 = await job({ title: 'Inbox Java Developer' });
  const cand = (await raw(`select * from candidates where id=$1`, [c.id])).rows[0];
  const jobRow = (await raw(`select j.*, co.name as company_name from jobs j join companies co on co.id=j.company_id where j.id=$1`, [j2])).rows[0];
  const out = await alerts.deliverAlert({
    event: 'urgent_hiring', job: jobRow, cand, score: 80,
    deps: { ...alerts.defaultDeps, sendInApp: async () => { throw new Error('inbox unavailable'); } },
  });
  assert.deepEqual(out, { in_app: 'failed', email: 'sent' });
  const r2 = await alerts.retryAlerts({ now: Date.now() + 120000 });
  assert.ok(r2.sent >= 1);
  assert.deepEqual((await log(j2, c.id)).map((x) => [x.channel, x.status]), [['email', 'sent'], ['in_app', 'sent']]);
});

test('teardown', async () => {
  server.close();
  mock.close();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
