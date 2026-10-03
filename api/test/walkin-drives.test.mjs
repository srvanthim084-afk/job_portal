/**
 * Walk-in drives (0099), end to end against a real Postgres with RLS on.
 *
 * Self-contained: makes its own company, two recruiters and the
 * candidates it needs. Nothing leaves the machine - email and SMS go to
 * the mock provider, WhatsApp to a closed port, and the assertions read
 * what the mock was handed and what walkin_notifications recorded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5469;
const API_PORT = 9989;
const MOCK_PORT = 9865;
const IST = 330 * 60000;

let dbh, server, mock, base, raw, walkin;

const istDay = (plus = 0) => new Date(Date.now() + IST + plus * 86400000).toISOString().slice(0, 10);
/** The instant of an IST wall-clock time on a 'YYYY-MM-DD'. */
const at = (date, hh, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST;
};

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Walkin123drive', phone,
    preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

async function staff(id, email, role = 'recruiter') {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  const u = await raw(`insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [email, hash, role]);
  if (role === 'recruiter') {
    await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,$3,$4,'co_w')`,
      [id, u.rows[0].id, `Recruiter ${id}`, email]);
  } else {
    await raw(`insert into admins (id, user_id, name, email) values ($1,$2,$3,$4)`, [id, u.rows[0].id, `Admin ${id}`, email]);
  }
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Staff123pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

const ledger = async (where = 'true', params = []) =>
  (await raw(`select candidate_id, kind, channel, status, dedupe_key from walkin_notifications where ${where} order by id`, params)).rows;

const drive = (over = {}) => ({
  title: 'Customer Support Walk-in',
  companyId: 'co_w',
  jobRole: 'Customer Support Executive',
  description: 'Freshers welcome.',
  driveDate: istDay(2),
  startTime: '10:00',
  endTime: '16:00',
  venueName: 'Hotel Grand',
  fullAddress: '12 Trunk Road, near Bus Stand',
  city: 'Nellore',
  mapLink: 'https://maps.google.com/?q=Hotel+Grand+Nellore',
  salaryRange: '₹1.8-2.4 LPA',
  experienceRequired: '0-2 yrs',
  qualification: 'Any degree',
  skills: ['Communication', 'Telugu', 'MS Excel'],
  documentsToCarry: ['Resume', 'Aadhaar card', 'Passport photo'],
  contactPersonName: 'Ravi',
  contactPhone: '9000011111',
  maxSeats: 2,
  ...over,
});

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'walkins@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AI_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_w', 'Nellore Services Pvt Ltd')`);
  const { createApp } = await import('../src/app.js');
  walkin = await import('../src/notify/walkin.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

let R1, R2, A, B, C, D1;

test('roles: anonymous 401, candidate cannot use recruiter routes, recruiter cannot register', async () => {
  R1 = await staff('rw1', 'rw1@tl-sink.local');
  R2 = await staff('rw2', 'rw2@tl-sink.local');
  A = await candidate('Asha Rao', 'asha.walkin@tl-sink.local', '9000000101');
  B = await candidate('Bala Krishna', 'bala.walkin@tl-sink.local', '9000000102');
  C = await candidate('Chitra Devi', 'chitra.walkin@tl-sink.local', '9000000103');

  const anon = makeClient(base);
  assert.equal((await anon.get('/api/walkin-drives')).status, 401);
  assert.equal((await anon.get('/api/recruiter/walkin-drives')).status, 401);
  assert.equal((await A.get('/api/recruiter/walkin-drives')).status, 403);
  assert.equal((await A.post('/api/recruiter/walkin-drives', drive())).status, 403);
  assert.equal((await R1.get('/api/walkin-drives')).status, 403);
  assert.equal((await R1.get('/api/my-walkin-registrations')).status, 403);
});

test('the backend validates a drive', async () => {
  const bad = [
    [{ driveDate: istDay(-1) }, /past/],
    [{ startTime: '16:00', endTime: '10:00' }, /end after it starts/],
    [{ mapLink: 'javascript:alert(1)' }, /https/],
    [{ title: '' }, /title/],
    [{ city: '' }, /city/i],
    [{ driveDate: '2026-02-30' }, /does not exist/],
    [{ maxSeats: 0 }, /seat/i],
    [{ contactPhone: 'call me' }, /phone/i],
    [{ unknownField: 1 }, /check/i],
  ];
  for (const [over, re] of bad) {
    const r = await R1.post('/api/recruiter/walkin-drives', drive(over));
    assert.equal(r.status, 400, `${JSON.stringify(over)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error.message, re, JSON.stringify(over));
  }
});

