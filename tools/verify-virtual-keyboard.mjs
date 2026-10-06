/**
 * The on-screen keyboard (web/teamlink-virtual-keyboard.js), in a real browser.
 *
 * On the AI Career Hub (#/candidate/career) and the TeamLink AI chat, at
 * 1366 x 900 (keyboard below the field), 768 x 1024 and 360 x 740 (docked):
 *
 *   for every text field: the Target role search box, the floating chat input,
 *   and (1366, 360) the AI Career Assistant page input
 *     - the icon is there, once, labelled, beside the field
 *     - the keyboard opens; inputmode is "none" while open and restored after
 *     - "Hello ₹5" goes in at the caret, mid-text; a selection is replaced
 *     - Shift (one capital), double Shift (caps lock, aria-pressed), Backspace
 *       (and held down it repeats), 123 / ABC
 *     - `input` events fire (a listener the test adds), `change` on close
 *     - Escape closes it (focus back in the field); an outside tap closes it
 *     - placement: below the field and on screen (1366); docked full width,
 *       field above the keyboard, no sideways scroll (768, 360)
 *     - keys >= 44 x 44 in both layouts; every key has an aria-label
 *   the chat: a question typed on the keyboard, Enter -> sent through the chat's
 *     own path, answered (rules engine here), and the keyboard follows the
 *     re-drawn input
 *   the Target role combobox: typing on the keyboard filters the list;
 *     picking a role updates the Skill-Gap section exactly as the dropdown
 *     did; arrows + Enter, Escape; role / aria-expanded / aria-activedescendant
 *   only one keyboard at a time; a re-render re-attaches; the icon moves nothing
 *   no page errors
 *
 * Creates an account and jobs, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4435/ node tools/verify-virtual-keyboard.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4435/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-keyboard');
mkdirSync(SHOTS, { recursive: true });

let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

const browser = await chromium.launch();
const pageErrors = [];
const consoleErrors = [];
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const settle = (page) => page.waitForFunction(() => !TLCareerAssistant.state().sending, null, { timeout: 60000 });

/* ---------- three open roles with different skills ---------- */
const ROLES = [
  { title: `Support Associate ${stamp}`, skills: ['Communication', 'Telugu'] },
  { title: `Data Entry Operator ${stamp}`, skills: ['Typing', 'MS Excel'] },
  { title: `Field Sales Executive ${stamp}`, skills: ['Sales', 'Negotiation'] },
];
{
  const rc = await browser.newContext();
  const rp = await rc.newPage();
  await rp.goto(BASE + '#/'); await ready(rp);
  const out = await rp.evaluate(async ({ e, p, roles }) => {
    try {
      await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId;
      const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
      const ids = [];
      for (const r of roles) {
        const j = await TL.api.post('/jobs', { title: r.title, companyId: co.id, location: 'Nellore', mode: 'Onsite', exp: '0-2 yrs',
          pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time', status: 'open', skills: r.skills,
          description: 'Verification job - safe to delete.' });
        ids.push(j.job.id);
      }
      return ids;
    } catch (err) { return 'ERR ' + err.message; }
  }, { e: RECRUITER, p: RECRUITER_PW, roles: ROLES });
  if (!Array.isArray(out)) { console.error('could not publish the test jobs: ' + out); process.exit(1); }
  ROLES.forEach((r, i) => { r.id = out[i]; });
  await rc.close();
}

/* ---------- the candidate ---------- */
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '#/'); await ready(page);
const cand = { email: `keyboard.${stamp}@tl-verify.test`, password: `Kbd${stamp}9x` };
const reg = await page.evaluate((b) => TL.api.post('/auth/register', b).then((r) => 'ok:' + r.candidateId, (e) => e.message), {
  name: 'Keyboard Verify', ...cand, phone: phone(), preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate',
  preferredWorkModes: ['Work From Office'], consent: { terms: true, communication: true, resumeProcessing: true },
});
if (!String(reg).startsWith('ok:')) { console.error('could not register: ' + reg); process.exit(1); }
const upd = await page.evaluate((id) => TL.api.put('/candidates/' + id, { title: 'Support Associate', skills: ['Communication', 'Typing'] })
  .then(() => 'ok', (e) => e.message), reg.slice(3));
if (upd !== 'ok') { console.error('could not update the profile: ' + upd); process.exit(1); }

async function goCareer() {
  await page.goto('about:blank'); await page.goto(BASE + '#/candidate/career'); await ready(page);
  await page.waitForTimeout(1500); await wizardAway(page); await page.waitForTimeout(500); await wizardAway(page);
  await page.waitForSelector('.tlvk-cb-input');
  await page.evaluate(() => {
    window.__kbEv = [];
    const log = (e) => { if (e.target && e.target.id) window.__kbEv.push({ id: e.target.id, type: e.type, inputType: e.inputType || '' }); };
    document.addEventListener('input', log, true);
    document.addEventListener('change', log, true);
  });
}

