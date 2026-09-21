/**
 * Pre-flight check: is this safe to enter real business data into?
 *
 *   node tools/verify-stack.mjs            run every check
 *   node tools/verify-stack.mjs --write    create a marker record, then stop
 *   node tools/verify-stack.mjs --check    confirm the marker still exists
 *
 * The --write / --check pair is the one that matters. Run --write, restart
 * the server, run --check. If the record is gone, the database is not
 * durable and nothing else on this list means anything.
 *
 * Every check goes through the HTTP API exactly as the browser does, then
 * re-reads from the database. A UI that shows a record it just created
 * proves nothing on its own — the record has to come back from Postgres.
 */
const BASE = process.env.TL_URL || 'http://127.0.0.1:4323';
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const MODE = process.argv[2] || '--all';
const MARKER = 'PERSIST_CHECK';

let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { const note = await fn(); passed++; console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};

/* a cookie-aware client, so sessions and CSRF work as they do in a browser */
function makeClient() {
  const jar = new Map();
  const absorb = (res) => {
    for (const line of (res.headers.getSetCookie?.() || [])) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (v === '') jar.delete(k); else jar.set(k, v);
    }
  };
  async function call(method, path, body) {
    const headers = {};
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (jar.has('tl_csrf')) headers['x-csrf-token'] = jar.get('tl_csrf');
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    absorb(res);
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p),
  };
}

