/**
 * The AI calling agent, conversation by conversation.
 *
 * Two halves again, because they fail differently.
 *
 *  1. THE CONVERSATION, driven directly against the engine: English,
 *     Hindi, Telugu, Hinglish, switching language mid-call, the busy
 *     candidate, the angry one, salary and location objections, silence,
 *     bad audio, a wrong number, somebody who wants a recruiter, somebody
 *     who asks a question the agent does not know the answer to.
 *
 *     These run without a database or a telephone because the engine is
 *     pure. That is the point: every branch is reachable in a test, which
 *     is not true of anything that needs a carrier to exercise it.
 *
 *  2. THE WHOLE PATH, through HTTP against the running server: queue a
 *     call to a real candidate for a real requirement, hold the
 *     conversation, and check what the ATS looks like afterwards.
 *
 *   node tools/verify-ai-calling.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import {
  plan, startConversation, openingTurn, nextTurn, callResult, summarise, atsAction, parseWhen,
} from '../api/src/ai/call/agent.js';
import { detectLanguage, languageRequest } from '../api/src/ai/call/language.js';
import { detectIntent } from '../api/src/ai/call/intent.js';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------------------ *
 * fixtures: a real candidate profile and a real requirement
 * ------------------------------------------------------------------ */

const CANDIDATE = {
  id: 'cand_test', name: 'Rahul Sharma', phone: '+91 90000 00001',
  title: 'React Developer', currentCompany: 'Infotech', expYears: 4,
  education: 'B.Tech Computer Science', location: 'Hyderabad',
  skills: ['React', 'JavaScript', 'Redux'], technicalSkills: ['React', 'JavaScript', 'Redux'],
  resumeFile: 'Rahul_Sharma.pdf',
  noticePeriod: null, expectedCtc: null,
};

const JOB = {
  id: 'job_test', title: 'React Developer', location: 'Hyderabad', mode: 'Hybrid',
  skills: ['React', 'TypeScript', 'REST APIs'], salaryMin: 800000, salaryMax: 1200000,
  exp: '3-5 yrs', companyName: 'Northwind',
};

const SETTINGS = {
  agentName: 'Anu', companyName: 'TeamLink Consultants', defaultLanguage: 'en',
  discloseAi: true, recordingEnabled: false, discloseSalary: true, discloseClient: false,
  silencePromptSeconds: 8,
};

/** A conversation, ready to be driven. */
function conversation({ candidate = CANDIDATE, job = JOB, application = null, language } = {}) {
  const p = plan({ candidate, job, application });
  const conv = startConversation({ candidate, job, application, settings: SETTINGS, plan: p, language });
  conv.job = job;
  conv.candidate = candidate;
  openingTurn(conv, SETTINGS);
  return conv;
}

/** Say something, get the reply. */
const reply = (conv, text) => nextTurn(conv, text, SETTINGS);

/* ------------------------------------------------------------------ *
 * 1. language
 * ------------------------------------------------------------------ */
console.log('\nlanguage');

await check('English, Hindi and Telugu are told apart', () => {
  must(detectLanguage('Yes I am interested in the role').language === 'en', 'English missed');
  must(detectLanguage('Haan ji boliye, main sun raha hoon').language === 'hi', 'Hindi missed');
  must(detectLanguage('Avunu andi, nenu vintunnanu cheppandi').language === 'te', 'Telugu missed');
});

await check('native script is decisive', () => {
  must(detectLanguage('हां बोलिए').language === 'hi', 'Devanagari missed');
  must(detectLanguage('అవును చెప్పండి').language === 'te', 'Telugu script missed');
});

await check('Hinglish and Telugu-English are recognised as mixed', () => {
  const hi = detectLanguage('Haan main interested hoon but notice period 60 days hai');
  must(hi.language === 'hi' && hi.mixed, `Hinglish read as ${hi.language}, mixed=${hi.mixed}`);
  const te = detectLanguage('Avunu andi, interest undi but location konchem far');
  must(te.language === 'te' && te.mixed, `Telugu-English read as ${te.language}, mixed=${te.mixed}`);
});

