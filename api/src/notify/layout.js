/**
 * What a TeamLink email looks like when it lands.
 *
 * Every message was a bare stack of <p> tags - correct, readable, and
 * indistinguishable from a script's output. A candidate deciding whether
 * to trust a link and hand over a password reads the design before they
 * read the words, and "This is a test of the Interview Rescheduled
 * notification" in plain Times New Roman does not look like a company.
 *
 * Email HTML is not web HTML, and the constraints below are why this
 * looks like 2004:
 *
 *   - TABLES, not flexbox or grid. Outlook renders through Word, which
 *     has no support for either.
 *   - INLINE styles. Gmail strips <head>, so a stylesheet there is gone
 *     by the time anybody sees it. The <style> block is kept only for
 *     the media query, which cannot be inlined, and everything in it is
 *     duplicated inline as the fallback.
 *   - 600px, centred, on a table with its own background. Anything wider
 *     is cut off in a reading pane.
 *   - No external images and no web fonts. Both are blocked by default
 *     in most clients, so a design that needs them arrives broken.
 *
 * The plain-text alternative is composed separately and is not decorated
 * - a client showing text wants text.
 */

const BRAND = {
  ink: '#0f2540',        // header
  accent: '#1d6ff2',     // the one button
  text: '#243449',
  soft: '#6b7a90',
  line: '#e4eaf2',
  page: '#f2f5f9',
};

/*
 * The font, on every element that holds text.
 *
 * With no font-family an email client falls back to Times New Roman -
 * which is why the first version looked like a 1998 memo however
 * carefully the rest was laid out. There is no inheritance to rely on
 * either: Outlook resets it on tables, so it goes on each one.
 *
 * Web-safe only. A webfont is blocked by default in most clients, so a
 * design that needs one arrives in the fallback anyway.
 */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
  + "'Helvetica Neue',Arial,sans-serif";

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Wrap a message in the TeamLink shell.
 *
 * @param opts.title     the line under the brand bar
 * @param opts.greeting  "Hi Sravanthi," - omitted when there is no name
 * @param opts.body      paragraphs, already escaped or plain text
 * @param opts.facts     [[label, value]] shown as a details block
 * @param opts.cta       { label, url } - one button, never two
 * @param opts.note      small print under the button
 * @param opts.company   the sender's name in the footer
 */
export function emailLayout(opts = {}) {
  const company = opts.company || 'TeamLink Consultants';
  const title = opts.title || '';
  const paragraphs = String(opts.body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const para = (p) =>
    `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;`
    + `line-height:1.62;color:${BRAND.text}">`
    + esc(p).replace(/\n/g, '<br>') + '</p>';

  const facts = (opts.facts || []).filter((f) => f && f[1]);
  const factRows = facts.map(([label, value]) =>
    `<tr>
       <td style="padding:7px 0;font-family:${FONT};font-size:13px;color:${BRAND.soft};white-space:nowrap;vertical-align:top">${esc(label)}</td>
       <td style="padding:7px 0 7px 18px;font-family:${FONT};font-size:14px;color:${BRAND.text};font-weight:600">${esc(value)}</td>
     </tr>`).join('');

  /*
   * One button, and it is a table.
   *
   * A styled <a> collapses to a bare link in Outlook; a single-cell
   * table with a background survives everywhere, and the <a> inside it
   * keeps the whole cell clickable in the clients that do render it.
   */
  const cta = opts.cta && opts.cta.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">
         <tr><td align="center" bgcolor="${BRAND.accent}" style="border-radius:6px">
           <a href="${esc(opts.cta.url)}"
              style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:14px;font-weight:700;
                     color:#ffffff;text-decoration:none;border-radius:6px">${esc(opts.cta.label || 'Open TeamLink')}</a>
         </td></tr>
       </table>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(title || company)}</title>
<style>
  /* The one rule that cannot be inlined. Everything else is. */
  @media only screen and (max-width:620px){
    .tl-wrap{width:100% !important}
    .tl-pad{padding-left:22px !important;padding-right:22px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};font-family:${FONT};">
<!-- Shown in the inbox list beside the subject, and nowhere else. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader || title)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="background:${BRAND.page};padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" class="tl-wrap" cellpadding="0" cellspacing="0" border="0" width="600"
           style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;
                  border:1px solid ${BRAND.line};overflow:hidden">

      <tr><td bgcolor="${BRAND.ink}" class="tl-pad" style="padding:20px 34px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="font-family:${FONT};font-size:19px;font-weight:800;color:#ffffff;letter-spacing:.2px">
            ${esc(company)}
          </td>
          <td align="right" style="font-family:${FONT};font-size:11px;color:#9fb6d4;letter-spacing:.12em;text-transform:uppercase">
            Recruitment
          </td>
        </tr></table>
      </td></tr>

      ${title ? `<tr><td class="tl-pad" style="padding:26px 34px 0">
        <h1 style="margin:0;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:700;color:${BRAND.ink}">${esc(title)}</h1>
      </td></tr>` : ''}

      <tr><td class="tl-pad" style="padding:${title ? '16px' : '26px'} 34px 4px">
        ${opts.greeting ? para(opts.greeting) : ''}
        ${paragraphs.map(para).join('')}
        ${cta}
      </td></tr>

      ${factRows ? `<tr><td class="tl-pad" style="padding:6px 34px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:#f7f9fc;border:1px solid ${BRAND.line};border-radius:8px;padding:6px 16px">
          ${factRows}
        </table>
      </td></tr>` : ''}

      ${opts.note ? `<tr><td class="tl-pad" style="padding:18px 34px 0">
        <p style="margin:0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${BRAND.soft}">${esc(opts.note)}</p>
      </td></tr>` : ''}

      <tr><td class="tl-pad" style="padding:26px 34px 30px">
        <div style="border-top:1px solid ${BRAND.line};padding-top:16px">
          <p style="margin:0 0 4px;font-family:${FONT};font-size:12.5px;color:${BRAND.soft}">
            Sent by ${esc(company)}.
          </p>
          <p style="margin:0;font-family:${FONT};font-size:11.5px;color:#93a1b5">
            This message was sent because you applied for a role through ${esc(company)}.
            Reply to this email if you would rather not hear from us.
          </p>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}
