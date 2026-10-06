/**
 * The AI interviewer with a model behind it - a MOCKED one.
 *
 * The mock deliberately writes the questions the owner's brief forbids:
 * gap phrasing, a 40-word question and protected personal topics. The
 * style post-filter (api/src/ai/interview-style.js) must rewrite or drop
 * every one of them before a candidate could hear it, and top the plan
 * back up to the full blueprint. Follow-ups: the model may only choose one
 * of the owner's templates; anything else it writes is ignored.
 *
 * Nothing leaves the machine: AI_API_URL points at a local server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const MOCK_PORT = 9943;
let mock, interview, style;
const seen = [];
let reply = () => '[]';

test('boot', async () => {
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: reply(JSON.parse(body || '{}')) }] }));
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AI_API_KEY: 'test-key-not-real',
    AI_API_URL: `http://127.0.0.1:${MOCK_PORT}/v1/messages`,
    AI_TIMEOUT_MS: '3000',
  });
  interview = await import('../src/ai/interview.js');
  style = await import('../src/ai/interview-style.js');
  assert.equal(interview.aiConfigured(), true);
});

const job = { title: 'HR Recruiter', skills: ['Sourcing', 'ATS', 'Excel'], requirements: [], responsibilities: [], desc: '' };
const candidate = { skills: ['Excel'], title: 'HR Executive', currentCompany: 'Acme' };

test('a deliberately bad model plan is corrected by the post-filter', async () => {
  reply = () => JSON.stringify([
    { category: 'intro', question: 'Thanks for joining. Please tell me about yourself and your recent work.', topic: 'introduction' },
    { category: 'technical', topic: 'Sourcing',
      question: 'The role asks for Sourcing, which I could not find on your resume. What is your experience with it?' },
    { category: 'technical', topic: 'ATS', question: "You haven't used an ATS. Why not?" },
    { category: 'technical', question: 'Your resume does not show Excel, so tell me about it.' },
    { category: 'technical', topic: 'Sourcing',
      question: 'Walk me through, in as much detail as you possibly can, every sourcing channel you have ever used, '
        + 'why you chose each one, how well it worked, and what you would change about each of them today?' },
    { category: 'behavioral', question: 'How old are you, and are you married?' },
    { category: 'behavioral', question: 'Which religion do you follow?' },
    { category: 'behavioral', question: 'Tell me about a time you resolved a disagreement with a hiring manager.' },
  ]);
  const plan = await interview.planInterview({ job, candidate, count: 15 });

  // The model was given the owner's prompt file as its system prompt.
  const sys = seen[seen.length - 1].body.system;
  assert.match(sys, /NEVER mention what is missing, absent or not found on the resume/);
  assert.match(sys, /Thank you for being open\. How would you approach learning it\?/);
  assert.equal(seen[seen.length - 1].headers['x-api-key'], 'test-key-not-real', 'the key goes to the provider only');

  assert.equal(plan.length, 15, 'topped back up to the blueprint');
  const text = plan.map((q) => q.question);
  for (const q of text) {
    assert.equal(style.bannedPhrase(q), null, `gap phrasing reached the candidate: ${q}`);
    assert.equal(style.protectedTopic(q), null, `protected topic reached the candidate: ${q}`);
    assert.ok(style.wordCount(q) <= style.MAX_QUESTION_WORDS, `${style.wordCount(q)} words: ${q}`);
  }
  assert.ok(text.includes('Sourcing is a key part of this role. Could you walk me through your experience with it?'),
    'the bad Sourcing question became the owner\'s good one');
  assert.ok(!text.some((q) => /married|religion|how old/i.test(q)), 'a protected question survived');
  assert.ok(text.includes('Tell me about a time you resolved a disagreement with a hiring manager.'), 'a good question was kept');
  assert.deepEqual(plan.map((q) => q.seq), plan.map((_, i) => i + 1), 'renumbered');
});

test('a model plan that is mostly unusable falls back to the rules plan, in the same style', async () => {
  reply = () => JSON.stringify([
    { category: 'behavioral', question: 'What is your caste?' },
    { category: 'behavioral', question: 'Do you have any medical condition?' },
  ]);
  const plan = await interview.planInterview({ job, candidate, count: 15 });
  assert.equal(plan.length, 15);
  assert.ok(plan.every((q) => q.section), 'came from the rules planner');
  assert.ok(plan.every((q) => style.bannedPhrase(q.question) === null && style.wordCount(q.question) <= 24));
});

test('follow-ups: the model may only pick one of the owner\'s templates', async () => {
  const ask = (answer) => interview.decideFollowUp({ question: { question: 'Tell me about sourcing.' }, answer, job });

  reply = () => JSON.stringify({ choice: 'outcome' });
  assert.deepEqual(await ask('I sourced candidates for the warehouse drive last year using job boards.'),
    { text: 'What was the outcome?', kind: 'outcome', engine: 'model' });

  reply = () => JSON.stringify({ choice: 'none' });
  assert.equal(await ask('I sourced candidates for the warehouse drive last year using job boards.'), null);

  // Free text from the model is NOT a template: the deterministic rules decide.
  reply = () => JSON.stringify({ choice: 'You did not mention LinkedIn. Why not?' });
  const r = await ask('Yes.');
  assert.equal(r.engine, 'rules');
  assert.equal(r.text, 'Could you share a specific example?');

  // "No experience" is answered with the owner's words, model or not.
  reply = () => JSON.stringify({ choice: 'tools' });
  assert.equal((await ask("I haven't used it before.")).text,
    'Thank you for being open. How would you approach learning it?');
});

test('a provider failure never blocks the interview', async () => {
  reply = () => 'not json at all';
  const plan = await interview.planInterview({ job, candidate, count: 15 });
  assert.equal(plan.length, 15);
  assert.equal((await interview.decideFollowUp({ question: { question: 'q' }, answer: 'Yes.', job })).engine, 'rules');
});

test('shutdown', async () => {
  await new Promise((r) => mock.close(r));
});