await check('a request to change language is obeyed, not sampled', () => {
  must(languageRequest('Actually English mein baat kar sakte hain') === 'en', 'English request missed');
  must(languageRequest('Telugu lo matladandi') === 'te', 'Telugu request missed');
  must(languageRequest('Hindi mein boliye') === 'hi', 'Hindi request missed');
  // The words "English mein" are Hindi, but the MEANING is "use English".
  const d = detectLanguage('Actually English mein baat kar sakte hain');
  must(d.language === 'en' && d.requested, 'a request was treated as a language sample');
});

await check('a bare technical answer does not switch the language', () => {
  const d = detectLanguage('React, Node, five years', { current: 'hi' });
  must(d.language === 'hi', `switched to ${d.language} on content words alone`);
});

/* ------------------------------------------------------------------ *
 * 2. what the agent asks - and does not ask
 * ------------------------------------------------------------------ */
console.log('\nasking only what is missing');

await check('nothing already on the profile is asked again', () => {
  const p = plan({ candidate: CANDIDATE, job: JOB, application: null });
  const asked = p.needed.join(' ').toLowerCase();
  for (const forbidden of ['name', 'qualification', 'education', 'current company', 'designation']) {
    must(!asked.includes(forbidden), `the agent plans to ask for "${forbidden}", which is already known`);
  }
  must(p.known.some((k) => k.startsWith('name:')), 'the name is not in the known list');
  must(p.known.some((k) => k.startsWith('experience:')), 'the experience is not in the known list');
});

await check('what IS missing is asked', () => {
  const p = plan({ candidate: CANDIDATE, job: JOB, application: null });
  const asked = p.needed.join(' ').toLowerCase();
  must(/notice/.test(asked), 'notice period is not asked although it is missing');
  must(/compensation|ctc/.test(asked), 'expected CTC is not asked although it is missing');
  must(/typescript/i.test(asked), 'a required skill missing from the resume is not asked about');
});

await check('a candidate in the job location is not asked about location', () => {
  const p = plan({ candidate: CANDIDATE, job: JOB, application: null });
  must(!p.askLocation, 'a Hyderabad candidate was going to be asked about Hyderabad');
  const far = plan({
    candidate: { ...CANDIDATE, location: 'Chennai' }, job: JOB, application: null,
  });
  must(far.askLocation, 'a Chennai candidate was not going to be asked about Hyderabad');
});

await check('a remote role asks nobody about location', () => {
  const p = plan({
    candidate: { ...CANDIDATE, location: 'Chennai' },
    job: { ...JOB, mode: 'Remote' }, application: null,
  });
  must(!p.askLocation, 'a remote role was going to ask about relocation');
});

/* ------------------------------------------------------------------ *
 * 3. the conversation
 * ------------------------------------------------------------------ */
console.log('\nthe conversation');

await check('the call opens by asking for the person, not by interrogating them', () => {
  const conv = conversation();
  const open = openingTurn(conv, SETTINGS);
  must(/may i speak with rahul/i.test(open.say), `opened with: "${open.say}"`);
  must(!/notice|salary|experience/i.test(open.say), 'the opening line started screening');
});

await check('it introduces itself, says why it is calling, and asks permission', () => {
  const conv = conversation();
  const r = reply(conv, 'Yes speaking');
  must(/anu/i.test(r.say), 'the agent did not introduce itself');
  must(/teamlink/i.test(r.say), 'the agent did not say who it is calling from');
  must(/ai assistant/i.test(r.say), 'the AI disclosure was not made');
  must(/react developer/i.test(r.say), 'the reason for the call was not given');
  must(/good time/i.test(r.say), 'permission to continue was not asked');
});