/* ---------- driving the keyboard like a person ---------- */
const KB = '.tlvk:not([hidden])';
const press = (label) => page.locator(`${KB} .tlvk-k[aria-label="${label}"]`).click();
const kbState = () => page.evaluate(() => {
  const r = document.querySelector('.tlvk');
  const sh = r && r.querySelector('[data-k="shift"]');
  return { open: !!(r && !r.hidden), mode: r ? r.querySelector('.tlvk-keys').getAttribute('aria-label') : '', shift: sh ? sh.getAttribute('data-shift') : '0' };
});
async function typeKb(text) {
  for (const ch of Array.from(text)) {
    let st = await kbState();
    if (ch === ' ') { await press('Space'); continue; }
    if (/[a-z]/i.test(ch)) {
      if (st.mode !== 'Letters') { await press('Letters'); st = await kbState(); }
      const upper = ch !== ch.toLowerCase();
      if (upper && st.shift === '0') await press('Shift');
      if (!upper && st.shift !== '0') throw new Error('Shift is on while typing a lowercase letter');
      await page.locator(`${KB} .tlvk-k[data-c="${ch.toLowerCase()}"]`).click();
      continue;
    }
    const sel = `${KB} .tlvk-k[data-c=${JSON.stringify(ch)}]`;
    if (!(await page.locator(sel).count())) await press(st.mode === 'Letters' ? 'Numbers and symbols' : 'Letters');
    await page.locator(sel).click();
  }
}
const fieldInfo = (sel) => page.evaluate((s) => {
  const f = document.querySelector(s);
  if (!f) return null;
  const ic = f.nextElementSibling && f.nextElementSibling.classList.contains('tlvk-icon') ? f.nextElementSibling : null;
  return {
    value: f.value, start: f.selectionStart, end: f.selectionEnd, im: f.getAttribute('inputmode'), focused: document.activeElement === f,
    icons: f.parentElement.querySelectorAll('.tlvk-icon').length, icon: !!ic, iconLabel: ic && ic.getAttribute('aria-label'),
    iconExpanded: ic && ic.getAttribute('aria-expanded'), id: f.id,
  };
}, sel);
const setText = (sel, v, a, b) => page.evaluate(({ s, v, a, b }) => {
  const f = document.querySelector(s);
  f.focus(); f.value = v; f.setSelectionRange(a, b == null ? a : b);
}, { s: sel, v, a, b });
const openKb = async (sel) => {
  await page.evaluate((s) => document.querySelector(s).nextElementSibling.scrollIntoView({ block: 'center' }), sel);
  await page.locator(sel + ' + .tlvk-icon').click();
  await page.waitForSelector(KB);
};
const rects = (sel) => page.evaluate((s) => {
  const f = document.querySelector(s), k = document.querySelector('.tlvk');
  const R = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  return { f: R(f), k: k && !k.hidden ? R(k) : null, vw: document.documentElement.clientWidth, vh: innerHeight,
    sw: document.documentElement.scrollWidth, bsw: document.body.scrollWidth };
}, sel);
const keySizes = () => page.evaluate(() => Array.from(document.querySelectorAll('.tlvk:not([hidden]) .tlvk-k')).map((b) => {
  const r = b.getBoundingClientRect();
  return { label: b.getAttribute('aria-label') || '', w: r.width, h: r.height };
}));
async function safePoint() {
  return page.evaluate(() => {
    const bad = 'a,button,input,select,textarea,label,[onclick],[role="button"],.tlvk,.cp-chat,.cp-fab,.tlvk-cb-list,.cp-bottom,nav,header,.cap-topbar';
    const k = document.querySelector('.tlvk:not([hidden])');
    const limit = k ? k.getBoundingClientRect().top - 4 : innerHeight - 4;
    for (let y = 60; y < limit; y += 8) {
      for (const x of [6, 14, Math.round(innerWidth / 2)]) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest(bad)) return { x, y };
      }
    }
    return null;
  });
}
const skillGapText = () => page.evaluate(() => {
  const body = document.querySelector('.ai-panel .panel-body').cloneNode(true);
  body.querySelectorAll('.tlvk-cb, select').forEach((x) => x.remove());
  return body.textContent.replace(/\s+/g, ' ').trim();
});

