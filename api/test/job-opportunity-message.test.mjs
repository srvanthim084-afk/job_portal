/**
 * The "new job opportunity" message (owner, 2026-10-06) - the one format
 * every job alert and Share Job use (api/src/notify/job-opportunity.js).
 *
 * Pure unit tests: no database, no server, nothing sent. Every job below is
 * a made-up fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jobOpportunityMessage, jobOpportunityMessages, workFromHome, requirementPoints,
  shortenRequirement, highlightsFrom,
} from '../src/notify/job-opportunity.js';
import { shareText, shareLines } from '../src/portal/core.js';

const URL = 'https://jobs.example.in/?alert=jm_abc123#/job/j_fixture_1';

const FULL = {
  id: 'j_fixture_1',
  title: 'Staff Nurse (ICU)',
  location: 'Nellore',
  exp: '2-4 yrs',
  education: 'B.Sc Nursing / GNM',
  pay: '₹3-4.5 LPA',
  type: 'Full-time',
  mode: 'Onsite',
  requirements: [
    'Candidates should have a valid nursing council registration.',
    'Good communication skills',
    'good communication skills.',
    'Must have 2 years of ICU experience in a multi-speciality hospital. Willing to work in rotational shifts including nights',
  ],
  desc: 'A reputed hospital in Nellore is hiring ICU nurses. We offer a competitive salary package and career growth. '
    + 'Free accommodation for outstation candidates. No incentives.',
};

const FULL_EXPECTED = [
  '*🚀 NEW JOB OPPORTUNITY – Nellore*',
  '',
  'Hi! 👋 We found a job opportunity that could be a great match for your profile!',
  '',
  '🏥 *Staff Nurse (ICU)*',
  '🏢 *Sunrise Hospitals*',
  '',
  '💼 Experience: *2-4 yrs*',
  '🎓 Qualification: B.Sc Nursing / GNM',
  '💰 Salary: *₹3-4.5 LPA*',
  '📍 Location: *Nellore*',
  '🕐 Job Type: Full-time',
  '🏠 Work From Home: Not Available',
  '',
  "*⭐ What We're Looking For*",
  '✅ Valid nursing council registration',
  '✅ Good communication skills',
  '✅ 2 years of ICU experience in a multi-speciality hospital',
  '✅ Willing to work in rotational shifts including nights',
  '',
  '*🎯 Why Consider This Opportunity?*',
  '✨ Competitive salary package',
  '✨ Career growth opportunity',
  '✨ Accommodation provided',
  '✨ Work with a reputed hospital',
  '',
  '*👉 Interested? Explore the complete job details and apply now:*',
  `🔗 ${URL}`,
  "📩 Don't miss this opportunity — apply today!",
  '',
  '*Sunrise Hospitals*',
  'Caring for Nellore since 1998',
].join('\n');

const PLACEHOLDERS = /\b(undefined|null|NaN|N\/A)\b|\[object Object\]|\b(Experience|Qualification|Salary|Location|Job Type|Work From Home):\s*$/m;

test('a full job: exactly the owner\'s format, WhatsApp bold on headings and key values', () => {
  const m = jobOpportunityMessages(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', tagline: 'Caring for Nellore since 1998' });
  assert.equal(m.whatsapp, FULL_EXPECTED);
  assert.equal(m.inApp, m.whatsapp, 'in-app is the full format too');
  assert.equal(m.text, FULL_EXPECTED.replace(/\*/g, ''), 'the plain text is the same lines without the bold markers');
  assert.equal(jobOpportunityMessage(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', tagline: 'Caring for Nellore since 1998', channel: 'whatsapp' }),
    FULL_EXPECTED);
  /* deterministic */
  assert.equal(jobOpportunityMessages(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', tagline: 'Caring for Nellore since 1998' }).whatsapp,
    FULL_EXPECTED);
});