await check('an interested candidate is screened on what is missing, one thing at a time', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes, now is fine');
  const r1 = reply(conv, 'Yes I am looking for a change');
  must(/typescript/i.test(r1.say), `expected the TypeScript gap first, got: "${r1.say}"`);
  must(r1.say.split('?').length <= 2, 'more than one question was asked at once');

  const r2 = reply(conv, 'I have used TypeScript for about two years on my current project');
  must(/rest apis?/i.test(r2.say), `expected the second gap, got: "${r2.say}"`);

  const r3 = reply(conv, 'Yes I build REST APIs every day');
  must(/hybrid/i.test(r3.say), `expected the work mode question, got: "${r3.say}"`);

  const r4 = reply(conv, 'Hybrid is fine with me');
  must(/8 to 12|budget/i.test(r4.say), `expected the salary band, got: "${r4.say}"`);

  const r5 = reply(conv, 'I am expecting around 11 LPA');
  must(/join/i.test(r5.say), `expected availability, got: "${r5.say}"`);

  const r6 = reply(conv, 'I have a 30 day notice period');
  must(/interview|forward/i.test(r6.say), `expected the interview question, got: "${r6.say}"`);

  const r7 = reply(conv, 'Yes please go ahead');
  must(/questions/i.test(r7.say), `expected "any questions", got: "${r7.say}"`);

  const r8 = reply(conv, 'No that is all');
  must(r8.end, 'the call did not end');

  const out = callResult(conv);
  must(out.expectedCtc === 1100000, `expected CTC recorded as ${out.expectedCtc}`);
  must(out.noticePeriod === '30 days', `notice period recorded as ${out.noticePeriod}`);
  must(out.interestStatus === 'interested', `interest recorded as ${out.interestStatus}`);
  must(Object.keys(out.screening).length >= 2, 'the screening answers were not kept');
});

await check('a busy candidate is not screened - a callback is taken instead', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const r = reply(conv, "I'm interested but I'm in a meeting right now");
  must(/convenient time|call you back/i.test(r.say), `expected a callback offer, got: "${r.say}"`);
  must(!/notice|salary|typescript/i.test(r.say), 'it carried on screening a busy candidate');

  const r2 = reply(conv, 'Call me tomorrow evening after 6');
  must(r2.end, 'the call did not end after taking the callback');
  must(r2.outcome === 'callback_requested', `outcome was ${r2.outcome}`);
  must(r2.action?.at, 'no callback time was captured');
  const when = new Date(r2.action.at);
  must(when.getHours() >= 18, `callback captured at ${when.getHours()}:00, not the evening`);
});

await check('an angry candidate gets an apology and a way out, never an argument', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const r = reply(conv, "Why are you calling me again? I've already received so many calls!");
  must(/sorry|understand/i.test(r.say), `expected an apology, got: "${r.say}"`);
  must(/update your profile|stop/i.test(r.say), 'it did not offer to stop');
  must(!/opportunity|salary|notice/i.test(r.say), 'it kept selling to an angry candidate');

  const r2 = reply(conv, 'I told you already, this is irritating');
  must(r2.end, 'a second angry turn did not end the call');
  must(r2.action?.interest === 'not_interested', 'the outcome was not recorded');
});

await check('"do not call me again" is obeyed and recorded', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const r = reply(conv, 'Please remove my number and never call me again');
  must(r.end, 'the call did not end');
  must(r.outcome === 'do_not_contact', `outcome was ${r.outcome}`);
  must(r.action?.doNotContact, 'do-not-contact was not flagged');
  must(callResult(conv).doNotContact, 'the result does not carry do-not-contact');
});

await check('a candidate who wants a recruiter gets one, with their question kept', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes go ahead');
  reply(conv, 'Yes I am interested');
  const q = reply(conv, 'Which client is this for?');
  must(/recruiter confirm|incorrect information/i.test(q.say),
    `the agent should not disclose an undisclosed client, said: "${q.say}"`);

  const r = reply(conv, 'Can I speak to a recruiter please?');
  must(r.end, 'the call did not end');
  must(r.outcome === 'recruiter_callback', `outcome was ${r.outcome}`);
  must(r.action?.recruiterCallback, 'no recruiter callback was created');
});

await check('a question it cannot answer is never invented', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes go ahead');
  reply(conv, 'Yes interested');
  const r = reply(conv, 'What is the interview process and how many rounds?');
  must(/recruiter|confirm/i.test(r.say), `the agent invented an answer: "${r.say}"`);
  must(!/\b(two|three|four) rounds\b/i.test(r.say), 'the agent made up a number of rounds');
});