/* the battery for one text field */
async function fieldBattery(tag, sel, { docked }) {
  await check(`${tag}: the keyboard icon is beside the field, once, labelled`, async () => {
    const i = await fieldInfo(sel);
    must(i && i.icon && i.icons === 1, 'icon: ' + JSON.stringify(i));
    must(i.iconLabel === 'Open on-screen keyboard', 'label: ' + i.iconLabel);
    const box = await page.evaluate((s) => {
      const f = document.querySelector(s).getBoundingClientRect(), c = document.querySelector(s + ' + .tlvk-icon').getBoundingClientRect();
      return { inside: c.left >= f.left && c.right <= f.right + 0.5 && c.top >= f.top - 0.5 && c.bottom <= f.bottom + 0.5, w: c.width };
    }, sel);
    must(box.inside, 'the icon is not inside the field box');
  });

  await check(`${tag}: opens; inputmode "none" while open; "Hello ₹5" lands at the caret, mid-text`, async () => {
    await page.evaluate((s) => { const f = document.querySelector(s); f.setAttribute('inputmode', 'text'); }, sel);
    await setText(sel, 'AB', 1);
    await openKb(sel);
    let i = await fieldInfo(sel);
    must(i.im === 'none', 'inputmode while open: ' + i.im);
    must(i.iconExpanded === 'true', 'icon aria-expanded: ' + i.iconExpanded);
    await page.evaluate(() => { window.__kbEv.length = 0; });
    await setText(sel, 'AB', 1);
    await typeKb('Hello ₹5');
    i = await fieldInfo(sel);
    must(i.value === 'AHello ₹5B', 'value: ' + JSON.stringify(i.value));
    must(i.start === 9 && i.end === 9, `caret at ${i.start}-${i.end}, expected 9`);
    must(i.focused, 'the field lost the focus');
  });

  await check(`${tag}: input events fire for every key, with inputType`, async () => {
    const ev = await page.evaluate((s) => window.__kbEv.filter((e) => e.id === document.querySelector(s).id), sel);
    const inputs = ev.filter((e) => e.type === 'input');
    must(inputs.length === 8, `${inputs.length} input events for 8 characters`);
    must(inputs.every((e) => e.inputType === 'insertText'), 'inputType: ' + inputs.map((e) => e.inputType).join(','));
  });

  await check(`${tag}: a selection is replaced; Backspace deletes; held down it repeats`, async () => {
    await setText(sel, 'AHello ₹5B', 1, 9);
    await typeKb('x');
    let i = await fieldInfo(sel);
    must(i.value === 'AxB', 'after replacing the selection: ' + i.value);
    await setText(sel, 'AxB', 3);
    await press('Backspace');
    i = await fieldInfo(sel);
    must(i.value === 'Ax' && i.start === 2, 'after Backspace: ' + i.value + ' @' + i.start);
    await setText(sel, 'abcdefghijklmnop', 16);
    const b = await page.locator(`${KB} .tlvk-k[aria-label="Backspace"]`).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
    i = await fieldInfo(sel);
    must(i.value.length <= 16 - 5 && i.value.length >= 0 && 'abcdefghijklmnop'.startsWith(i.value), `held Backspace left "${i.value}"`);
    const ev = await page.evaluate(() => window.__kbEv.filter((e) => e.inputType === 'deleteContentBackward').length);
    must(ev >= 6, 'deleteContentBackward input events: ' + ev);
  });

  await check(`${tag}: Shift gives one capital; double Shift is caps lock (aria-pressed); 123 / ABC`, async () => {
    await setText(sel, '', 0);
    await press('Shift');
    let st = await kbState();
    must(st.shift === '1', 'shift state ' + st.shift);
    must(await page.locator(`${KB} [data-k="shift"][aria-pressed="true"]`).count() === 1, 'aria-pressed not true');
    await page.locator(`${KB} .tlvk-k[data-c="d"]`).click();
    await page.locator(`${KB} .tlvk-k[data-c="e"]`).click();
    let i = await fieldInfo(sel);
    must(i.value === 'De', 'one-shot shift: ' + i.value);
    {
      // a double tap: two quick presses, as a thumb does it
      const b = await page.locator(`${KB} [data-k="shift"]`).boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
    st = await kbState();
    must(st.shift === '2', 'caps state ' + st.shift);
    must(await page.locator(`${KB} [aria-label="Shift, caps lock on"][aria-pressed="true"]`).count() === 1, 'caps not announced');
    await page.locator(`${KB} .tlvk-k[data-c="a"]`).click();
    await page.locator(`${KB} .tlvk-k[data-c="b"]`).click();
    await press('Shift, caps lock on');
    await page.locator(`${KB} .tlvk-k[data-c="c"]`).click();
    i = await fieldInfo(sel);
    must(i.value === 'DeABc', 'caps lock: ' + i.value);
    must((await kbState()).shift === '0' && await page.locator(`${KB} [data-k="shift"][aria-pressed="false"]`).count() === 1, 'shift did not go off');
    await press('Numbers and symbols');
    st = await kbState();
    must(st.mode === 'Numbers and symbols' && await page.locator(`${KB} .tlvk-k[data-c="7"]`).count() === 1, 'no number page');
    for (const c of ['₹', '@', '.', ',', '-', '_', '/', '?', '!', "'", '"', '(', ')', ':', ';', '&', '+', '#', '%']) {
      must(await page.locator(`${KB} .tlvk-k[data-c=${JSON.stringify(c)}]`).count() === 1, 'missing symbol ' + c);
    }
    await press('Letters');
    must((await kbState()).mode === 'Letters', 'ABC did not come back');
  });

  await check(`${tag}: keys are at least 44 x 44 and every key has an aria-label (both pages)`, async () => {
    const all = [];
    all.push(...await keySizes());
    await press('Numbers and symbols');
    all.push(...await keySizes());
    await press('Letters');
    const small = all.filter((k) => k.w < 44 - 0.01 || k.h < 44 - 0.01);
    must(all.length > 50, 'keys found: ' + all.length);
    must(!small.length, 'small keys: ' + JSON.stringify(small.slice(0, 4)));
    must(all.every((k) => k.label.trim()), 'a key without aria-label');
    const roles = await page.evaluate(() => {
      const r = document.querySelector('.tlvk');
      return r.getAttribute('role') + '|' + r.getAttribute('aria-label') + '|' + r.querySelector('[role="group"]').getAttribute('aria-label');
    });
    must(roles === 'dialog|On-screen keyboard|Letters', 'roles: ' + roles);
  });

  await check(`${tag}: placement ${docked ? 'docked at the bottom, full width, field above it, no sideways scroll' : 'below the field, on screen'}`, async () => {
    const r = await rects(sel);
    must(r.k, 'keyboard not open');
    must(r.sw <= r.vw && r.bsw <= r.vw, `horizontal overflow: ${r.sw}/${r.bsw} > ${r.vw}`);
    must(r.f.top >= 0 && r.f.bottom <= r.k.top + 0.5, `field ${r.f.top}-${r.f.bottom}, keyboard top ${r.k.top}`);
    if (docked) {
      must(Math.abs(r.k.bottom - r.vh) <= 1 && r.k.left <= 0.5 && Math.abs(r.k.width - r.vw) <= 1, 'not docked: ' + JSON.stringify(r.k) + ' vw ' + r.vw);
    } else {
      must(r.k.top >= r.f.bottom && r.k.top - r.f.bottom <= 300, `keyboard top ${r.k.top} vs field bottom ${r.f.bottom}`);
      must(r.k.left >= 0 && r.k.right <= r.vw && r.k.bottom <= r.vh, 'off screen: ' + JSON.stringify(r.k));
    }
  });

  await check(`${tag}: Escape closes, focus back in the field, inputmode restored, change fired`, async () => {
    await setText(sel, 'typed', 5);
    await page.evaluate(() => { window.__kbEv.length = 0; });
    await typeKb('x');
    await page.keyboard.press('Escape');
    const st = await kbState();
    must(!st.open, 'still open');
    const i = await fieldInfo(sel);
    must(i.im === 'text', 'inputmode after close: ' + i.im);
    must(i.focused, 'focus is not back in the field');
    must(i.iconExpanded === 'false', 'icon still expanded');
    const ch = await page.evaluate(() => window.__kbEv.filter((e) => e.type === 'change').length);
    must(ch === 1, 'change events on close: ' + ch);
  });

  await check(`${tag}: an outside tap closes it; inputmode removed when there was none`, async () => {
    await page.evaluate((s) => { document.querySelector(s).removeAttribute('inputmode'); }, sel);
    await openKb(sel);
    must((await fieldInfo(sel)).im === 'none', 'inputmode while open');
    const p = await safePoint();
    must(p, 'no neutral spot to tap');
    await page.mouse.click(p.x, p.y);
    must(!(await kbState()).open, 'still open after an outside tap');
    must((await fieldInfo(sel)).im === null, 'inputmode left behind: ' + (await fieldInfo(sel)).im);
    await setText(sel, '', 0);
    await page.evaluate((s) => document.querySelector(s).blur(), sel);
  });
}

/* the Target role combobox */
async function comboBattery(tag) {
  const CBI = '.tlvk-cb-input';
  await check(`${tag}: Target role is a combobox over the same <select> (role, aria-expanded, hidden select)`, async () => {
    const s = await page.evaluate(() => {
      const i = document.querySelector('.tlvk-cb-input'), sel = document.querySelector('select[onchange*="setSkillGapTarget"]');
      return { role: i.getAttribute('role'), exp: i.getAttribute('aria-expanded'), ctl: !!document.getElementById(i.getAttribute('aria-controls')),
        label: i.getAttribute('aria-label'), value: i.value, selText: sel.options[sel.selectedIndex].text, selHidden: getComputedStyle(sel).display === 'none',
        opts: sel.options.length, cbs: document.querySelectorAll('.tlvk-cb').length };
    });
    must(s.role === 'combobox' && s.exp === 'false' && s.ctl && s.label === 'Target role', JSON.stringify(s));
    must(s.value === s.selText && s.selHidden && s.cbs === 1, JSON.stringify(s));
    must(s.opts >= 3, 'options: ' + s.opts);
  });

  await check(`${tag}: typing on the on-screen keyboard filters the list`, async () => {
    await openKb(CBI);
    must(await page.getAttribute(CBI, 'aria-expanded') === 'true', 'list not open');
    // the box shows the current choice, selected: typing replaces it
    await page.evaluate((s) => { const f = document.querySelector(s); f.setSelectionRange(0, f.value.length); }, CBI);
    await typeKb('data');
    const l = await page.evaluate(() => {
      const i = document.querySelector('.tlvk-cb-input'), list = document.getElementById(i.getAttribute('aria-controls'));
      const k = document.querySelector('.tlvk').getBoundingClientRect(), lr = list.getBoundingClientRect(), ir = i.getBoundingClientRect();
      return { value: i.value, items: Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent),
        total: document.querySelector('select[onchange*="setSkillGapTarget"]').options.length, ad: i.getAttribute('aria-activedescendant'),
        listTop: lr.top, listBottom: lr.bottom, kbTop: k.top, inputBottom: ir.bottom, listRight: lr.right, vw: document.documentElement.clientWidth };
    });
    must(l.value === 'data', 'value: ' + l.value);
    must(l.items.length >= 1 && l.items.length < l.total && l.items.every((t) => /data/i.test(t)), 'filtered: ' + JSON.stringify(l.items));
    must(l.items.some((t) => t.includes(ROLES[1].title)), 'the Data Entry role is not listed');
    must(l.ad, 'no aria-activedescendant');
    must(l.listTop >= l.inputBottom && l.listBottom <= l.kbTop + 0.5, `list ${l.listTop}-${l.listBottom} vs keyboard ${l.kbTop}`);
    must(l.listRight <= l.vw, 'list overflows sideways');
    await page.screenshot({ path: join(SHOTS, `${tag}-combobox-keyboard.png`) });
  });

  await check(`${tag}: a page re-render while typing keeps the keyboard, the typed text and the filtered list`, async () => {
    await page.evaluate(() => render());
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => {
      const f = TLKeyboard.field(), i = document.querySelector('.tlvk-cb-input');
      return { open: TLKeyboard.isOpen(), same: f === i, live: !!(f && f.isConnected), value: i.value, im: i.getAttribute('inputmode'),
        exp: i.getAttribute('aria-expanded'), focused: document.activeElement === i,
        items: Array.from(document.querySelectorAll('.tlvk-cb-list [role="option"]')).map((o) => o.textContent) };
    });
    must(s.open && s.same && s.live && s.value === 'data' && s.im === 'none' && s.exp === 'true' && s.focused, JSON.stringify(s));
    must(s.items.length >= 1 && s.items.every((t) => /data/i.test(t)), 'list after re-render: ' + JSON.stringify(s.items));
    await typeKb(' e');
    must(await page.inputValue(CBI) === 'data e', 'typing after the re-render: ' + await page.inputValue(CBI));
  });

  await check(`${tag}: picking a role updates Skill-Gap exactly as the dropdown does`, async () => {
    await page.locator('.tlvk-cb-list [role="option"]', { hasText: ROLES[1].title }).click();
    await page.waitForFunction((id) => document.querySelector('select[onchange*="setSkillGapTarget"]').value === id && STATE.skillGapTarget === id, ROLES[1].id);
    must(!(await kbState()).open, 'keyboard still open after the pick');
    const viaCombo = await skillGapText();
    const shown = await page.inputValue(CBI);
    must(shown.startsWith(ROLES[1].title), 'combobox shows: ' + shown);
    must(/Skills you have.*Typing/.test(viaCombo) && /Skills to build.*MS Excel/.test(viaCombo), 'Skill-Gap: ' + viaCombo.slice(0, 200));
    // the dropdown's own path: away and back through the <select>'s change event
    for (const id of [ROLES[0].id, ROLES[1].id]) {
      await page.evaluate((v) => { const s = document.querySelector('select[onchange*="setSkillGapTarget"]'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, id);
      await page.waitForFunction((v) => STATE.skillGapTarget === v, id);
    }
    const viaSelect = await skillGapText();
    must(viaSelect === viaCombo, 'differs from the dropdown:\n' + viaCombo.slice(0, 160) + '\n' + viaSelect.slice(0, 160));
    must(await page.inputValue(CBI) === shown, 'combobox text after the dropdown path: ' + await page.inputValue(CBI));
  });

  await check(`${tag}: arrow keys + Enter pick; Escape closes the list`, async () => {
    await page.click(CBI);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('field');
    must(await page.getAttribute(CBI, 'aria-expanded') === 'true', 'list not open');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    const ad = await page.getAttribute(CBI, 'aria-activedescendant');
    must(ad && await page.locator('#' + ad).innerText().then((t) => t.includes(ROLES[2].title)), 'active option: ' + ad);
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => STATE.skillGapTarget === id, ROLES[2].id);
    must(/Skills to build.*Sales/.test(await skillGapText()), 'Skill-Gap did not follow');
    await page.waitForTimeout(100);
    must(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tlvk-cb-input')), 'focus not on the new box');
    await page.keyboard.press('ArrowDown');
    must(await page.getAttribute(CBI, 'aria-expanded') === 'true', 'ArrowDown did not open');
    await page.keyboard.press('Escape');
    must(await page.getAttribute(CBI, 'aria-expanded') === 'false', 'Escape did not close the list');
    must((await page.inputValue(CBI)).startsWith(ROLES[2].title), 'text not restored');
    await page.evaluate(() => document.activeElement.blur());
  });
}

/* the chat: type, Enter, sent through the chat's own path */
async function chatSend(tag) {
  await check(`${tag}: chat — a question typed on the keyboard, Enter sends it through the chat and it is answered`, async () => {
    const before = await page.evaluate(() => TLCareerAssistant.state().messages.length);
    await openKb('#cpChatIn');
    await setText('#cpChatIn', '', 0);
    await typeKb('What jobs match me?');
    must(await page.inputValue('#cpChatIn') === 'What jobs match me?', 'typed: ' + await page.inputValue('#cpChatIn'));
    await press('Enter');
    await page.waitForFunction((n) => TLCareerAssistant.state().messages.length >= n + 2, before, { timeout: 60000 });
    await settle(page);
    const st = await page.evaluate(() => TLCareerAssistant.state());
    const mine = st.messages[st.messages.length - 2], reply = st.messages[st.messages.length - 1];
    must(mine.role === 'user' && mine.text === 'What jobs match me?', 'sent: ' + JSON.stringify(mine));
    must(reply.role === 'assistant' && reply.text.length > 10, 'reply: ' + JSON.stringify(reply));
    must(await page.locator('#cpChatBody .cp-msg.me', { hasText: 'What jobs match me?' }).count() >= 1, 'no bubble');
    // the chat re-drew its input; the keyboard went with it
    const k = await page.evaluate(() => ({ open: TLKeyboard.isOpen(), id: TLKeyboard.field() && TLKeyboard.field().id, live: !!(TLKeyboard.field() && TLKeyboard.field().isConnected),
      im: document.getElementById('cpChatIn').getAttribute('inputmode'), value: document.getElementById('cpChatIn').value }));
    must(k.open && k.id === 'cpChatIn' && k.live && k.im === 'none' && k.value === '', 'after sending: ' + JSON.stringify(k));
    await typeKb('ok');
    must(await page.inputValue('#cpChatIn') === 'ok', 'typing after sending');
    await press('Close keyboard');
    must(!(await kbState()).open && (await fieldInfo('#cpChatIn')).im === null, 'Close did not close');
    await setText('#cpChatIn', '', 0);
  });
}

async function openChat() {
  if (!(await page.locator('.cp-chat.on').count())) { await page.click('.cp-fab'); await page.waitForSelector('.cp-chat.on #cpChatIn'); }
  await page.waitForTimeout(300);
}
async function closeChat() {
  if (await page.locator('.cp-chat.on').count()) { await page.click('.cp-chat .cp-ico'); await page.waitForTimeout(300); }
}

console.log(`\nOn-screen keyboard  (${BASE})`);

/* ================= 1366 x 900 ================= */
await goCareer();
console.log('\n 1366 x 900');

await check('1366: the AI Career Hub text fields: Target role (search) and the TeamLink AI chat input, each with the icon', async () => {
  await openChat();
  const f = await page.evaluate(() => Array.from(document.querySelectorAll('#app input, #app textarea, #app [contenteditable]'))
    .filter((x) => x.getClientRects().length && !['hidden', 'checkbox', 'radio', 'file', 'password', 'number'].includes(x.type))
    .map((x) => ({ id: x.id, cls: x.className, icon: !!(x.nextElementSibling && x.nextElementSibling.classList.contains('tlvk-icon')) })));
  must(f.length === 2 && f.every((x) => x.icon), 'fields: ' + JSON.stringify(f));
  must(f.some((x) => x.id === 'cpChatIn') && f.some((x) => /tlvk-cb-input/.test(x.cls)), 'fields: ' + JSON.stringify(f));
});

await check('1366: the icon moves nothing (chat input and Send keep their boxes; the search box sits where the dropdown was)', async () => {
  const r = await page.evaluate(() => {
    const R = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 10) / 10); };
    const sel = document.querySelector('select[onchange*="setSkillGapTarget"]'), cb = document.querySelector('.tlvk-cb');
    const input = R(cb.querySelector('input'));
    sel.style.display = ''; cb.style.display = 'none';
    const select = R(sel);
    sel.style.display = 'none'; cb.style.display = '';
    const ic = document.querySelector('#cpChatIn + .tlvk-icon');
    const a = { i: R(document.getElementById('cpChatIn')), b: R(document.querySelector('.cp-chat .f button:not(.tlvk-icon)')) };
    ic.style.display = 'none';
    const b = { i: R(document.getElementById('cpChatIn')), b: R(document.querySelector('.cp-chat .f button:not(.tlvk-icon)')) };
    ic.style.display = '';
    return { input, select, a, b };
  });
  must(JSON.stringify(r.a) === JSON.stringify(r.b), 'chat row moved: ' + JSON.stringify(r));
  must(r.input[0] === r.select[0] && r.input[1] === r.select[1] && r.input[2] === r.select[2] && Math.abs(r.input[3] - r.select[3]) <= 2, 'search box vs dropdown: ' + JSON.stringify(r));
});