test('a recruiter creates a drive; another recruiter cannot see, edit or cancel it', async () => {
  const r = await R1.post('/api/recruiter/walkin-drives', drive());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  D1 = r.body.drive;
  assert.equal(D1.status, 'UPCOMING');
  assert.equal(D1.companyName, 'Nellore Services Pvt Ltd');
  assert.equal(D1.maxSeats, 2);
  assert.equal(D1.daysLeft, 2);

  assert.equal((await R1.get('/api/recruiter/walkin-drives')).body.drives.length, 1);
  assert.equal((await R2.get('/api/recruiter/walkin-drives')).body.drives.length, 0, 'R2 sees R1\'s drive');
  assert.equal((await R2.get(`/api/recruiter/walkin-drives/${D1.id}`)).status, 404);
  assert.equal((await R2.put(`/api/recruiter/walkin-drives/${D1.id}`, drive({ city: 'Hacked' }))).status, 404);
  assert.equal((await R2.del(`/api/recruiter/walkin-drives/${D1.id}`)).status, 404);
  assert.equal((await R2.get(`/api/recruiter/walkin-drives/${D1.id}/registrations`)).status, 404);
  const still = (await raw(`select city, status from walkin_drives where id = $1`, [D1.id])).rows[0];
  assert.deepEqual(still, { city: 'Nellore', status: 'UPCOMING' });
});