await check('salary above the band is noted, never argued with or promised', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes');
  reply(conv, 'Yes interested');
  reply(conv, 'TypeScript two years');
  reply(conv, 'REST APIs yes');
  reply(conv, 'Hybrid works for me');
  const r = reply(conv, 'I am looking for at least 20 LPA');
  must(/note|recruiter/i.test(r.say), `expected the expectation to be noted, got: "${r.say}"`);
  must(!/guarantee|definitely get|you will get/i.test(r.say), 'the agent promised a salary');
  const out = callResult(conv);
  must(out.expectedCtc === 2000000, `expected CTC recorded as ${out.expectedCtc}`);
  must(out.candidateConcerns.some((x) => /20/.test(x)), 'the gap against the band was not recorded');
});

await check('a location objection is recorded, and the reason classified', () => {
  const conv = conversation({ candidate: { ...CANDIDATE, location: 'Chennai' } });
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes');
  const r = reply(conv, 'Not interested, Hyderabad is too far for me');
  must(/not looking|not suitable/i.test(r.say), `expected the why-not question, got: "${r.say}"`);
  const r2 = reply(conv, 'The location does not work, I cannot relocate');
  must(r2.end, 'the call did not end');
  must(r2.outcome === 'location_mismatch', `outcome was ${r2.outcome}`);
});

await check('silence is escalated gently, then ends with a callback', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const s1 = reply(conv, '');
  must(/still there/i.test(s1.say), `first silence: "${s1.say}"`);
  const s2 = reply(conv, '');
  must(/no problem|moment/i.test(s2.say), `second silence: "${s2.say}"`);
  const s3 = reply(conv, '');
  must(s3.end, 'the third silence did not end the call');
  must(s3.outcome === 'no_response', `outcome was ${s3.outcome}`);
});

await check('repeated audio failure hands off to a recruiter instead of persisting', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const a1 = reply(conv, 'Sorry I cannot hear you, can you repeat?');
  must(/not very clear|repeat/i.test(a1.say), `expected an audio apology, got: "${a1.say}"`);
  reply(conv, 'Still breaking up, say again');
  const a3 = reply(conv, 'I cannot hear anything');
  must(a3.end, 'the agent kept going through three audio failures');
  must(a3.outcome === 'technical_failure', `outcome was ${a3.outcome}`);
});

await check('a wrong number ends the call politely and flags the number', () => {
  const conv = conversation();
  const r = reply(conv, 'You have the wrong number, there is no Rahul here');
  must(r.end, 'the call did not end');
  must(r.outcome === 'wrong_number', `outcome was ${r.outcome}`);
  must(/sorry/i.test(r.say), 'no apology for the trouble');
});

await check('"one minute" is waited out, not treated as an answer', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const r = reply(conv, 'One minute please');
  must(!r.end, 'the call ended on a hold request');
  must(/take your time|of course/i.test(r.say), `expected to wait, got: "${r.say}"`);
});

await check('somebody who already joined elsewhere is closed out correctly', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  const r = reply(conv, 'I have already joined another company last month');
  must(r.end, 'the call did not end');
  must(r.outcome === 'already_joined', `outcome was ${r.outcome}`);
});

/* ------------------------------------------------------------------ *
 * 4. language, during the call
 * ------------------------------------------------------------------ */
console.log('\nlanguage, mid-call');

await check('a Hindi answer switches the agent to Hindi', () => {
  const conv = conversation();
  const r = reply(conv, 'Haan ji boliye');
  must(conv.language === 'hi', `the agent stayed in ${conv.language}`);
  must(/main|bol|hoon|rahi/i.test(r.say), `the reply was not Hindi: "${r.say}"`);
});

await check('a Telugu answer switches the agent to Telugu', () => {
  const conv = conversation();
  const r = reply(conv, 'Avunu andi cheppandi');
  must(conv.language === 'te', `the agent stayed in ${conv.language}`);
  must(/nenu|meeru|chestunna|undi/i.test(r.say), `the reply was not Telugu: "${r.say}"`);
});