await check('1366: only one keyboard at a time (open on Target role, then on the chat)', async () => {
  await openKb('.tlvk-cb-input');
  must((await fieldInfo('.tlvk-cb-input')).im === 'none', 'combobox inputmode');
  await page.locator('#cpChatIn + .tlvk-icon').click();
  const s = await page.evaluate(() => ({ n: document.querySelectorAll('.tlvk').length, vis: document.querySelectorAll('.tlvk:not([hidden])').length,
    f: TLKeyboard.field() && TLKeyboard.field().id, cbIm: document.querySelector('.tlvk-cb-input').getAttribute('inputmode'),
    cbExp: document.querySelector('.tlvk-cb-input + .tlvk-icon').getAttribute('aria-expanded') }));
  must(s.n === 1 && s.vis === 1 && s.f === 'cpChatIn' && s.cbIm === null && s.cbExp === 'false', JSON.stringify(s));
  await page.keyboard.press('Escape');
});

await check('1366: a re-render re-attaches the icons, without duplicates', async () => {
  await page.evaluate(() => render());
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => ({ icons: document.querySelectorAll('#app .tlvk-icon').length, cbs: document.querySelectorAll('.tlvk-cb').length,
    chat: !!document.querySelector('#cpChatIn + .tlvk-icon'), cb: !!document.querySelector('.tlvk-cb-input + .tlvk-icon') }));
  must(s.icons === 2 && s.cbs === 1 && s.chat && s.cb, JSON.stringify(s));
});

