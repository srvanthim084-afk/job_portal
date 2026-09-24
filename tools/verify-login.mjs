/**
 * Signing in with the right password works. Every time.
 *
 *     node tools/verify-login.mjs      (needs the dev server on :4323)
 *
 * A recruiter typing the correct email and password was told "Please
 * refresh the page and try again", and refreshing could not help.
 *
 * The cause was a pair of cookies that did not live the same length of
 * time. The session cookie carries a seven-day expiry; the CSRF token
 * beside it carried none, which makes it a browser-session cookie. Close
 * the browser and you came back holding a valid session and no token, so
 * every write was refused - and the only thing that issued a token was
 * signing in, which was the very thing being refused. GET /api/csrf
 * existed for exactly this and nothing in the client ever called it.
 *
 * So the state that broke it is REPRODUCED here rather than described:
 * sign in, delete the token cookie, keep the session cookie, and sign in
 * again. That is the browser-restart case, and it is the one that has to
 * work.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const RECRUITER = {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
};

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

const login = () => page.evaluate((l) => window.TL.api.post('/auth/login', l)
  .then((v) => ({ ok: 1, role: v && v.session && v.session.role }),
        (e) => ({ ok: 0, code: e.code, message: e.message })), RECRUITER);

const cookies = async () => Object.fromEntries(
  (await ctx.cookies()).map((c) => [c.name, c]));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

/* ---- 1. a plain sign-in, from nothing ------------------------------ */
const first = await login();
check(first.ok === 1, `signing in with the right password works (${first.code || first.role})`);

const afterLogin = await cookies();
check(!!afterLogin.tl_csrf, 'a CSRF token was issued with the session');
check(!!afterLogin.tl_csrf && afterLogin.tl_csrf.expires > 0,
  'and it has an expiry, so closing the browser does not lose it');

const sessionCookie = Object.values(afterLogin).find((c) => c.httpOnly);
check(!!sessionCookie, 'the session cookie is httpOnly, out of JavaScript\'s reach');
if (sessionCookie && afterLogin.tl_csrf) {
  // Within a minute of each other: they are issued in the same response.
  check(Math.abs(sessionCookie.expires - afterLogin.tl_csrf.expires) < 60,
    'the two cookies expire together, so neither can outlive the other');
}

/* ---- 2. THE CASE THAT BROKE: a session with no token --------------- */
/*
 * Exactly what a browser restart used to leave behind. The session
 * cookie is kept; only the token is thrown away.
 */
const keep = (await ctx.cookies()).filter((c) => c.name !== 'tl_csrf');
await ctx.clearCookies();
await ctx.addCookies(keep);
check(!(await cookies()).tl_csrf, 'the token cookie is gone, the session cookie is not');

await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const second = await login();
check(second.ok === 1,
  `signing in STILL works with a session but no token (${second.code || second.role})`);
check(!!(await cookies()).tl_csrf, 'and a fresh token was fetched rather than demanded');

/* ---- 3. a stale token heals itself --------------------------------- */
await ctx.addCookies([{ ...(await cookies()).tl_csrf, value: 'stale-and-wrong-value' }]);
const third = await login();
check(third.ok === 1,
  `a stale token is replaced and the request retried, not reported (${third.code || third.role})`);

/* ---- 4. a wrong password is still refused -------------------------- */
/*
 * The point of the fix is that a CORRECT password gets through. A wrong
 * one must still not, or this made a hole instead of closing one.
 */
const bad = await page.evaluate((l) => window.TL.api.post('/auth/login', l)
  .then(() => ({ ok: 1 }), (e) => ({ ok: 0, code: e.code })),
  { ...RECRUITER, password: 'not-the-password' });
check(bad.ok === 0 && bad.code === 'INVALID_CREDENTIALS',
  `the wrong password is still refused (${bad.code})`);

const wrongRole = await page.evaluate((l) => window.TL.api.post('/auth/login', l)
  .then(() => ({ ok: 1 }), (e) => ({ ok: 0, code: e.code })),
  { ...RECRUITER, role: 'admin' });
check(wrongRole.ok === 0,
  `the right password on the wrong portal is refused (${wrongRole.code})`);

/* ---- 5. through the FORM, which is what a person uses -------------- */
/*
 * Everything above goes through the API wrapper. A person types into
 * two boxes and presses a button, and that path has its own handler -
 * so it is driven here, from a browser with no cookies at all.
 */
const fresh = await browser.newContext();
const form = await fresh.newPage();
const formErrors = [];
form.on('pageerror', (e) => formErrors.push(String(e.message)));

await form.goto(`${BASE}/#/login/recruiter`, { waitUntil: 'load' });
await form.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await form.waitForTimeout(600);

check(await form.inputValue('input[name="email"]') === '',
  "the email box arrives empty, holding nobody's login");
check(await form.inputValue('input[name="password"]') === '',
  'and so does the password box');

await form.fill('input[name="email"]', RECRUITER.email);
await form.fill('input[name="password"]', RECRUITER.password);
await form.click('button[type="submit"]');
await form.waitForTimeout(2500);

const landed = await form.evaluate(() => ({
  hash: location.hash,
  role: window.TL && TL.session ? TL.session.role : null,
  toast: (document.querySelector('.toast, #toast') || {}).textContent || '',
}));
check(landed.role === 'recruiter',
  `typing the right password into the form signs you in (${landed.role || 'not signed in'})`);
check(!/refresh the page/i.test(landed.toast),
  `and says nothing about refreshing (${landed.toast.trim().slice(0, 60) || 'no message'})`);
check(!/#\/login/.test(landed.hash), `it leaves the login screen (${landed.hash})`);
check(formErrors.length === 0,
  `no page errors on the form${formErrors.length ? `: ${formErrors[0]}` : ''}`);
await fresh.close();

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