await check('switching language mid-call is immediate', () => {
  const conv = conversation();
  reply(conv, 'Haan boliye');
  must(conv.language === 'hi', 'did not switch to Hindi');
  const r = reply(conv, 'Actually English mein baat kar sakte hain?');
  must(conv.language === 'en', `did not switch back, still ${conv.language}`);
  must(!/main |aap |hoon/i.test(r.say), `still speaking Hindi: "${r.say}"`);
  must(conv.languageSwitched, 'the switch was not recorded');
});

await check('technical words stay in English in every language', () => {
  const conv = conversation();
  reply(conv, 'Avunu cheppandi');
  reply(conv, 'Sare');
  const r = reply(conv, 'Avunu interest undi');
  must(/typescript/i.test(r.say), `the skill name was not kept in English: "${r.say}"`);
});

/* ------------------------------------------------------------------ *
 * 5. what the ATS receives
 * ------------------------------------------------------------------ */
console.log('\nwhat the ATS receives');

await check('the summary states only what was actually said', () => {
  const conv = conversation();
  reply(conv, 'Yes speaking');
  reply(conv, 'Yes');
  reply(conv, 'Yes I am interested');
  reply(conv, 'TypeScript for two years');
  reply(conv, 'Yes REST APIs daily');
  reply(conv, 'Hybrid is fine');
  reply(conv, 'Around 11 LPA');
  reply(conv, '30 days notice');
  reply(conv, 'Yes please');
  reply(conv, 'No questions');

  const s = summarise(conv, { candidate: CANDIDATE, job: JOB });
  must(/interested/i.test(s), `the summary does not state interest: ${s}`);
  must(/11 LPA/i.test(s), `the summary does not state the expectation: ${s}`);
  must(/30 days/i.test(s), `the summary does not state the notice period: ${s}`);
  must(/English/i.test(s), 'the summary does not state the language');
  // Nothing invented: the candidate never mentioned relocation.
  must(!/relocat/i.test(s), `the summary invented a relocation answer: ${s}`);
});

await check('the ATS action never claims somebody was selected', () => {
  const interested = conversation();
  interested.interest = 'interested';
  interested.outcome = 'interested';
  const a = atsAction(interested);
  must(!/select/i.test(a.note), `the note says "${a.note}"`);
  must(a.stage === null, `an AI call moved the application to "${a.stage}"`);

  const no = conversation();
  no.outcome = 'not_interested';
  must(atsAction(no).stage === 'rejected', 'a clear no did not close the application');

  const cb = conversation();
  cb.outcome = 'callback_requested';
  must(atsAction(cb).stage === null, 'a callback moved the stage');
  must(/callback/i.test(atsAction(cb).note), 'the callback note is wrong');
});

await check('"call me at 6" is understood in all three languages', () => {
  const now = new Date('2026-09-22T10:00:00');
  must(parseWhen('call me at 6 in the evening', now).getHours() === 18, 'English evening missed');
  must(parseWhen('kal shaam ko 7 baje', now).getHours() === 19, 'Hindi evening missed');
  must(parseWhen('repu sayantram 6 gantalaki', now).getHours() === 18, 'Telugu evening missed');
  must(parseWhen('tomorrow morning', now).getDate() === 23, 'tomorrow was not understood');
});

/* ------------------------------------------------------------------ *
 * 6. the whole path, against the running server
 * ------------------------------------------------------------------ */
console.log('\nthe whole path');

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) =>
        window.TL.api[mm](pp, bb).then((ok) => ({ ok: true, value: ok }),
          (e) => ({ ok: false, code: e.code, message: e.message })), [m, p, b]);
      if (r.ok) return r.value;
      const err = new Error(`${r.code || 'FAILED'}: ${r.message || ''}`);
      err.code = r.code;
      throw err;
    },
  };
};

const recruiter = await open();
const candidate = await open();
const stamp = Date.now();
let candidateId, jobId, callId;