await closeChat();
await fieldBattery('1366 Target role', '.tlvk-cb-input', { docked: false });
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await comboBattery('1366');
await check('1366: screenshot with the keyboard open below the field', async () => {
  await openKb('.tlvk-cb-input');
  await page.screenshot({ path: join(SHOTS, '1366-open.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
});
await openChat();
await fieldBattery('1366 chat', '#cpChatIn', { docked: false });
await chatSend('1366');
await closeChat();

/* the AI Career Assistant page: the TeamLink AI chat as a page, its form sends on Enter */
await check('1366: AI Career Assistant page — the chat input has the icon; Enter submits the form', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/assistant'; });
  await page.waitForSelector('#assistantInput + .tlvk-icon');
  await settle(page);
  const before = await page.evaluate(() => TLCareerAssistant.state().messages.length);
  await openKb('#assistantInput');
  await typeKb('Salary fit');
  await press('Enter');
  await page.waitForFunction((n) => TLCareerAssistant.state().messages.length >= n + 2, before, { timeout: 60000 });
  await settle(page);
  const st = await page.evaluate(() => TLCareerAssistant.state().messages.slice(-2));
  must(st[0].role === 'user' && st[0].text === 'Salary fit' && st[1].role === 'assistant', JSON.stringify(st));
  must(await page.inputValue('#assistantInput') === '', 'input not cleared');
  await page.keyboard.press('Escape');
  must(!(await kbState()).open, 'still open');
});

/* ================= 768 x 1024 ================= */
await page.setViewportSize({ width: 768, height: 1024 });
await goCareer();
console.log('\n 768 x 1024');
await fieldBattery('768 Target role', '.tlvk-cb-input', { docked: true });
await openChat();
await fieldBattery('768 chat', '#cpChatIn', { docked: true });
await closeChat();

/* ================= 360 x 740 ================= */
await page.setViewportSize({ width: 360, height: 740 });
await goCareer();
console.log('\n 360 x 740');
await check('360: no horizontal overflow on the page, keyboard closed', async () => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  must(r.sw <= r.vw, JSON.stringify(r));
});
await fieldBattery('360 Target role', '.tlvk-cb-input', { docked: true });
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await comboBattery('360');
await check('360: screenshots — letters, and the numbers page', async () => {
  await openKb('.tlvk-cb-input');
  await page.screenshot({ path: join(SHOTS, '360-open.png') });
  await press('Numbers and symbols');
  await page.screenshot({ path: join(SHOTS, '360-numbers.png') });
  await press('Letters');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
});
await openChat();
await fieldBattery('360 chat', '#cpChatIn', { docked: true });
await chatSend('360');
await check('360: chat screenshot with the keyboard docked', async () => {
  await openKb('#cpChatIn');
  await page.screenshot({ path: join(SHOTS, '360-chat-open.png') });
  await press('Close keyboard');
});
await closeChat();
await check('360: AI Career Assistant page input — docked, field above the keyboard', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/assistant'; });
  await page.waitForSelector('#assistantInput + .tlvk-icon');
  await settle(page);
  await openKb('#assistantInput');
  const r = await rects('#assistantInput');
  must(r.k && r.f.bottom <= r.k.top + 0.5 && r.f.top >= 0 && r.sw <= r.vw, JSON.stringify(r));
  await page.keyboard.press('Escape');
});

