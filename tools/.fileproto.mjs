import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
const msgs = [];
p.on('console', m => msgs.push(`[${m.type()}] ${m.text().slice(0,180)}`));
p.on('pageerror', e => msgs.push('[pageerror] ' + String(e.message).slice(0,180)));
p.on('requestfailed', r => msgs.push('[reqfail] ' + r.url().slice(0,90) + ' :: ' + r.failure()?.errorText));
await p.goto(pathToFileURL(resolve('web/index.html')).href, { waitUntil: 'load' });
await p.waitForTimeout(3000);
console.log('TL present:', await p.evaluate(() => !!window.TL));
console.log('TL.ready  :', await p.evaluate(() => window.TL && window.TL.ready));
console.log('DATA.jobs :', await p.evaluate(() => (window.DATA && DATA.jobs || []).length));
console.log('integration script tag:', await p.evaluate(() => [...document.scripts].map(s=>s.src.split('/').pop()).filter(Boolean).join(',')));
console.log('toast host children:', await p.evaluate(() => (document.getElementById('toastHost')||{children:[]}).children.length));
console.log('\nmessages:'); msgs.slice(0,25).forEach(m=>console.log('  '+m));
// now try a login on file://
await p.evaluate(() => { location.hash = '#/login/candidate'; });
await p.waitForTimeout(800);
const has = await p.evaluate(() => !!document.querySelector('input[name="email"]'));
console.log('\nlogin form present on file://:', has);
if (has) {
  await p.fill('input[name="email"]','x@example.com'); await p.fill('input[name="password"]','whatever123');
  await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent)); b&&b.click(); });
  await p.waitForTimeout(2500);
  console.log('toasts after login attempt:', await p.evaluate(() => [...document.querySelectorAll('.toast')].map(t=>t.innerText.replace(/\s+/g,' ').trim())));
}
await b.close();