await check('a recruiter can see which telephony provider is active', async () => {
  await recruiter.api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  await recruiter.page.evaluate(() => window.TL.refresh());
  await recruiter.page.waitForTimeout(600);

  const st = await recruiter.api('get', '/ai-calling/status');
  must(st.telephony, 'no telephony status was returned');
  must(st.telephony.active, 'no active provider');
  must(st.settings.agentName, 'the agent has no name configured');
  console.log(`        provider: ${st.telephony.active}` +
    (st.telephony.missing?.length ? ` (missing: ${st.telephony.missing.join(', ')})` : ''));
});

await check('a candidate with a phone number and a requirement exists', async () => {
  const reg = await candidate.api('post', '/auth/register', {
    name: 'Rahul Callme', email: `call.${stamp}@example.test`, password: 'CallMe@2026',
  });
  candidateId = reg.candidateId;
  await candidate.api('put', `/candidates/${candidateId}`, {
    phone: '+91 90000 33333', title: 'React Developer', location: 'Hyderabad',
    expYears: 4, skills: ['React', 'JavaScript'], technicalSkills: ['React', 'JavaScript'],
    currentCompany: 'Infotech', education: 'B.Tech',
  });

  const companyId = await recruiter.page.evaluate(() => {
    const rec = (DATA.recruiters || []).find((r) => r.email === 'recruiter@teamlink.com');
    return rec ? rec.companyId : (DATA.companies[0] || {}).id;
  });
  const job = await recruiter.api('post', '/jobs', {
    title: `React Developer ${stamp}`, companyId, location: 'Hyderabad', mode: 'Hybrid',
    exp: '3-5 yrs', salaryMin: 800000, salaryMax: 1200000,
    skills: ['React', 'TypeScript'], status: 'open',
    desc: 'Building React interfaces against REST services.',
  });
  jobId = job.job.id;
  must(candidateId && jobId, 'the fixtures were not created');
});

await check('the recruiter can see the plan BEFORE anybody is called', async () => {
  const { plan: p } = await recruiter.api(
    'get', `/ai-calling/plan?candidateId=${candidateId}&jobId=${jobId}`);
  must(p, 'no plan was returned');
  must(p.known.some((k) => /name:/.test(k)), 'the plan does not list the known name');
  must(!p.needed.join(' ').toLowerCase().includes('name'), 'the plan would ask for the name');
  must(p.objective, 'the call has no objective');
});

await check('placing a call records a session, an objective and the opening line', async () => {
  const out = await recruiter.api('post', '/ai-calling/call', { candidateId, jobId });
  callId = out.call.id;
  must(callId, 'no call session was created');
  must(/may i speak with rahul/i.test(out.say), `opening line was: "${out.say}"`);
  must(out.call.provider, 'the call records no provider');
});

await check('the conversation runs, and the transcript is stored turn by turn', async () => {
  const turns = [
    'Yes speaking', 'Yes now is fine', 'Yes I am interested',
    'I have used TypeScript for two years', 'Hybrid is fine',
    'Around 10 LPA', '30 days notice', 'Yes please go ahead', 'No questions thanks',
  ];
  let last;
  for (const t of turns) {
    last = await recruiter.api('post', `/ai-calling/calls/${callId}/say`, { text: t });
    if (last.end) break;
  }
  must(last.end, 'the conversation never ended');

  const { call, transcript } = await recruiter.api('get', `/ai-calling/calls/${callId}`);
  must(transcript.length >= 8, `only ${transcript.length} turns were stored`);
  must(transcript.some((t) => t.speaker === 'agent'), 'no agent turns stored');
  must(transcript.some((t) => t.speaker === 'candidate'), 'no candidate turns stored');
  must(call.summary, 'no summary was generated');
  must(call.interestStatus === 'interested', `interest recorded as ${call.interestStatus}`);
  must(call.expectedCtc === 1000000, `expected CTC stored as ${call.expectedCtc}`);
  must(call.noticePeriod, 'the notice period was not stored');
  must(call.durationSeconds >= 0, 'no duration was recorded');
});