test('missing fields: their lines are left out - never null, undefined, N/A or an empty label', () => {
  const thin = { id: 'j2', title: 'Field Assistant', location: null, exp: 'N/A', education: '', pay: 'undefined',
    type: null, mode: undefined, requirements: [], desc: '' };
  const m = jobOpportunityMessages(thin, { applyUrl: 'https://jobs.example.in/#/job/j2', company: '' });
  assert.equal(m.whatsapp, [
    '*🚀 NEW JOB OPPORTUNITY*',
    '',
    'Hi! 👋 We found a job opportunity that could be a great match for your profile!',
    '',
    '🏥 *Field Assistant*',
    '',
    '*👉 Interested? Explore the complete job details and apply now:*',
    '🔗 https://jobs.example.in/#/job/j2',
    "📩 Don't miss this opportunity — apply today!",
  ].join('\n'));
  for (const out of [m.whatsapp, m.text, m.sms, m.email.text, m.email.subject]) {
    assert.equal(PLACEHOLDERS.test(out), false, `a placeholder or an empty label in:\n${out}`);
    for (const label of ['Experience', 'Qualification', 'Salary', 'Location', 'Job Type', 'Work From Home', "What We're Looking For", 'Why Consider']) {
      assert.equal(out.includes(label), false, `"${label}" printed for a job without it`);
    }
  }
  assert.equal(/undefined|null|N\/A/.test(m.email.html), false);
  /* no job at all is still a readable message, not a crash */
  assert.doesNotThrow(() => jobOpportunityMessages(null, {}));
  assert.equal(PLACEHOLDERS.test(jobOpportunityMessages({}, {}).text), false);
});

test('Work From Home follows the job\'s mode: remote / hybrid / onsite / unknown', () => {
  assert.equal(workFromHome('Remote'), 'Available');
  assert.equal(workFromHome('Work From Home'), 'Available');
  assert.equal(workFromHome('Hybrid'), 'Hybrid');
  assert.equal(workFromHome('Onsite'), 'Not Available');
  assert.equal(workFromHome('On-site'), 'Not Available');
  assert.equal(workFromHome('Work From Office'), 'Not Available');
  assert.equal(workFromHome(''), '');
  assert.equal(workFromHome(null), '');
  assert.equal(workFromHome('Flexible'), '', 'an unknown mode prints no line');
  const line = (mode) => jobOpportunityMessages({ title: 'X', mode }, { applyUrl: URL }).text
    .split('\n').find((l) => l.startsWith('🏠')) || null;
  assert.equal(line('Remote'), '🏠 Work From Home: Available');
  assert.equal(line('Hybrid'), '🏠 Work From Home: Hybrid');
  assert.equal(line('Onsite'), '🏠 Work From Home: Not Available');
  assert.equal(line(undefined), null);
  assert.equal(line('Something else'), null);
});

test('duplicate requirements are removed (case, punctuation and spacing ignored)', () => {
  assert.deepEqual(requirementPoints([
    'Good communication skills', 'good  communication skills.', 'GOOD COMMUNICATION SKILLS!', '• Good communication skills',
    'MS Excel', 'MS-Excel', 'Telugu & English',
  ]), ['Good communication skills', 'MS Excel', 'Telugu & English']);
  /* a shortened one that equals another is a duplicate too */
  assert.deepEqual(requirementPoints(['Candidates must have a two-wheeler', 'Two-wheeler']), ['Two-wheeler']);
  /* a string of lines or ;-separated points, like a requirements textarea */
  assert.deepEqual(requirementPoints('Driving licence; driving licence\nSmartphone'), ['Driving licence', 'Smartphone']);
});

