import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();

const armEarly = (p) => p.addInitScript(() => {
  window.__seen = [];
  const arm = () => {
    const host = document.getElementById('toastHost');
    if (!host) return false;
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) window.__seen.push(n.innerText.replace(/\s+/g, ' ').trim());
    }))).observe(host, { childList: true });
    return true;
  };
  const t = setInterval(() => { if (arm()) clearInterval(t); }, 20);
});

const capture = (p) => p.evaluate(() => {
  window.__seen = window.__seen || [];
  const host = document.getElementById('toastHost');
  if (host && !host.__watched) {
    host.__watched = true;
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) window.__seen.push(n.innerText.replace(/\s+/g, ' ').trim());
    }))).observe(host, { childList: true });
  }
  return !!host;
});
const seen = (p) => p.evaluate(() => (window.__seen || []).slice());

async function act(p) {           // login, then apply — two failing calls
  try {
    await p.evaluate(() => { location.hash = '#/login/candidate'; });
    await p.waitForTimeout(600);
    await p.fill('input[name="email"]', 'x@example.com', { timeout: 3000 });
    await p.fill('input[name="password"]', 'whatever123', { timeout: 3000 });
    await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent)); b && b.click(); });
    await p.waitForTimeout(1800);
    await p.evaluate(() => { const j=(DATA.jobs[0]||{}).id||'j11'; window.applyToJob && window.applyToJob(j); });
    await p.waitForTimeout(1800);
  } catch (e) { console.log('    (ui step: ' + e.message.split('\n')[0] + ')'); }
}

async function report(label, p) {
  const t = await seen(p);
  const d = await p.evaluate(() => TL.diagnose().verdict).catch(() => '(no TL)');
  console.log(`\n### ${label}`);
  console.log('  navigator.onLine :', await p.evaluate(() => navigator.onLine));
  console.log('  toasts shown     :', t.length);
  [...new Set(t)].forEach(x => console.log('      ' + x + (t.filter(y=>y===x).length > 1 ? `   (x${t.filter(y=>y===x).length})` : '')));
  console.log('  TL.diagnose()    :', String(d).slice(0, 140));
}

// A — file://
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await armEarly(p);
  await p.goto(pathToFileURL(resolve('web/index.html')).href, { waitUntil: 'load' });
  await capture(p); await p.waitForTimeout(2000); await capture(p);
  await act(p);
  await report('A. file:// — the HTML file opened by double-clicking it', p);
  await ctx.close();
}
// B — page served, API dead
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await armEarly(p);
  await p.route('**/api/**', r => r.abort('connectionrefused'));
  await p.goto('http://127.0.0.1:4323/', { waitUntil: 'load' });
  await capture(p); await p.waitForTimeout(2000); await capture(p);
  await act(p);
  await report('B. page loads, API not responding', p);
  await ctx.close();
}
// C — loaded fine, then the network really drops
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await armEarly(p);
  await p.goto('http://127.0.0.1:4323/', { waitUntil: 'load' });
  await p.waitForFunction(() => window.TL && TL.ready === true, { timeout: 20000 });
  await capture(p);
  await ctx.setOffline(true);
  await act(p);
  await report('C. browser genuinely goes offline mid-session', p);
  await ctx.close();
}
// D — API times out (server accepts but never answers)
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await armEarly(p);
  await p.goto('http://127.0.0.1:4323/', { waitUntil: 'load' });
  await p.waitForFunction(() => window.TL && TL.ready === true, { timeout: 20000 });
  await capture(p);
  await p.route('**/api/auth/login', () => { /* never resolves */ });
  await p.evaluate(() => { TL.api.post('/auth/login', {email:'a@b.c',password:'x'}).catch(e => TL.api.say(e)); });
  await p.evaluate(() => { window.__timeoutProbe = 1; });
  // shorten the wait by driving the timeout directly
  await p.waitForTimeout(3000);
  console.log('\n### D. request that never answers (timeout path)');
  console.log('  after 3s, toasts:', JSON.stringify(await seen(p)));
  console.log('  (the 20s timeout has not fired yet — that is the point: no premature error)');
  await ctx.close();
}
await b.close();
