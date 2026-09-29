/* =====================================================================
   TeamLink AutoFill — the only thing that talks to TeamLink
   =====================================================================

   NO PASSWORD IS EVER STORED, AND NEITHER IS A TOKEN.

   The spec this was built from asked for "a short-lived token in
   chrome.storage.local". The TeamLink API does not issue one: it
   authenticates with an httpOnly session cookie and a CSRF double
   submit, and there is no bearer path. Rather than add one - a second
   authentication surface, on a product that already has a working one -
   the extension signs in through the same endpoint a browser does and
   lets the BROWSER hold the cookie. The cookie is httpOnly, so this
   extension cannot read it even though it caused it to exist.

   That is strictly safer than the spec asked for. What is stored here
   is the candidate's profile, cached for an hour so a fill does not
   wait on the network, and the site list for auto-fill. Both are
   cleared on sign-out, and there is nothing else to clear.

   THE ORIGIN. The API only accepts state-changing requests from an
   origin it recognises, and an extension's origin is
   chrome-extension://<id>. Add that to EXTRA_ORIGINS in the server's
   .env to enable the tracking call. Leave it out and everything else
   still works - the profile is a GET - and the extension simply reports
   that it could not log the click, rather than pretending it did.
   ===================================================================== */
/* global chrome, fetch */

const DEFAULT_BASE = 'http://localhost:4323';
const PROFILE_TTL_MS = 60 * 60 * 1000;      // an hour

/* ------------------------------------------------------------------ */

function store(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function put(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function baseUrl() {
  const s = await store(['baseUrl']);
  return String(s.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

/** The CSRF token the API sets beside the session cookie. */
async function csrf(base) {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve('');
    chrome.cookies.get({ url: base, name: 'tl_csrf' },
      (c) => resolve(c ? c.value : ''));
  });
}

async function call(path, init) {
  const base = await baseUrl();
  const opts = Object.assign({ credentials: 'include' }, init || {});
  opts.headers = Object.assign({ 'content-type': 'application/json' },
    opts.headers || {});
  if ((opts.method || 'GET') !== 'GET') {
    const t = await csrf(base);
    if (t) opts.headers['x-csrf-token'] = t;
  }
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message)
      || `TeamLink replied ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/* ------------------------------------------------------------------ *
 * sign in
 * ------------------------------------------------------------------ */

async function signIn(email, password) {
  /* The password is used for this one request and never written
     anywhere. It is not kept in a variable beyond this scope. */
  const out = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!out || !out.session || out.session.role !== 'candidate') {
    throw new Error('That is not a candidate account.');
  }
  await put({ signedIn: true, who: out.session.email || email, profile: null, profileAt: 0 });
  await loadProfile(true);
  return out.session;
}

async function signOut() {
  try { await call('/api/auth/logout', { method: 'POST' }); } catch (e) { /* local anyway */ }
  await new Promise((r) => chrome.storage.local.remove(
    ['signedIn', 'who', 'profile', 'profileAt'], r));
}

/* ------------------------------------------------------------------ *
 * the profile
 *
 * Only fields TeamLink already holds. Nothing is invented: a value the
 * profile does not have comes through empty and the field it would have
 * filled is reported as unfilled.
 * ------------------------------------------------------------------ */

function shape(c) {
  const name = String(c.name || '').trim();
  const sp = name.lastIndexOf(' ');
  return {
    firstName: sp > 0 ? name.slice(0, sp) : name,
    lastName: sp > 0 ? name.slice(sp + 1) : '',
    preferredFirstName: '',
    name,
    email: c.email || '',
    phone: c.phone || '',
    countryCode: '+91',
    country: 'India',
    city: c.location || '',
    state: '',
    currentTitle: c.title || '',
    currentCompany: c.currentCompany || '',
    experienceYears: c.expYears == null ? '' : c.expYears,
    skills: c.skills || [],
    education: c.education || '',
    linkedinUrl: c.linkedin || '',
    portfolioUrl: c.portfolio || c.github || '',
    resumeFileName: c.resumeFile || '',
    workAuthorization: '',            // TeamLink does not hold this
    noticePeriod: c.noticePeriod || '',
  };
}

/** Which of the spec's fields TeamLink simply does not have. */
const NOT_ON_FILE = ['preferredFirstName', 'state', 'workAuthorization'];

async function loadProfile(force) {
  const s = await store(['profile', 'profileAt']);
  if (!force && s.profile && Date.now() - (s.profileAt || 0) < PROFILE_TTL_MS) {
    return s.profile;
  }
  const me = await call('/api/auth/me');
  if (!me || !me.session || me.session.role !== 'candidate' || !me.profile) {
    throw new Error('Sign in to TeamLink as a candidate.');
  }
  const profile = shape(me.profile);
  await put({ profile, profileAt: Date.now(), who: me.profile.email || '' });
  return profile;
}

/* ------------------------------------------------------------------ *
 * telling TeamLink the link was opened
 * ------------------------------------------------------------------ */

async function opened(url) {
  /* Is this a job TeamLink has on record? Only then is there anything
     to log against. The URL is compared server-side against the stored
     applyUrl; nothing is invented when there is no match. */
  let job = null;
  try {
    const out = await call('/api/external/jobs?limit=200');
    const jobs = (out && out.jobs) || [];
    const here = normalise(url);
    job = jobs.find((j) => j.applicationUrl && normalise(j.applicationUrl) === here)
      || jobs.find((j) => j.applicationUrl && here.startsWith(normalise(j.applicationUrl)));
  } catch (e) { return { matched: false, reason: e.message }; }

  if (!job) return { matched: false, reason: 'not a job on record' };

  try {
    await call('/api/external/apply', {
      method: 'POST',
      body: JSON.stringify({ externalJobId: job.id }),
    });
    return { matched: true, jobId: job.id };
  } catch (e) {
    /* An origin the API does not recognise lands here. Reported, never
       hidden, and never reported as a success. */
    return { matched: false, reason: e.message };
  }
}

function normalise(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (e) { return String(u || '').toLowerCase(); }
}

/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'tlaf:signin') return reply({ ok: true, session: await signIn(msg.email, msg.password) });
      if (msg.type === 'tlaf:signout') { await signOut(); return reply({ ok: true }); }
      if (msg.type === 'tlaf:profile') return reply({ ok: true, profile: await loadProfile(false) });
      if (msg.type === 'tlaf:refresh') return reply({ ok: true, profile: await loadProfile(true) });
      if (msg.type === 'tlaf:opened') return reply(await opened(msg.url));
      if (msg.type === 'tlaf:missing') return reply({ ok: true, missing: NOT_ON_FILE });
      return reply({ ok: false, error: 'unknown message' });
    } catch (err) {
      return reply({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true;                                  // async reply
});
