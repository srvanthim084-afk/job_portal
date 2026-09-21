import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();

async function run(label, url, offline) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const seen = [], failed = [];
  p.on('requestfailed', r => failed.push(`${r.method()} ${r.url().slice(0,72)} :: ${r.failure()?.errorText}`));
  // watch the real toast host and record every toast the app renders
  await p.addInitScript(() => {
    window.__seen = [];
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1 && n.classList && n.classList.contains('toast')) window.__seen.push(n.innerText.replace(/\s+/g,' ').trim());
    }))).observe(document.documentElement, { childList: true, subtree: true });
  });
  if (offline) await ctx.setOffline(true);
  let gotoErr = null;
  try { await p.goto(url, { waitUntil: 'load', timeout: 15000 }); } catch (e) { gotoErr = e.message.split('\n')[0]; }
  await p.waitForTimeout(2500);
  let loginErr = null;
  try {
    await p.evaluate(() => { location.hash = '#/login/candidate'; });
    await p.waitForTimeout(700);
    await p.fill('input[name="email"]', 'x@example.com', { timeout: 4000 });
    await p.fill('input[name="password"]', 'whatever123', { timeout: 4000 });
    await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent)); b && b.click(); });
    await p.waitForTimeout(2000);
    await p.evaluate(() => { const j=(window.DATA&&DATA.jobs&&DATA.jobs[0]||{}).id; if(j) location.hash='#/job/'+j; });
    await p.waitForTimeout(700);
    await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/apply/i.test(x.textContent)); b && b.click(); });
    await p.waitForTimeout(1500);
  } catch (e) { loginErr = e.message.split('\n')[0]; }
  const toasts = await p.evaluate(() => window.__seen || []).catch(() => []);
  console.log(`\n### ${label}`);
  if (gotoErr) console.log('  page load FAILED:', gotoErr);
  console.log('  navigator.onLine:', await p.evaluate(() => navigator.onLine).catch(()=>'?'));
  console.log('  toasts shown:', toasts.length, JSON.stringify(toasts));
  if (loginErr) console.log('  (ui step:', loginErr + ')');
  console.log('  failed requests:', failed.length ? '\n    ' + failed.slice(0,8).join('\n    ') : 'none');
  await ctx.close();
}

await run('A. file:// — the HTML file opened by double-clicking it', pathToFileURL(resolve('web/index.html')).href, false);
await run('B. http://127.0.0.1:4399 — API/server not running', 'http://127.0.0.1:4399/', false);
await run('C. browser genuinely offline', 'http://127.0.0.1:4323/', true);
await b.close();
