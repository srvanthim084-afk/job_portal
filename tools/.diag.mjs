import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4323/';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const api = [], failed = [], cerr = [];
p.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0,160)); });
p.on('requestfailed', r => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
p.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) api.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`); });

const hook = () => p.evaluate(() => { window.__t = []; const prev = window.toast; window.toast = function (t) { window.__t.push(String(t)); return prev.apply(this, arguments); }; });
const toasts = () => p.evaluate(() => { const t = window.__t.slice(); window.__t.length = 0; return t; });
const boot = async () => { await p.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 }); await hook(); };
const go = async h => { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(700); };

await p.goto(BASE, { waitUntil: 'load' }); await boot();

const email = `diag${Date.now()}@example.com`, PW = 'DiagPass@2026';
console.log('=== 1. REGISTER ===', email);
await go('#/register/candidate');
await p.evaluate(({em, pw}) => {
  const set = (id, v) => { const e = document.getElementById(id); if (!e) return; e.value = v; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); };
  const tick = id => { const e = document.getElementById(id); if (e && !e.checked) e.click(); };
  set('regName','Diag Candidate'); set('regMobile','9876500011'); set('regLocation','Hyderabad');
  set('regEmail', em); set('regPassword', pw); set('regSkills','Java, SQL'); set('regPrefLocation','Hyderabad');
  set('regExpSalary','12'); set('regResumeText','QA engineer with 3 years experience in Java and SQL.');
  const q = document.getElementById('regQualification'); if (q && q.options.length > 1) { q.selectedIndex = 1; q.dispatchEvent(new Event('change',{bubbles:true})); }
  const n = document.getElementById('regNotice'); if (n && n.options.length > 1) { n.selectedIndex = 1; n.dispatchEvent(new Event('change',{bubbles:true})); }
  const t = document.querySelector('input[name="regCandidateType"]'); if (t) t.click();
  tick('regConsentTerms'); tick('regConsentResume');
}, {em: email, pw: PW});
await p.evaluate(() => { const btn=[...document.querySelectorAll('button')].find(x=>/create account/i.test(x.textContent)); if(btn) btn.click(); });
await p.waitForTimeout(3000);
console.log('  toasts:', JSON.stringify(await toasts()));
console.log('  session:', await p.evaluate(() => STATE.session ? STATE.session.role+':'+STATE.session.id : null));

console.log('=== 2. LOGOUT + LOGIN ===');
await p.evaluate(() => TL.api.post('/auth/logout', {}).catch(()=>{}));
await p.reload({ waitUntil: 'load' }); await boot();
await go('#/login/candidate');
await p.fill('input[name="email"]', email); await p.fill('input[name="password"]', PW);
await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/sign in as candidate/i.test(x.textContent)); b && b.click(); });
await p.waitForTimeout(2500);
console.log('  toasts:', JSON.stringify(await toasts()));
const sess = await p.evaluate(() => STATE.session ? STATE.session.role+':'+STATE.session.id : null);
console.log('  session:', sess);

console.log('=== 3. APPLY ===');
const jid = await p.evaluate(() => (DATA.jobs.find(j=>j.status==='open')||{}).id);
await go('#/job/' + jid);
await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/apply/i.test(x.textContent)); b && b.click(); });
await p.waitForTimeout(3000);
console.log('  jobId:', jid, 'toasts:', JSON.stringify(await toasts()));
console.log('  my applications:', await p.evaluate(() => STATE.session ? DATA.applications.filter(a=>a.candidateId===STATE.session.id).length : -1));

console.log('=== 4. DUPLICATE APPLY ===');
await go('#/job/' + jid);
await p.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/apply/i.test(x.textContent)); b && b.click(); });
await p.waitForTimeout(2500);
console.log('  toasts:', JSON.stringify(await toasts()));

console.log('=== 5. APPLICATION HISTORY ===');
await go('#/candidate/applications');
console.log('  rows on page:', await p.evaluate(() => document.querySelectorAll('#app tr, #app .app-card, #app .application-row').length));
console.log('  page text has job title:', await p.evaluate(j => { const t=(DATA.jobById(j)||{}).title||''; return t && document.body.innerText.includes(t); }, jid));

console.log('=== 6. REFRESH ===');
await p.reload({ waitUntil: 'load' }); await boot();
console.log('  session:', await p.evaluate(() => STATE.session ? STATE.session.role+':'+STATE.session.id : null));
console.log('  my applications:', await p.evaluate(() => STATE.session ? DATA.applications.filter(a=>a.candidateId===STATE.session.id).length : -1));

console.log('\n=== NETWORK ===\n' + api.join('\n'));
console.log('\n=== FAILED ===' + (failed.length ? '\n'+failed.join('\n') : ' none'));
console.log('\n=== CONSOLE ERRORS ===' + (cerr.length ? '\n'+cerr.join('\n') : ' none'));
await b.close();