test('long requirement sentences become short points without changing what they say', () => {
  assert.deepEqual(shortenRequirement('Candidates should have good communication skills in Telugu and English.'),
    ['Good communication skills in Telugu and English']);
  assert.deepEqual(shortenRequirement('The ideal candidate must possess a valid two-wheeler driving licence.'),
    ['Valid two-wheeler driving licence']);
  assert.deepEqual(shortenRequirement('Must have 2+ years of experience in field sales'), ['2+ years of experience in field sales']);
  assert.deepEqual(shortenRequirement('We are looking for someone with strong Excel skills'), ['Strong Excel skills']);
  assert.deepEqual(shortenRequirement('Required: B.Com graduate'), ['B.Com graduate']);
  /* several sentences in one long requirement: each kept whole, as its own point */
  assert.deepEqual(shortenRequirement('Must have 3 years of experience handling hospital billing and insurance claims. '
    + 'Should be comfortable working night shifts when the department needs cover.'),
  ['3 years of experience handling hospital billing and insurance claims',
    'Should be comfortable working night shifts when the department needs cover']);
  /* words that carry the meaning stay: "not", numbers, "only" */
  assert.deepEqual(shortenRequirement('Candidates should not be older than 35 years'), ['Candidates should not be older than 35 years']);
  assert.deepEqual(shortenRequirement('Female candidates only'), ['Female candidates only']);
});

test('no highlights section when the description does not support at least two', () => {
  assert.deepEqual(highlightsFrom(''), []);
  assert.deepEqual(highlightsFrom('We are hiring a driver for our Nellore branch. Apply now.'), []);
  assert.deepEqual(highlightsFrom('Competitive salary.'), [], 'one highlight is not a section');
  /* negations are never turned into benefits */
  assert.deepEqual(highlightsFrom('No accommodation provided. Salary is not competitive. No incentives.'), []);
  /* words that look like benefits but are not */
  assert.deepEqual(highlightsFrom('Bonus points if you know Tally. Run sales promotions. Help guests with accommodation bookings.'), []);
  const none = jobOpportunityMessages({ title: 'Driver', desc: 'Drive the company van in Nellore.' }, { applyUrl: URL }).whatsapp;
  assert.equal(none.includes('Why Consider This Opportunity'), false);
  assert.equal(none.includes('✨'), false);
  /* and at most four */
  assert.equal(highlightsFrom('Competitive salary. Career growth. Health insurance. PF and ESI. Training provided. Cab facility.').length, 4);
});

test('the apply URL is printed exactly as the system made it', () => {
  const odd = 'https://jobs.example.in/?alert=jm_x%2By&ss=s_1#/job/j%201?ref=Ab_-9';
  const m = jobOpportunityMessages(FULL, { applyUrl: odd, company: 'Sunrise Hospitals' });
  assert.ok(m.whatsapp.split('\n').includes(`🔗 ${odd}`));
  assert.ok(m.text.split('\n').includes(`🔗 ${odd}`));
  assert.ok(m.sms.endsWith(`Apply: ${odd}`));
  assert.ok(m.email.html.includes(`href="${odd.replace(/&/g, '&amp;')}"`), 'the button and the link point at it');
  /* the share link is the share link */
  const link = 'https://jobs.example.in/job/j_fixture_1?ref=abc123';
  const t = shareText(FULL, link, { company: 'Sunrise Hospitals' });
  assert.ok(t.split('\n').includes(`🔗 ${link}`));
  /* the title too: exactly the database's */
  assert.ok(m.whatsapp.includes('🏥 *Staff Nurse (ICU)*'));
});

test('a client company name is never shown (0051)', () => {
  for (const company of ['Client Partner Hospitals', 'Our Client', 'ACME clients pvt ltd']) {
    const m = jobOpportunityMessages(FULL, { applyUrl: URL, company });
    for (const out of [m.whatsapp, m.text, m.sms, m.email.text, m.email.html, m.email.subject]) {
      assert.equal(/client/i.test(out), false, `"${company}" reached the candidate:\n${out.slice(0, 200)}`);
    }
    assert.equal(m.whatsapp.includes('🏢'), false, 'no company line at all');
  }
  /* the label a candidate's card shows (companyLabel -> TeamLink) is printed */
  assert.ok(jobOpportunityMessages(FULL, { applyUrl: URL, company: 'TeamLink' }).whatsapp.includes('🏢 *TeamLink*'));
});