await check('the ATS carries the result: the profile is updated from the call', async () => {
  const { candidates } = await recruiter.api('get', `/candidates?q=${encodeURIComponent('Rahul Callme')}`);
  const c = (candidates || []).find((x) => x.id === candidateId);
  must(c, 'the candidate could not be read back');
  must(Number(c.expectedCtc) === 1000000,
    `the profile's expected CTC is ${c.expectedCtc}, not what the candidate said`);
  must(c.noticePeriod, 'the notice period from the call is not on the profile');
});

await check('the call appears in the candidate call history', async () => {
  const { calls } = await recruiter.api('get', `/ai-calling/calls?candidateId=${candidateId}`);
  must(calls.length >= 1, 'no calls in the history');
  const mine = calls.find((c) => c.id === callId);
  must(mine, 'this call is not in the history');
  must(mine.summary, 'the history row has no summary');
  must(mine.language, 'the history row has no language');
});

await check('the dashboard counts it', async () => {
  const d = await recruiter.api('get', '/ai-calling/dashboard');
  must(d.totals.total >= 1, 'the dashboard shows no calls');
  must(d.totals.interested >= 1, 'the dashboard does not count the interested candidate');
  must(Array.isArray(d.byLanguage), 'no language breakdown');
});

await check('a second call to the same candidate for the same job is refused', async () => {
  // The first finished, so a repeat IS allowed; a live one is not. Start
  // one and try to start another.
  const a = await recruiter.api('post', '/ai-calling/call', { candidateId, jobId });
  let refused = null;
  try {
    await recruiter.api('post', '/ai-calling/call', { candidateId, jobId });
  } catch (e) { refused = e.code; }
  must(refused === 'CALL_IN_PROGRESS', `a duplicate call was allowed (${refused})`);
  await recruiter.api('post', `/ai-calling/calls/${a.call.id}/end`, {});
});

await check('a candidate who asked not to be contacted is never dialled', async () => {
  const c2 = await open();
  const reg = await c2.api('post', '/auth/register', {
    name: 'Stop Calling', email: `stop.${stamp}@example.test`, password: 'StopIt@2026',
  });
  await c2.api('put', `/candidates/${reg.candidateId}`, { phone: '+91 90000 44444' });

  const call = await recruiter.api('post', '/ai-calling/call',
    { candidateId: reg.candidateId, jobId });
  await recruiter.api('post', `/ai-calling/calls/${call.call.id}/say`, { text: 'Yes speaking' });
  const r = await recruiter.api('post', `/ai-calling/calls/${call.call.id}/say`,
    { text: 'Please remove my number and never call me again' });
  must(r.end, 'the call did not end');

  let refused = null;
  try {
    await recruiter.api('post', '/ai-calling/call', { candidateId: reg.candidateId, jobId });
  } catch (e) { refused = e.code; }
  must(refused === 'DO_NOT_CONTACT', `a do-not-contact candidate could be called again (${refused})`);
});

await check('a candidate cannot read anybody else’s call', async () => {
  const seen = await candidate.api('get', `/ai-calling/calls?candidateId=${candidateId}`)
    .catch(() => ({ calls: [] }));
  must(seen.calls.every((c) => c.candidateId === candidateId),
    'a candidate can read calls belonging to somebody else');
});

await check('a campaign queues many, and skips the ones it must not call', async () => {
  const ids = await recruiter.page.evaluate(() =>
    (DATA.candidates || []).slice(0, 6).map((c) => c.id));
  const out = await recruiter.api('post', '/ai-calling/campaign', {
    jobId, candidateIds: ids, name: `Campaign ${stamp}`, languageMode: 'auto',
  });
  must(out.campaign.id, 'no campaign was created');
  must(out.queued.length + out.skipped.length === ids.length,
    'the campaign did not account for every candidate');
  for (const s of out.skipped) must(s.reason, `a candidate was skipped with no reason`);
});

await browser.close();
console.log(failed === 0
  ? '\n  AI CALLING VERIFIED — three languages, dynamic conversation, ATS updated from the call\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
