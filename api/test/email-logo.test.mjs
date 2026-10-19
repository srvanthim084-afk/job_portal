/**
 * The logo in every email's header (instead of the company name as text).
 *
 *   - the shared layout puts the logo image in the header, with the company name as its alt text
 *   - over SMTP the logo goes WITH the message as an inline attachment (cid), so it shows without "show images"
 *   - providers that cannot attach get the hosted copy (/email-logo.png on the portal's public address)
 *   - the logo file exists and is a PNG
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { applyTestEnv } from './harness.mjs';

applyTestEnv('postgres://x:y@127.0.0.1:1/z', { PUBLIC_ORIGIN: 'https://jobs.example.org' });
const { emailLayout, LOGO_CID } = await import('../src/notify/layout.js');
const { withLogo } = await import('../src/notify/providers.js');

test('the header shows the logo, with the company name as its alt text', () => {
  const html = emailLayout({ title: 'Your TeamLink login details', greeting: 'Dear Asha,', body: 'Your account has been created.' });
  assert.match(html, /<img src="cid:tl-logo" alt="TeamLink Consultants"/);
  assert.equal(LOGO_CID, 'tl-logo');
  assert.ok(!/>\s*TeamLink Consultants\s*<\/td>/.test(html.split('Your TeamLink login details')[0]), 'the header no longer prints the name as text');
  assert.match(html, /Recruitment/);
  assert.match(html, /Sent by TeamLink Consultants/);
});

test('SMTP gets the logo attached inline; other providers get the hosted copy', () => {
  const html = emailLayout({ title: 't', body: 'b' });
  const a = withLogo(html, { attach: true });
  assert.equal(a.attachments.length, 1);
  assert.deepEqual([a.attachments[0].cid, a.attachments[0].contentDisposition], ['tl-logo', 'inline']);
  assert.ok(a.html.includes('cid:tl-logo'));
  const h = withLogo(html, { attach: false });
  assert.deepEqual(h.attachments, []);
  assert.ok(h.html.includes('src="https://jobs.example.org/email-logo.png"') && !h.html.includes('cid:'));
  assert.deepEqual(withLogo('<p>no logo here</p>', { attach: true }), { html: '<p>no logo here</p>', attachments: [] });
});

test('the logo file is a real PNG', () => {
  const f = readFileSync(new URL('../../web/email-logo.png', import.meta.url));
  assert.equal(f.subarray(1, 4).toString(), 'PNG');
  assert.ok(f.length > 2000 && f.length < 120000);
});

test('a real SMTP delivery carries the logo as an inline image the message refers to', async () => {
  let raw = '';
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _s, cb) { stream.on('data', (d) => { raw += d.toString('latin1'); }); stream.on('end', cb); } });
  await new Promise((r) => srv.listen(9976, '127.0.0.1', r));
  try {
    process.env.EMAIL_SMTP_HOST = '127.0.0.1';
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: 9976, secure: false, tls: { rejectUnauthorized: false }, ignoreTLS: true });
    const logo = withLogo(emailLayout({ title: 'x', body: 'y' }), { attach: true });
    await t.sendMail({ from: 'a@x.test', to: 'b@y.test', subject: 'logo', html: logo.html, text: 'y', attachments: logo.attachments });
    assert.match(raw, /Content-Type: multipart\/related/i);
    assert.match(raw, /Content-ID: <tl-logo>/i);
    assert.match(raw, /Content-Type: image\/png/i);
    assert.match(raw, /src=3D"cid:tl-logo"|src="cid:tl-logo"/);
  } finally { await new Promise((r) => srv.close(r)); }
});