test('email: escaped HTML with one Apply button, and a plain-text part', () => {
  const evil = { ...FULL, title: '<script>alert("x")</script> Nurse & Co', location: 'Nellore <b>', requirements: ['<img src=x onerror=alert(1)>'] };
  const e = jobOpportunityMessage(evil, { applyUrl: URL, company: 'A & B "Hospitals"', channel: 'email' });
  assert.equal(e.html.includes('<script>'), false, 'a <script> in the title is not markup');
  assert.equal(e.html.includes('<img'), false);
  assert.ok(e.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Nurse &amp; Co'));
  assert.ok(e.html.includes('A &amp; B &quot;Hospitals&quot;'));
  assert.ok(e.html.includes('>View Job &amp; Apply</a>'), 'one prominent button');
  assert.equal((e.html.match(/bgcolor="#1d6ff2"/g) || []).length, 1, 'exactly one button');
  assert.ok(e.html.includes('name="viewport"'), 'mobile-friendly shell');
  assert.ok(e.text.includes('🏥 <script>alert("x")</script> Nurse & Co'), 'the text part carries the title as written');
  assert.equal(e.text.includes('*'), false, 'no WhatsApp markers in the email');
  assert.ok(e.subject.length > 0);
  /* the same content as the other channels */
  const full = jobOpportunityMessage(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', channel: 'email' });
  for (const s of ["What We're Looking For", 'Valid nursing council registration', 'Why Consider This Opportunity?',
    'Competitive salary package', '₹3-4.5 LPA', 'Interested? Explore the complete job details and apply now:']) {
    assert.ok(full.html.replace(/&#39;/g, "'").replace(/&amp;/g, '&').includes(s), `email html is missing "${s}"`);
    assert.ok(full.text.includes(s), `email text is missing "${s}"`);
  }
});

test('SMS is the compact version: heading, title, company, location, salary, link', () => {
  const sms = jobOpportunityMessage(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', channel: 'sms' });
  assert.equal(sms, `TeamLink: New job opportunity: Staff Nurse (ICU) at Sunrise Hospitals, Nellore. Salary: ₹3-4.5 LPA. Apply: ${URL}`);
  assert.ok(sms.length <= 320);
  for (const w of ['Qualification', 'What We', '✅', '✨', '\n']) assert.equal(sms.includes(w), false, `"${w}" in an SMS`);
  /* too long: the salary, then the location, then the company go - never the link */
  const long = jobOpportunityMessage({ ...FULL, title: 'Senior '.repeat(60) + 'Nurse' }, { applyUrl: URL, company: 'Sunrise Hospitals', channel: 'sms' });
  assert.ok(long.length <= 320, String(long.length));
  assert.ok(long.endsWith(`Apply: ${URL}`));
  /* why it was sent, where the alert already said so */
  assert.match(jobOpportunityMessage(FULL, { applyUrl: URL, kind: 'saved_search', label: 'Nurse · Nellore', channel: 'sms' }),
    /^TeamLink: New job for "Nurse · Nellore": Staff Nurse \(ICU\)/);
  assert.match(jobOpportunityMessage(FULL, { applyUrl: URL, kind: 'urgent_hiring', channel: 'sms' }), /^TeamLink: Urgent hiring: /);
});

test('alert types change only the heading and the opening line; the body is identical', () => {
  const body = (s) => s.split('\n').slice(3).join('\n');
  const base = jobOpportunityMessages(FULL, { applyUrl: URL, company: 'Sunrise Hospitals' }).whatsapp;
  const kinds = {
    saved_search: { label: 'ICU Nurse' },
    saved_job: { savedTitle: 'Staff Nurse', savedCompany: 'Sunrise Hospitals', savedLocation: 'Nellore' },
    urgent_hiring: { matchPercent: 80 },
    deadline_2d: { matchPercent: 80, deadline: '8 Oct 2026' },
    deadline_today: { matchPercent: 80 },
    share: {},
  };
  for (const [kind, extra] of Object.entries(kinds)) {
    const m = jobOpportunityMessages(FULL, { applyUrl: URL, company: 'Sunrise Hospitals', kind, ...extra }).whatsapp;
    assert.equal(body(m), body(base), `the body changed for ${kind}`);
  }
  const ss = jobOpportunityMessages(FULL, { applyUrl: URL, kind: 'saved_search', label: 'ICU Nurse' }).whatsapp;
  assert.match(ss, /saved search "ICU Nurse"/);
  const sj = jobOpportunityMessages(FULL, { applyUrl: URL, kind: 'saved_job', savedTitle: 'Staff Nurse', savedCompany: 'Client X', savedLocation: 'Nellore' }).whatsapp;
  assert.match(sj, /You saved "Staff Nurse" \(Nellore\)/, 'a client name in the saved job is dropped too');
  assert.match(jobOpportunityMessages(FULL, { applyUrl: URL, kind: 'urgent_hiring', matchPercent: 80 }).whatsapp,
    /^\*🚀 URGENT HIRING – Nellore\*\n\nHi! 👋 We found an urgent job opening that could be a great match for your profile \(80% match\)!/);
  assert.equal(base.split('\n')[2], 'Hi! 👋 We found a job opportunity that could be a great match for your profile!');
});

test('Share Job uses the same format: body = the message without its link line; walk-in block kept', () => {
  const link = 'https://jobs.example.in/job/w1?ref=abc123';
  const walk = {
    title: 'HR Recruiter', location: 'KPHB, Hyderabad', pay: '₹3 LPA', exp: '0-Any', postingKind: 'walkin', type: 'Walk-in',
    education: 'Any Degree', requirements: ['Good Communication Skills', 'Telugu & English are Mandatory'],
    walkinDate: '2026-10-10', walkinStartTime: '10:00', walkinEndTime: '16:00',
    walkinVenue: 'TeamLink Consultants (OPC) Pvt. Ltd.', walkinContactPerson: 'HR Desk', walkinContactNumber: '9000000000',
  };
  const t = shareText(walk, link, { company: '' });
  const lines = t.split('\n');
  for (const l of ['*🚀 NEW JOB OPPORTUNITY – KPHB, Hyderabad*', 'Hi! 👋 We found a job opportunity that could be a great match for your profile!',
    '🏥 *HR Recruiter*', '*🚶 Walk-In Interview*', '📅 Walk-In Date: 10 October 2026', '⏰ Interview Time: 10:00 AM – 4:00 PM',
    '• Updated Resume – Hard Copy', '⚠️ Important: The job post copy must be shown at the main gate entrance.',
    '📞 Contact: HR Desk – 9000000000', `🔗 ${link}`]) {
    assert.ok(lines.includes(l), `missing: ${l}\n${t}`);
  }
  assert.ok(lines.indexOf('*🚶 Walk-In Interview*') < lines.indexOf('*👉 Interested? Explore the complete job details and apply now:*'),
    'the walk-in block comes before the apply CTA');
  assert.equal(t.includes('Job Type: Walk-in'), false);
  assert.equal(shareLines(walk, { company: '' }).join('\n'), lines.filter((l) => l !== `🔗 ${link}`).join('\n'));
  /* a regular job has no walk-in block */
  const reg = shareText(FULL, link, { company: 'Sunrise Hospitals' });
  for (const w of ['Walk-In', 'main gate', 'Please carry']) assert.equal(reg.includes(w), false);
  /* WhatsApp link encoding survives emojis, ₹, & and new lines */
  const wa = `https://wa.me/?text=${encodeURIComponent(t)}`;
  assert.equal(decodeURIComponent(wa.slice('https://wa.me/?text='.length)), t);
});