/* ================= a touch phone: taps, coarse pointer ================= */
await check('touch phone (360, taps): tap the icon, tap keys, tap Close; docked; focus goes to the icon', async () => {
  const tc = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const tp = await tc.newPage();
  tp.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await tp.goto(BASE + '#/'); await ready(tp);
  await tp.evaluate((b) => TL.api.post('/auth/login', b), { email: cand.email, password: cand.password, role: 'candidate' });
  await tp.goto('about:blank'); await tp.goto(BASE + '#/candidate/career'); await ready(tp);
  await tp.waitForTimeout(1500); await wizardAway(tp); await tp.waitForTimeout(500); await wizardAway(tp);
  await tp.waitForSelector('.tlvk-cb-input + .tlvk-icon');
  must(await tp.evaluate(() => matchMedia('(pointer: coarse)').matches), 'not a coarse pointer');
  await tp.tap('.tlvk-cb-input + .tlvk-icon');
  await tp.waitForSelector(KB);
  await tp.evaluate(() => { const f = document.querySelector('.tlvk-cb-input'); f.setSelectionRange(0, f.value.length); });
  for (const c of ['s', 'a', 'l']) await tp.tap(`${KB} .tlvk-k[data-c="${c}"]`);
  const s = await tp.evaluate(() => {
    const i = document.querySelector('.tlvk-cb-input'), k = document.querySelector('.tlvk').getBoundingClientRect();
    return { v: i.value, im: i.getAttribute('inputmode'), dock: document.querySelector('.tlvk').classList.contains('tlvk--dock'),
      bottom: k.bottom, vh: innerHeight, items: Array.from(document.querySelectorAll('.tlvk-cb-list [role="option"]')).map((o) => o.textContent) };
  });
  must(s.v === 'sal' && s.im === 'none' && s.dock && Math.abs(s.bottom - s.vh) <= 1, JSON.stringify(s));
  must(s.items.length >= 1 && s.items.every((t) => /sal/i.test(t)), 'filtered: ' + JSON.stringify(s.items));
  await tp.tap(`${KB} .tlvk-k[aria-label="Close keyboard"]`);
  const after = await tp.evaluate(() => ({ open: TLKeyboard.isOpen(), im: document.querySelector('.tlvk-cb-input').getAttribute('inputmode'),
    onIcon: document.activeElement === document.querySelector('.tlvk-cb-input + .tlvk-icon') }));
  must(!after.open && after.im === null && after.onIcon, JSON.stringify(after));
  await tp.waitForTimeout(800);
  const hash = await tp.evaluate(() => location.hash);
  must(hash === '#/candidate/career', 'the tap on Close fell through to the page underneath: ' + hash);
  await tp.screenshot({ path: join(SHOTS, '360-touch-after-close.png') });
  await tc.close();
});

await check('no page errors, no console errors', async () => {
  must(!pageErrors.length, 'page errors: ' + pageErrors.join(' | '));
  must(!consoleErrors.length, 'console errors: ' + consoleErrors.slice(0, 3).join(' | '));
});
await check('the only new global is TLKeyboard', async () => {
  const g = await page.evaluate(() => Object.keys(window).filter((k) => /tlvk|TLKeyboard/i.test(k)));
  must(g.length === 1 && g[0] === 'TLKeyboard', JSON.stringify(g));
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
