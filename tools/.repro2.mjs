import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();

async function run(label, url, offline) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    window.__seen = [];
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1 && n.classList && n.classList.contains('toast')) window.__seen.push(n.innerText.replace(/\s+/g,' ').trim());
    }))).observe(document.documentElement, { childList: true, subtree: true });
  });
  if (offline) await ctx.setOffline(true);
  try { await p.goto(url, { waitUntil: 'load', timeout: 15000 }); } catch (e) {}
  await p.waitForTimeout(2500);
  // login attempt + apply attempt, each of which used to raise its own toast
  try {
    await p.evaluate(() => { location.hash = '#/login/candidate'; });
    await p.waitForTimeout(600);
    await p.fill('input[name="email"]', 'x@example.com', { timeout: 3000 });
    await p.fill('input[name="password"]', 'whatever123', { timeout: 3000 });
    await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent)); b && b.click(); });
    await p.waitForTimeout(1500);
    await p.evaluate(() => { if (window.applyToJob) window.applyToJob('j11'); });
    await p.waitForTimeout(1500);
  } catch (e) {}
  const toasts = await p.evaluate(() => window.__seen || []).catch(() => []);
  const diag = await p.evaluate(() => window.TL && TL.diagnose ? TL.diagnose().verdict : '(no TL)').catch(() => '(unreachable)');
  console.log(`\n### ${label}`);
  console.log('  navigator.onLine :', await p.evaluate(() => navigator.onLine).catch(()=>'?'));
  console.log('  toasts shown     :', toasts.length);
  toasts.forEach(t => console.log('      ' + t));
  console.log('  TL.diagnose()    :', String(diag).slice(0, 150));
  await ctx.close();
}

await run('A. file:// (double-clicked HTML file)', pathToFileURL(resolve('web/index.html')).href, false);
await run('B. served page, API/server not running', 'http://127.0.0.1:4399/', false);
await run('C. browser genuinely offline', 'http://127.0.0.1:4323/', true);
await b.close();
