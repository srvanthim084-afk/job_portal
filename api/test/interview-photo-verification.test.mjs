/**
 * AI interview: the photo verification that must come first (0149), against a real Postgres with RLS.
 *
 *   1  no photo, no interview: the SERVER refuses to start a session without a ready verification, and
 *      creates nothing (no interview row, no questions)
 *   2  the steps are enforced in order: photo -> confirm -> instructions + consent
 *   3  the instructions and the consent are both required, against the current notice version
 *   4  a retake replaces the unconfirmed photo (the old file is deleted) and restarts the confirmation
 *   5  invalid uploads (not a photo, too large) are refused; somebody else's verification cannot be written to
 *   6  one verification starts ONE session: a second click / a parallel request gets the same interview
 *   7  the photo is private and encrypted: only its owner and an authorised recruiter can open it, staff views
 *      are audited, nothing exposes the storage key, the stored file is not a readable image
 *   8  camera unavailable: the candidate asks for help, a recruiter of that application can waive the photo
 *   9  retention: the image is deleted when its time is up, the record stays, the photo then answers 410
 *  10  a verification that waited too long no longer starts anything; an interview already under way carries on
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5690;
const API_PORT = 9962;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'PhotoVerify123interview';

let dbh, server, raw, storage, retention, verification;
let recA, recB;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(3500, 9)]);

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, await hashPassword(PW), role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`,
    [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
let phone = 9500000100;
async function candidate(name) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email: `${name.replace(/\W/g, '').toLowerCase()}.pv@tl-sink.local`, password: PW, phone: String(phone++),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.appId = (await c.post('/api/applications', { jobId: 'j_pv1' })).body.application.id;
  return c;
}
const form = (fields, file, name = 'photo', type = 'image/jpeg', filename = 'me.jpg') => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append(name, new Blob([file], { type }), filename);
  return fd;
};
const start = (c) => c.post('/api/ai-interviews/verification/start', { applicationId: c.appId });
const upload = (c, vid, buf, type, filename) => c.post('/api/ai-interviews/verification/photo',
  form({ verificationId: vid }, buf, 'photo', type, filename));
const session = (c) => c.post('/api/ai-interviews/session', { applicationId: c.appId });
const vrow = async (id) => (await raw(`select * from ai_interview_verifications where id=$1`, [id])).rows[0];
const interviews = async (appId) => (await raw(`select * from ai_interviews where application_id=$1`, [appId])).rows;
/** a fully verified candidate, ready to start */
async function ready(c) {
  const s = await start(c);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const vid = s.body.verification.id;
  assert.equal((await upload(c, vid, JPEG, 'image/jpeg', 'me.jpg')).status, 201);
  assert.equal((await c.post(`/api/ai-interviews/verification/${vid}/confirm`, {})).status, 200);
  const k = await c.post(`/api/ai-interviews/verification/${vid}/consent`,
    { instructionsAcknowledged: true, consent: true, noticeVersion: verification.NOTICE_VERSION });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  assert.equal(k.body.verification.status, 'ready');
  return vid;
}
const rawGet = async (c, path) => {
  const cookie = [...c.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + path, { headers: { cookie } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    INTERVIEW_PHOTO_VERIFICATION: 'on', INTERVIEW_PHOTO_MAX_BYTES: '60000', INTERVIEW_IMAGE_RETENTION_DAYS: '30',
    SUPPORT_EMAIL: 'support@tl-sink.local',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_pv1', 'Photo Co'), ('co_pv2', 'Other Co')`);
  const { createApp } = await import('../src/app.js');
  storage = (await import('../src/storage.js')).getStorage();
  retention = await import('../src/interview/verification-retention.js');
  verification = await import('../src/interview/verification.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  recA = await staff('rec.pv1@tl-sink.local', 'recruiter', 'recruiters', 'r_pv1', 'co_pv1');
  recB = await staff('rec.pv2@tl-sink.local', 'recruiter', 'recruiters', 'r_pv2', 'co_pv2');
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_pv1', 'HR Recruiter', 'co_pv1', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_pv1', $2, now())`,
    [['Sourcing', 'ATS', 'Excel'], 'Own end-to-end hiring for client roles.']);
});

let A, vidA, photoPathA;
test('1. no photo, no interview: the server refuses and creates nothing', async () => {
  A = await candidate('Anita Photo');
  const r = await session(A);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error?.code || r.body.code, 'VERIFICATION_REQUIRED');
  assert.deepEqual((await interviews(A.appId)).length, 0, 'no interview row');
  assert.equal((await raw(`select count(*)::int n from ai_interview_answers where ai_interview_id in
    (select id from ai_interviews where candidate_id=$1)`, [A.id])).rows[0].n, 0, 'no questions were generated');
  // starting the verification is not starting the interview
  const s = await start(A);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  vidA = s.body.verification.id;
  assert.equal(s.body.verification.step, 'capture');
  assert.equal(s.body.job.title, 'HR Recruiter');
  assert.equal(s.body.interview.questions, 15);
  assert.ok(s.body.notice.version && s.body.notice.points.length >= 6 && s.body.instructions.length >= 7);
  assert.match(s.body.notice.contact, /support@tl-sink\.local/);
  assert.equal((await session(A)).status, 403);
  assert.equal((await interviews(A.appId)).length, 0);
});

test('2. the steps run in order: photo -> confirm -> instructions + consent', async () => {
  // confirming or consenting with no photo is refused
  assert.equal((await A.post(`/api/ai-interviews/verification/${vidA}/confirm`, {})).status, 409);
  const early = await A.post(`/api/ai-interviews/verification/${vidA}/consent`,
    { instructionsAcknowledged: true, consent: true, noticeVersion: verification.NOTICE_VERSION });
  assert.equal(early.status, 409);

  const up = await upload(A, vidA, JPEG, 'image/jpeg', 'me.jpg');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.verification.status, 'photo_captured');
  assert.equal(up.body.verification.step, 'review');
  const r1 = await session(A);
  assert.equal(r1.status, 403);
  assert.equal(r1.body.error?.details?.step || r1.body.details?.step, 'confirm');

  const cf = await A.post(`/api/ai-interviews/verification/${vidA}/confirm`, {});
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  assert.equal(cf.body.verification.step, 'instructions');
  const r2 = await session(A);
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error?.details?.step || r2.body.details?.step, 'instructions');
  assert.equal((await interviews(A.appId)).length, 0);
});

test('3. both the instructions and the consent are required, against the current notice', async () => {
  const body = (o) => ({ instructionsAcknowledged: true, consent: true, noticeVersion: verification.NOTICE_VERSION, ...o });
  assert.equal((await A.post(`/api/ai-interviews/verification/${vidA}/consent`, body({ instructionsAcknowledged: false }))).status, 409);
  assert.equal((await A.post(`/api/ai-interviews/verification/${vidA}/consent`, body({ consent: false }))).status, 409);
  const old = await A.post(`/api/ai-interviews/verification/${vidA}/consent`, body({ noticeVersion: '1999-01-01' }));
  assert.equal(old.status, 409);
  assert.equal(old.body.error?.code || old.body.code, 'NOTICE_CHANGED');
  assert.equal((await session(A)).status, 403, 'still not ready');
  assert.notEqual((await vrow(vidA)).status, 'ready');
});

test('4. a retake replaces the unconfirmed photo and restarts the confirmation', async () => {
  const before = await vrow(vidA);
  assert.equal(before.status, 'photo_confirmed');
  const up = await upload(A, vidA, JPEG2, 'image/jpeg', 'again.jpg');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const after = await vrow(vidA);
  assert.notEqual(after.image_path, before.image_path, 'a new file');
  await assert.rejects(storage.get(before.image_path), undefined, 'the replaced file was deleted');
  assert.equal(after.status, 'photo_captured', 'back to review');
  assert.equal(after.image_confirmed_at, null);
  assert.equal(after.image_replaced_count, 1);
  assert.equal((await session(A)).status, 403);
  photoPathA = after.image_path;
});

test('5. invalid uploads are refused; another candidate cannot write to this verification', async () => {
  const txt = await upload(A, vidA, Buffer.from('this is not a photo at all, just text'), 'image/jpeg', 'me.jpg');
  assert.equal(txt.status, 415, JSON.stringify(txt.body));
  const big = await upload(A, vidA, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(70000, 1)]), 'image/jpeg', 'big.jpg');
  assert.equal(big.status, 413, JSON.stringify(big.body));
  assert.equal((await vrow(vidA)).image_path, photoPathA, 'the good photo is untouched by the refused ones');
  // a PHP file renamed .jpg is still not a photo
  assert.equal((await upload(A, vidA, Buffer.from('<?php echo 1; ?>'), 'image/jpeg', 'x.jpg')).status, 415);

  const B = await candidate('Bharat Photo');
  const steal = await upload(B, vidA, JPEG, 'image/jpeg', 'me.jpg');
  assert.equal(steal.status, 404, JSON.stringify(steal.body));
  assert.equal((await B.post(`/api/ai-interviews/verification/${vidA}/confirm`, {})).status, 404);
  assert.equal((await B.post(`/api/ai-interviews/verification/${vidA}/consent`,
    { instructionsAcknowledged: true, consent: true, noticeVersion: verification.NOTICE_VERSION })).status, 404);
  assert.equal((await vrow(vidA)).image_path, photoPathA);
  // and B cannot start A's application
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.post('/api/ai-interviews/verification/start', { applicationId: A.appId })).status, 401);
  assert.equal((await B.post('/api/ai-interviews/verification/start', { applicationId: A.appId })).status, 404);
});

test('6. one verification starts ONE session, however many clicks', async () => {
  assert.equal((await A.post(`/api/ai-interviews/verification/${vidA}/confirm`, {})).status, 200);
  const k = await A.post(`/api/ai-interviews/verification/${vidA}/consent`,
    { instructionsAcknowledged: true, consent: true, noticeVersion: verification.NOTICE_VERSION });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  const v = await vrow(vidA);
  assert.equal(v.status, 'ready');
  assert.ok(v.consent_at && v.instructions_ack_at && v.image_confirmed_at && v.verified_at);
  assert.equal(v.notice_version, verification.NOTICE_VERSION);

  const [s1, s2, s3] = await Promise.all([session(A), session(A), session(A)]);
  const created = [s1, s2, s3].filter((x) => x.status === 201);
  assert.equal(created.length, 1, JSON.stringify([s1.status, s2.status, s3.status]));
  assert.ok([s1, s2, s3].every((x) => x.status === 201 || x.status === 200));
  const ids = new Set([s1, s2, s3].map((x) => x.body.interviewId));
  assert.equal(ids.size, 1, 'everybody got the same interview');
  const ivs = await interviews(A.appId);
  assert.equal(ivs.length, 1, 'one interview row');
  const after = await vrow(vidA);
  assert.equal(after.status, 'used');
  assert.equal(after.interview_id, ivs[0].id);
  assert.equal(ivs[0].verification_id, vidA);
  assert.ok(after.session_started_at);
  // the audit trail: started .. session_authorized, with ids only
  const acts = (await raw(`select action, detail from ai_interview_audit where candidate_id=$1 and action like 'verification.%' order by id`, [A.id])).rows;
  for (const a of ['verification.started', 'verification.photo_captured', 'verification.photo_confirmed', 'verification.ready', 'verification.session_authorized']) {
    assert.ok(acts.some((x) => x.action === a), `${a} is in the audit log`);
  }
  assert.doesNotMatch(JSON.stringify(acts), /interview-verification\/|\.bin|image\/jpeg/, 'no storage key or file detail in the log');
  // a refresh / the page asking again: the SAME interview, still no second one
  const again = await session(A);
  assert.equal(again.status, 200);
  assert.equal(again.body.interviewId, ivs[0].id);
  assert.equal((await interviews(A.appId)).length, 1);
  // starting the verification once an interview is under way: nothing to verify
  const st = await start(A);
  assert.equal(st.status, 200);
  assert.equal(st.body.required, false);
  assert.equal(st.body.resume, true);
});

test('7. the photo is private and encrypted: owner and the right recruiter only, staff views are audited', async () => {
  const v = await vrow(vidA);
  const stored = await storage.get(v.image_path);
  assert.equal(stored.subarray(0, 4).toString('latin1'), 'TLP1', 'sealed, not a plain image');
  assert.notEqual(stored[0], 0xff, 'not a readable JPEG on disk');
  assert.equal(stored.includes(JPEG2.subarray(10, 400)), false);

  const own = await rawGet(A, `/api/ai-interviews/verification/${vidA}/photo`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.match(own.headers.get('cache-control'), /no-store/);
  assert.ok(own.bytes.equals(JPEG2), 'the candidate gets exactly the photo they confirmed');

  const B2 = await candidate('Chandra Photo');
  assert.equal((await rawGet(B2, `/api/ai-interviews/verification/${vidA}/photo`)).status, 404, 'another candidate');
  assert.equal((await rawGet(recB, `/api/ai-interviews/verification/${vidA}/photo`)).status, 404, "another company's recruiter");
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await rawGet(anon, `/api/ai-interviews/verification/${vidA}/photo`)).status, 401, 'nobody signed in');

  const before = (await raw(`select count(*)::int n from ai_interview_audit where action='verification.photo_viewed'`)).rows[0].n;
  const staffView = await rawGet(recA, `/api/ai-interviews/verification/${vidA}/photo`);
  assert.equal(staffView.status, 200);
  assert.ok(staffView.bytes.equals(JPEG2));
  assert.equal((await raw(`select count(*)::int n from ai_interview_audit where action='verification.photo_viewed'`)).rows[0].n, before + 1);

  // the record the recruiter sees names the photo by an authenticated route, never a storage key
  const rec = await recA.get(`/api/ai-interviews/verification/by-application/${A.appId}`);
  assert.equal(rec.status, 200);
  assert.match(rec.body.verifications[0].photoUrl, /^\/api\/ai-interviews\/verification\/.+\/photo$/);
  assert.doesNotMatch(JSON.stringify(rec.body), /interview-verification\/|image_path|\.bin/);
  assert.equal(rec.body.verifications[0].consentGiven, true);
  assert.equal((await recB.get(`/api/ai-interviews/verification/by-application/${A.appId}`)).body.verifications.length, 0, 'another company sees nothing');
});

test('8. camera unavailable: the candidate asks for help, an authorised recruiter can waive the photo', async () => {
  const C = await candidate('Divya Photo');
  const s = await start(C);
  const vid = s.body.verification.id;
  const help = await C.post(`/api/ai-interviews/verification/${vid}/camera-help`, { note: 'My laptop camera is broken' });
  assert.equal(help.status, 200, JSON.stringify(help.body));
  assert.equal(help.body.supportEmail, 'support@tl-sink.local');
  assert.ok((await raw(`select 1 from ai_interview_audit where action='verification.camera_help_requested' and candidate_id=$1`, [C.id])).rows.length);

  // a candidate cannot waive; another company's recruiter cannot see the application; the owner can
  assert.equal((await C.post('/api/ai-interviews/verification/waive', { applicationId: C.appId, reason: 'camera broken' })).status, 403);
  assert.equal((await recB.post('/api/ai-interviews/verification/waive', { applicationId: C.appId, reason: 'camera broken' })).status, 404);
  assert.equal((await recA.post('/api/ai-interviews/verification/waive', { applicationId: C.appId, reason: '' })).status, 400);
  const w = await recA.post('/api/ai-interviews/verification/waive', { applicationId: C.appId, reason: 'Camera broken, confirmed by phone' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal(w.body.verification.method, 'staff_waiver');
  assert.equal((await session(C)).status, 403, 'the instructions still have to be acknowledged');

  // the candidate carries on: the photo step is skipped, the instructions are still acknowledged
  const s2 = await start(C);
  assert.equal(s2.body.verification.method, 'staff_waiver');
  assert.equal(s2.body.verification.step, 'instructions');
  const wid = s2.body.verification.id;
  assert.equal((await upload(C, wid, JPEG, 'image/jpeg', 'me.jpg')).status, 409, 'no photo is taken for a waived verification');
  assert.equal((await C.post(`/api/ai-interviews/verification/${wid}/consent`,
    { instructionsAcknowledged: false, consent: false, noticeVersion: verification.NOTICE_VERSION })).status, 409);
  const ok = await C.post(`/api/ai-interviews/verification/${wid}/consent`,
    { instructionsAcknowledged: true, consent: false, noticeVersion: verification.NOTICE_VERSION });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verification.consentGiven, false, 'no image consent is invented when there is no image');
  assert.equal((await session(C)).status, 201);
  assert.ok((await raw(`select 1 from ai_interview_audit where action='verification.photo_waived' and actor_role='recruiter'`)).rows.length);
});

test('9. retention: the image is deleted when its time is up, the record stays', async () => {
  const v = await vrow(vidA);
  const path = v.image_path;
  assert.ok(path);
  assert.ok(new Date(v.retention_until) > new Date(Date.now() + 29 * 86400000), 'kept for the configured 30 days');
  assert.equal((await retention.runVerificationRetention()).removed, 0, 'not due yet');
  await raw(`update ai_interview_verifications set retention_until = now() - interval '1 minute' where id=$1`, [vidA]);
  const run = await retention.runVerificationRetention();
  assert.equal(run.removed, 1, JSON.stringify(run));
  await assert.rejects(storage.get(path), undefined, 'the file is gone');
  const after = await vrow(vidA);
  assert.equal(after.image_path, null);
  assert.ok(after.image_deleted_at);
  assert.equal(after.status, 'used', 'the record of what was agreed stays');
  assert.ok(after.consent_at);
  assert.equal((await rawGet(A, `/api/ai-interviews/verification/${vidA}/photo`)).status, 410);
  assert.ok((await raw(`select 1 from ai_interview_audit where action='verification.photo_deleted'`)).rows.length);
  assert.equal((await retention.runVerificationRetention()).removed, 0, 'once');
});

test('10. a verification that waited too long starts nothing; an interview under way carries on', async () => {
  const D = await candidate('Esha Photo');
  const vid = await ready(D);
  await raw(`update ai_interview_verifications set verified_at = now() - interval '4 hours' where id=$1`, [vid]);
  const late = await session(D);
  assert.equal(late.status, 403, JSON.stringify(late.body));
  assert.equal((await interviews(D.appId)).length, 0);

  // an interview created before verification existed (or while it was off) is handed back, not refused
  const E = await candidate('Farah Photo');
  process.env.INTERVIEW_PHOTO_VERIFICATION = 'off';
  const open = await session(E);
  assert.equal(open.status, 201);
  process.env.INTERVIEW_PHOTO_VERIFICATION = 'on';
  const back = await session(E);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.interviewId, open.body.interviewId);
  assert.equal((await interviews(E.appId)).length, 1);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