test('candidates list upcoming drives with filters, nearest first, and see a match where the role fits', async () => {
  await raw(`update candidates set title = 'Customer Support Executive', skills = '{Communication,Telugu}' where id = $1`, [A.id]);
  const later = await R1.post('/api/recruiter/walkin-drives', drive({
    title: 'Warehouse Picker Drive', jobRole: 'Warehouse Picker', driveDate: istDay(5), city: 'Ongole',
    skills: ['Forklift'], maxSeats: null,
  }));
  assert.equal(later.status, 201);

  const all = (await A.get('/api/walkin-drives')).body;
  assert.deepEqual(all.drives.map((d) => d.title), ['Customer Support Walk-in', 'Warehouse Picker Drive']);
  assert.ok(all.cities.includes('Ongole'));
  const cs = all.drives[0];
  assert.ok(cs.match && cs.match.score > 0, 'a matching role shows a match %');
  assert.deepEqual(cs.match.matchedSkills.map((x) => x.toLowerCase()).sort(), ['communication', 'telugu']);
  assert.equal(all.drives[1].match, null, 'no number for a role that does not fit');

  assert.equal((await A.get('/api/walkin-drives?city=ongole')).body.drives.length, 1);
  assert.equal((await A.get('/api/walkin-drives?role=support')).body.drives.length, 1);
  assert.equal((await A.get(`/api/walkin-drives?date=${istDay(5)}`)).body.drives[0].title, 'Warehouse Picker Drive');
  assert.equal((await A.get('/api/walkin-drives?q=forklift')).body.drives.length, 1);
  assert.equal((await A.get('/api/walkin-drives?q=Nellore%20Services')).body.drives.length, 2, 'keyword matches the company name');
  assert.equal((await A.get('/api/walkin-drives?city=Vizag')).body.drives.length, 0);

  const one = await A.get(`/api/walkin-drives/${D1.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.drive.documentsToCarry, ['Resume', 'Aadhaar card', 'Passport photo']);
  assert.equal(one.body.drive.myRegistration, null);
});

test('register: confirmation on every opted-in channel, no duplicates, no overbooking', async () => {
  const before = mock.received.length;
  const r = await A.post(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.registration.status, 'REGISTERED');
  assert.equal(r.body.drive.seatsTaken, 1);

  const dup = await A.post(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'WALKIN_ALREADY_REGISTERED');

  await walkin.settleWalkinNotifications();
  const rows = await ledger('candidate_id = $1', [A.id]);
  const by = Object.fromEntries(rows.filter((x) => x.kind === 'registered').map((x) => [x.channel, x.status]));
  assert.equal(by.portal, 'sent');
  assert.equal(by.email, 'sent');
  assert.equal(by.whatsapp, 'skipped_opted_out', 'WhatsApp needs an opt-in');
  // SMS goes in the daytime and waits for nobody at night; either way it is recorded truthfully
  assert.ok(['sent', 'skipped_quiet_hours'].includes(by.sms), by.sms);

  const mail = mock.received.slice(before).find((m) => m.url === '/email');
  assert.ok(mail, 'an email reached the provider');
  const body = JSON.stringify(mail.body);
  for (const s of ['Hotel Grand', 'Aadhaar card', '10:00 AM', 'Walk-in registration confirmed']) {
    assert.ok(body.includes(s), `email mentions ${s}`);
  }
  assert.ok(!/client/i.test(body), 'the word Client never reaches a candidate');

  const bell = (await raw(`select type, title, metadata from notifications where recipient_id = $1`, [A.id])).rows;
  assert.equal(bell.length, 1);
  assert.match(bell[0].type, /^WALKIN_REGISTERED#/);
  assert.equal(bell[0].metadata.driveId, D1.id);

  assert.equal((await B.post(`/api/walkin-drives/${D1.id}/register`)).status, 201);
  const full = await C.post(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'WALKIN_FULL');
});

test('cancel frees the seat; re-registering reuses the one row; each candidate sees only their own', async () => {
  const cancel = await A.del(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.registration.status, 'CANCELLED');
  assert.equal((await A.del(`/api/walkin-drives/${D1.id}/register`)).status, 409, 'nothing left to cancel');

  assert.equal((await C.post(`/api/walkin-drives/${D1.id}/register`)).status, 201, 'the freed seat is taken');
  const again = await A.post(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'WALKIN_FULL');

  const n = (await raw(`select count(*)::int n from walkin_registrations where drive_id = $1`, [D1.id])).rows[0].n;
  assert.equal(n, 3, 'one row per (drive, candidate)');

  const mineA = (await A.get('/api/my-walkin-registrations')).body;
  assert.equal(mineA.upcoming.length, 0);
  assert.equal(mineA.past.length, 1);
  assert.equal(mineA.past[0].myRegistration.status, 'CANCELLED');
  const mineB = (await B.get('/api/my-walkin-registrations')).body;
  assert.equal(mineB.upcoming.length, 1);
  assert.equal(mineB.upcoming[0].myRegistration.candidateId, B.id);

  // RLS, directly: B reading every registration gets only B's
  const { withUser } = await import('../src/db.js');
  const uid = (await raw(`select user_id from candidates where id = $1`, [B.id])).rows[0].user_id;
  const seen = await withUser({ userId: uid, role: 'candidate' },
    async (c) => (await c.query(`select candidate_id from walkin_registrations`)).rows);
  assert.deepEqual(seen.map((x) => x.candidate_id), [B.id]);
  const theirNotes = await withUser({ userId: uid, role: 'candidate' },
    async (c) => (await c.query(`select distinct candidate_id from walkin_notifications`)).rows);
  assert.ok(theirNotes.every((x) => x.candidate_id === B.id));
});

test('recruiter: registrations with search and status filter, attendance, CSV and Excel export', async () => {
  const list = await R1.get(`/api/recruiter/walkin-drives/${D1.id}/registrations`);
  assert.equal(list.status, 200);
  assert.equal(list.body.registrations.length, 3);
  assert.deepEqual(list.body.totals, { REGISTERED: 2, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 1 });
  assert.equal((await R1.get(`/api/recruiter/walkin-drives/${D1.id}/registrations?q=chitra`)).body.registrations.length, 1);
  assert.equal((await R1.get(`/api/recruiter/walkin-drives/${D1.id}/registrations?status=CANCELLED`)).body.registrations[0].name, 'Asha Rao');

  const reg = list.body.registrations.find((x) => x.name === 'Bala Krishna');
  const notYet = await fetchJson(R1, 'PATCH', `/api/recruiter/walkin-drives/${D1.id}/registrations/${reg.id}`, { status: 'ATTENDED' });
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.error.code, 'WALKIN_NOT_STARTED');

  const csv = await rawFetch(R1, `/api/recruiter/walkin-drives/${D1.id}/registrations/export?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.ok(text.includes('Bala Krishna') && text.includes('Chitra Devi') && text.includes('Asha Rao'));
  const xlsx = await rawFetch(R1, `/api/recruiter/walkin-drives/${D1.id}/registrations/export?format=xlsx&status=REGISTERED`);
  assert.equal(xlsx.status, 200);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'a real .xlsx (zip)');
  assert.equal((await rawFetch(R2, `/api/recruiter/walkin-drives/${D1.id}/registrations/export`)).status, 404);
  assert.equal((await rawFetch(A, `/api/recruiter/walkin-drives/${D1.id}/registrations/export`)).status, 403);

  // a drive running today: attendance can be marked
  const today = await R1.post('/api/recruiter/walkin-drives', drive({ title: 'Today Drive', driveDate: istDay(0), startTime: '00:00', endTime: '23:59', maxSeats: null }));
  assert.equal(today.status, 201, JSON.stringify(today.body));
  assert.equal(today.body.drive.status, 'ONGOING');
  assert.equal((await B.post(`/api/walkin-drives/${today.body.drive.id}/register`)).status, 201, 'register during an ongoing drive');
  const regs = (await R1.get(`/api/recruiter/walkin-drives/${today.body.drive.id}/registrations`)).body.registrations;
  const marked = await fetchJson(R1, 'PATCH', `/api/recruiter/walkin-drives/${today.body.drive.id}/registrations/${regs[0].id}`, { status: 'ATTENDED' });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.registration.status, 'ATTENDED');
  const bad = await fetchJson(R1, 'PATCH', `/api/recruiter/walkin-drives/${today.body.drive.id}/registrations/${regs[0].id}`, { status: 'CANCELLED' });
  assert.equal(bad.status, 400);
  const other = await fetchJson(R2, 'PATCH', `/api/recruiter/walkin-drives/${today.body.drive.id}/registrations/${regs[0].id}`, { status: 'NO_SHOW' });
  assert.equal(other.status, 404);
  assert.equal((await raw(`select status from walkin_registrations where id = $1`, [regs[0].id])).rows[0].status, 'ATTENDED');
});

