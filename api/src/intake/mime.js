/**
 * The readable text of an email, however deeply it is wrapped.
 *
 * MIME nests, and the first version of this did not. Naukri sends
 * `multipart/mixed` whose only part is a `multipart/alternative`, whose
 * parts are the plain text and the HTML. Splitting on the OUTER boundary
 * found one part whose content-type was `multipart/alternative`, matched
 * neither `text/plain` nor `text/html`, and returned nothing at all.
 *
 * A real message out of the inbox: 42 KB of raw mail, full of HTML, and
 * zero characters extracted. Every email then failed with "no candidate
 * name could be read from this email" - which blames the email for a
 * fault in the reader, and would have done exactly the same to a genuine
 * application.
 *
 * So this recurses. Each entity is headers plus body; a multipart body is
 * split on ITS OWN boundary and each part parsed the same way, to a
 * bounded depth, because a malformed message must not be able to spin
 * here.
 */

/** Header values fold across lines; unfold before reading them. */
function unfold(headers) {
  return String(headers).replace(/\r?\n[ \t]+/g, ' ');
}

function decodeBody(headers, body) {
  if (/quoted-printable/i.test(headers)) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  if (/base64/i.test(headers)) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); }
    catch { return body; }
  }
  return body;
}

/**
 * HTML to something a parser can read.
 *
 * Naukri's application emails are tables, so a naive tag strip runs the
 * label into the value - "Name:Priya Sharma", and worse,
 * "Sharma9876543210" where one cell ends and the next begins. Block
 * tags become line breaks and cells become spaces, which keeps a label
 * and its value on one line and the next field on the next, so the
 * labelled-block parsing still works.
 */
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @returns {{ text: string, plain: string, html: string, attachment: string }}
 */
export function bodyOf(raw, depth = 0) {
  const source = String(raw == null ? '' : raw);
  const at = source.search(/\r?\n\r?\n/);
  const headers = at < 0 ? '' : source.slice(0, at);
  const body = at < 0 ? source : source.slice(at).replace(/^\r?\n\r?\n/, '');

  const head = unfold(headers);
  const ctype = (/^content-type:[ \t]*([^\r\n]+)/im.exec(head) || [])[1] || '';
  const filename = (/(?:filename|name)=\s*"?([^"\r\n;]+)"?/i.exec(head) || [])[1] || '';

  if (/^\s*multipart\//i.test(ctype) && depth < 6) {
    const boundary = (/boundary=\s*"?([^";\r\n]+)"?/i.exec(ctype) || [])[1];
    if (boundary) {
      const marker = `--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      let plain = '';
      let html = '';
      let attachment = '';

      for (const part of body.split(new RegExp(marker))) {
        if (!part.trim() || /^--\s*$/.test(part.trim())) continue;
        const inner = bodyOf(part, depth + 1);
        // The first of each kind wins: a quoted reply further down must
        // not replace the message itself.
        if (!plain && inner.plain) plain = inner.plain;
        if (!html && inner.html) html = inner.html;
        if (!attachment && inner.attachment) attachment = inner.attachment;
      }

      return { plain, html, attachment, text: plain || stripHtml(html) };
    }
  }

  // An attached file is not body text, unless it is itself the message.
  if (filename && !/^\s*text\/(plain|html)/i.test(ctype)) {
    return { plain: '', html: '', attachment: filename, text: '' };
  }

  const decoded = decodeBody(head, body);

  if (/text\/html/i.test(ctype)) {
    return { plain: '', html: decoded, attachment: filename, text: stripHtml(decoded) };
  }

  // text/plain, or no content-type at all - which by RFC 2045 means
  // text/plain, and is what a hand-written message often looks like.
  return { plain: decoded, html: '', attachment: filename, text: decoded };
}