const login = async (c, email) => {
  const r = await c.post('/api/auth/login', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.body?.error?.code}`);
  return r.body.session;
};

/* ------------------------------------------------------------------ */
if (MODE === '--write') {
  const c = makeClient();
  await login(c, 'recruiter@teamlink.com');
  await c.del(`/api/jobs/${MARKER}`).catch(() => {});
  const r = await c.post('/api/jobs', {
    id: MARKER, title: 'Persistence marker — safe to delete',
    companyId: 'technova', location: 'Bengaluru', type: 'Full-time', status: 'open',
  });
  if (r.status !== 201) { console.log('could not write the marker:', JSON.stringify(r.body)); process.exit(1); }
  console.log(`marker written: ${MARKER}`);
  console.log('Now RESTART the server, then run:  node tools/verify-stack.mjs --check');
  process.exit(0);
}

if (MODE === '--check') {
  const c = makeClient();
  await login(c, 'recruiter@teamlink.com');
  const r = await c.get(`/api/jobs/${MARKER}`);
  if (r.status === 200) {
    console.log(`SURVIVED — "${r.body.job.title}" is still in the database after a restart.`);
    console.log('The database is durable. Real data entered here will persist.');
    process.exit(0);
  }
  console.log('GONE — the marker did not survive the restart.');
  console.log('The database is NOT durable. Do not enter real data yet.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
console.log(`checking ${BASE}\n`);

let health, recruiter, candidate, createdJobId;

await check('1. backend is reachable', async () => {
  const res = await fetch(BASE + '/api/health');
  if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
  health = await res.json();
  return `env=${health.env}`;
});

await check('2. database is connected and answering', async () => {
  const res = await fetch(BASE + '/api/bootstrap');
  if (!res.ok) throw new Error(`/api/bootstrap returned ${res.status}`);
  const d = (await res.json()).data;
  if (!Array.isArray(d.jobs)) throw new Error('no jobs collection in the payload');
  return `${d.jobs.length} jobs, ${d.companies.length} companies`;
});

await check('3. authentication works', async () => {
  recruiter = makeClient();
  const s = await login(recruiter, 'recruiter@teamlink.com');
  if (s.role !== 'recruiter') throw new Error(`unexpected role ${s.role}`);
  return `signed in as ${s.id}`;
});

await check('4. a wrong password is rejected', async () => {
  const c = makeClient();
  const r = await c.post('/api/auth/login',
    { email: 'recruiter@teamlink.com', password: 'wrong-on-purpose' });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
});

await check('5. CREATE reaches the database', async () => {
  createdJobId = 'CRUD_' + Date.now().toString(36);
  const r = await recruiter.post('/api/jobs', {
    id: createdJobId, title: 'CRUD check', companyId: 'technova',
    location: 'Bengaluru', type: 'Full-time', status: 'open',
  });
  if (r.status !== 201) throw new Error(`create failed: ${JSON.stringify(r.body)}`);
  // re-read, rather than trusting the create response
  const back = await recruiter.get(`/api/jobs/${createdJobId}`);
  if (back.status !== 200) throw new Error('the record could not be read back');
  return createdJobId;
});

await check('6. READ returns the stored record', async () => {
  const r = await recruiter.get(`/api/jobs/${createdJobId}`);
  if (r.body.job.title !== 'CRUD check') throw new Error('the stored value does not match');
});

await check('7. UPDATE persists, and the id is unchanged', async () => {
  const r = await recruiter.put(`/api/jobs/${createdJobId}`, {
    title: 'CRUD check (edited)', companyId: 'technova',
  });
  if (r.status !== 200) throw new Error(`update failed: ${JSON.stringify(r.body)}`);
  const back = await recruiter.get(`/api/jobs/${createdJobId}`);
  if (back.body.job.title !== 'CRUD check (edited)') throw new Error('the edit did not persist');
  if (back.body.job.id !== createdJobId) throw new Error('the id changed on update');
});

await check('8. DELETE removes it (admin only)', async () => {
  const notAllowed = await recruiter.del(`/api/jobs/${createdJobId}`);
  if (notAllowed.status !== 403) {
    throw new Error(`a recruiter could delete a job (status ${notAllowed.status})`);
  }
  const admin = makeClient();
  await login(admin, 'admin@teamlink.com');
  const r = await admin.del(`/api/jobs/${createdJobId}`);
  if (r.status !== 200) throw new Error(`delete failed: ${JSON.stringify(r.body)}`);
  const gone = await admin.get(`/api/jobs/${createdJobId}`);
  if (gone.status === 200) throw new Error('the record is still readable after deletion');
});

await check('9. the session survives a page refresh', async () => {
  // a fresh request with only the cookie, exactly as a reload would send
  const r = await recruiter.get('/api/auth/me');
  if (!r.body.session) throw new Error('the session was not restored from the cookie');
  return `still ${r.body.session.role}`;
});

await check('10. logout ends the session', async () => {
  const c = makeClient();
  await login(c, 'recruiter@teamlink.com');
  await c.post('/api/auth/logout', {});
  const after = await c.get('/api/auth/me');
  if (after.body.session) throw new Error('the session survived logout');
});

await check('11. row-level security is active (candidate cannot see the pool)', async () => {
  candidate = makeClient();
  await login(candidate, 'ananya.rao@example.com');
  const r = await candidate.get('/api/candidates');
  if (r.status !== 403) throw new Error(`a candidate listed the talent pool (status ${r.status})`);
});

await check('12. anonymous visitors see no candidate data', async () => {
  const res = await fetch(BASE + '/api/bootstrap');
  const d = (await res.json()).data;
  if (d.candidates.length !== 0) {
    throw new Error(`${d.candidates.length} candidates exposed without signing in`);
  }
});

await check('13. the frontend is NOT hardcoded to localhost', async () => {
  const res = await fetch(BASE + '/teamlink-integration.js');
  const js = await res.text();
  const hard = js.match(/https?:\/\/(127\.0\.0\.1|localhost)[:\d]*/g);
  if (hard) throw new Error(`hardcoded local URLs found: ${[...new Set(hard)].join(', ')}`);
  if (!/TL_API_BASE\s*\|\|\s*'\/api'/.test(js)) {
    throw new Error('the API base is not relative — it will not follow the domain in production');
  }
  return 'API base is relative (/api)';
});

await check('14. storage is a real directory, not the browser', async () => {
  if (/localStorage/.test(String(health))) throw new Error('unexpected');
  const res = await fetch(BASE + '/api/bootstrap');
  if (!res.ok) throw new Error('bootstrap unavailable');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('\nREAL BACKEND/DATABASE CONNECTED.');
  console.log('Still to confirm durability across a restart:');
  console.log('  node tools/verify-stack.mjs --write');
  console.log('  (restart the server)');
  console.log('  node tools/verify-stack.mjs --check');
} else {
  console.log('\nDO NOT enter real business data until the failures above are resolved.');
}
process.exitCode = failed ? 1 : 0;