test('the calendar file', async () => {
  const r = await rawFetch(B, `/api/walkin-drives/${D1.id}/calendar.ics`);
  assert.equal(r.status, 200);
  const ics = await r.text();
  assert.match(ics, /BEGIN:VCALENDAR/);
  const start = new Date(at(D1.driveDate, 10)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.ok(ics.includes(`DTSTART:${start}`), 'DTSTART is 10:00 IST in UTC');
  assert.match(ics, /LOCATION:Hotel Grand\\, 12 Trunk Road/);
});

test('an edit that matters is announced once to everyone still registered; a cosmetic one is not', async () => {
  const r = await R1.put(`/api/recruiter/walkin-drives/${D1.id}`, drive({ venueName: 'Hotel Grand Annexe' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.notified, true);
  assert.equal(r.body.drive.version, 2);
  await walkin.settleWalkinNotifications();
  const upd = (await ledger(`kind = 'updated' and channel = 'portal' and drive_id = $1`, [D1.id]));
  assert.deepEqual(upd.map((x) => x.candidate_id).sort(), [B.id, C.id].sort(), 'not the one who cancelled');

  const cosmetic = await R1.put(`/api/recruiter/walkin-drives/${D1.id}`, drive({ venueName: 'Hotel Grand Annexe', description: 'Bring a pen.' }));
  assert.equal(cosmetic.body.notified, false);
  assert.equal(cosmetic.body.drive.version, 2);

  const shrink = await R1.put(`/api/recruiter/walkin-drives/${D1.id}`, drive({ venueName: 'Hotel Grand Annexe', maxSeats: 1 }));
  assert.equal(shrink.status, 400, 'seats cannot go below the registrations');
});

test('reminders: the day before and the morning of, once each, quiet hours respected', async () => {
  const D = D1.driveDate;           // two days from today, IST
  const dayBefore = at(walkin.addDays(D, -1), 12);
  let r = await walkin.runWalkinSweep({ now: dayBefore });
  assert.equal(r.dayBefore, 2, JSON.stringify(r));
  r = await walkin.runWalkinSweep({ now: dayBefore + 3600000 });
  assert.equal(r.dayBefore, 0, 'never twice');

  const morning = at(D, 7, 30);
  r = await walkin.runWalkinSweep({ now: morning });
  assert.equal(r.morning, 2);
  const sms = await ledger(`kind = 'reminder_morning' and channel = 'sms'`);
  assert.ok(sms.length && sms.every((x) => x.status === 'skipped_quiet_hours'), '07:30 IST is quiet hours for SMS');
  const mail = await ledger(`kind = 'reminder_morning' and channel = 'email'`);
  assert.ok(mail.every((x) => x.status === 'sent'));
  assert.equal((await ledger(`kind like 'reminder%' and candidate_id = $1`, [A.id])).length, 0, 'a cancelled registration gets no reminder');
});

test('past drives: hidden from the list, closed for registration, and marked COMPLETED by the sweep', async () => {
  await raw(`insert into walkin_drives (id, title, job_role, drive_date, start_time, end_time, venue_name, full_address,
               city, created_by_recruiter_id, status)
             values ('wd_past', 'Old Drive', 'Helper', $1::date, '09:00', '12:00', 'Old Hall', 'Somewhere road', 'Nellore', 'rw1', 'UPCOMING')`,
  [istDay(-1)]);
  assert.ok(!(await A.get('/api/walkin-drives')).body.drives.some((d) => d.id === 'wd_past'));
  const reg = await A.post('/api/walkin-drives/wd_past/register');
  assert.equal(reg.status, 409);
  assert.equal(reg.body.error.code, 'WALKIN_CLOSED');
  const sweep = await walkin.runWalkinSweep();
  assert.ok(sweep.statusChanged >= 1);
  assert.equal((await raw(`select status from walkin_drives where id = 'wd_past'`)).rows[0].status, 'COMPLETED');
  const edit = await R1.put('/api/recruiter/walkin-drives/wd_past', drive({ driveDate: istDay(3) }));
  assert.equal(edit.status, 409, 'a completed drive is not edited');
});

test('cancelling a drive tells everyone registered, closes it, and keeps it in My Registrations', async () => {
  const r = await R1.del(`/api/recruiter/walkin-drives/${D1.id}?reason=Venue%20unavailable`);
  assert.equal(r.status, 200);
  assert.equal(r.body.drive.status, 'CANCELLED');
  await walkin.settleWalkinNotifications();
  const rows = await ledger(`kind = 'cancelled' and channel = 'email' and drive_id = $1`, [D1.id]);
  assert.deepEqual(rows.map((x) => x.candidate_id).sort(), [B.id, C.id].sort());
  const mail = mock.received.filter((m) => m.url === '/email' && JSON.stringify(m.body).includes('has been cancelled'));
  assert.ok(mail.length >= 2 && JSON.stringify(mail[0].body).includes('Venue unavailable'));

  assert.ok(!(await B.get('/api/walkin-drives')).body.drives.some((d) => d.id === D1.id));
  const mine = (await B.get('/api/my-walkin-registrations')).body;
  assert.ok(mine.past.some((d) => d.id === D1.id && d.status === 'CANCELLED'));
  const late = await C.del(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(late.status, 200, 'cancelling a registration on a cancelled drive is harmless');
  const reg = await A.post(`/api/walkin-drives/${D1.id}/register`);
  assert.equal(reg.status, 409);
  // a candidate who never registered cannot open a cancelled drive at all
  const stranger = await candidate('Dev Kumar', 'dev.walkin@tl-sink.local', '9000000104');
  assert.equal((await stranger.get(`/api/walkin-drives/${D1.id}`)).status, 404);

  const n0 = (await ledger(`kind like 'reminder%' and drive_id = $1`, [D1.id])).length;
  await walkin.runWalkinSweep({ now: at(D1.driveDate, 8) });
  await walkin.runWalkinSweep({ now: at(walkin.addDays(D1.driveDate, -1), 15) });
  assert.equal((await ledger(`kind like 'reminder%' and drive_id = $1`, [D1.id])).length, n0,
    'no reminders for a cancelled drive');
});

test('admin sees every drive', async () => {
  const admin = await staff('aw1', 'aw1@tl-sink.local', 'admin');
  const all = (await admin.get('/api/recruiter/walkin-drives')).body.drives;
  assert.ok(all.length >= 3);
});

test('shutdown', async () => {
  await walkin.settleWalkinNotifications();
  const { closePool } = await import('../src/db.js');
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  await new Promise((r) => server.close(r));
  await closePool();
  await mock.stop();
  await dbh.stop();
});

/* ------------------------------------------------------------------ */

async function fetchJson(client, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const jar = client.jar;
  headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar.has('tl_csrf')) headers['x-csrf-token'] = jar.get('tl_csrf');
  const res = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function rawFetch(client, path) {
  const jar = client.jar;
  return fetch(base + path, { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
}
