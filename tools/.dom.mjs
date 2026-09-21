import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await p.goto('http://127.0.0.1:4323/', { waitUntil: 'load' });
await p.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
const dump = async (hash, label) => {
  await p.evaluate(h => { location.hash = h; }, hash);
  await p.waitForTimeout(800);
  const info = await p.evaluate(() => ({
    containers: [...document.querySelectorAll('[id]')].map(e=>e.id).filter(id=>/app|page|main|view|root|content/i.test(id)).slice(0,10),
    inputs: [...document.querySelectorAll('input,select,textarea')].filter(e=>e.offsetParent!==null).map(e=>`${e.tagName.toLowerCase()}#${e.id||''}[name=${e.name||''}]`).slice(0,25),
    buttons: [...document.querySelectorAll('button,a.btn,[onclick]')].filter(e=>e.offsetParent!==null).map(e=>`${e.tagName.toLowerCase()}:${(e.textContent||'').trim().slice(0,28)}|${(e.getAttribute('onclick')||'').slice(0,50)}`).slice(0,25),
  }));
  console.log('\n### ' + label + ' (' + hash + ')');
  console.log('  containers:', info.containers.join(', '));
  console.log('  inputs:', info.inputs.join(' | '));
  console.log('  buttons:'); info.buttons.forEach(x=>console.log('    ' + x));
};
await dump('#/register/candidate', 'REGISTER');
await dump('#/login/candidate', 'LOGIN');
const jid = await p.evaluate(() => (DATA.jobs.find(j=>j.status==='open')||{}).id);
await dump('#/job/' + jid, 'JOB ' + jid);
await b.close();
