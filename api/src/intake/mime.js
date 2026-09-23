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

/**
 * Is this part's text UTF-8?
 *
 * Quoted-printable produces BYTES, one per character, so a name
 * written in UTF-8 arrives as mojibake unless it is read back as
 * UTF-8 - which is how an imported candidate ends up called
 * "Sundari" with three wrong characters in the middle. A part that
 * declares another charset is left alone rather than guessed at.
 */
function isUtf8(headers) {
  const cs = (/charset=\s*"?([^"\s;]+)/i.exec(headers) || [])[1];
  return !cs || /^utf-?8$/i.test(cs);
}

function decodeBody(headers, body) {
  if (/quoted-printable/i.test(headers)) {
    const bytes = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return isUtf8(headers) ? Buffer.from(bytes, 'latin1').toString('utf8') : bytes;
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

/* ------------------------------------------------------------------ *
 * attachments
 * ------------------------------------------------------------------ */

/**
 * An attachment filename, however the sender encoded it.
 *
 * Three spellings are all common in real mail, and a resume whose name
 * cannot be read is a resume that fails the extension check and is
 * dropped:
 *
 *   filename="Priya Sharma.pdf"            plain
 *   filename*=UTF-8''Priya%20Sharma.pdf    RFC 2231, percent-encoded
 *   filename="=?utf-8?B?...?=.pdf"         RFC 2047, base64 or Q
 */
function decodeFilename(head) {
  const ext = /(?:filename|name)\*=\s*([^;\r\n]+)/i.exec(head);
  if (ext) {
    const raw = ext[1].trim().replace(/^"|"$/g, '');
    // charset'language'value — the value is percent-encoded.
    const m = /^([^']*)'([^']*)'(.*)$/.exec(raw);
    const value = m ? m[3] : raw;
    try { return decodeURIComponent(value); } catch { return value; }
  }

  const plain = /(?:filename|name)=\s*"?([^"\r\n;]+)"?/i.exec(head);
  if (!plain) return '';
  return String(plain[1]).trim()
    .replace(/=\?[^?]+\?([BQ])\?([^?]*)\?=/gi, (_, enc, data) => {
      try {
        if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
        return Buffer.from(data.replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))),
          'binary').toString('utf8');
      } catch { return data; }
    });
}

/** The bytes of one part, whatever it was encoded with. */
function decodeBytes(head, body) {
  if (/content-transfer-encoding:[ \t]*base64/i.test(head)) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (/content-transfer-encoding:[ \t]*quoted-printable/i.test(head)) {
    const text = body.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(text, 'latin1');
  }
  // 7bit, 8bit, binary, or nothing said. The caller hands us a string
  // whose characters are bytes, so latin1 is the faithful reading.
  return Buffer.from(body, 'latin1');
}

/**
 * Every attached FILE in a message, with its contents.
 *
 * `bodyOf` has always reported an attachment's NAME, which is why the
 * intake screen could say "Priya_Sharma.pdf" beside a candidate whose
 * resume was nowhere on file: nothing ever read the bytes. This does,
 * and the bytes are what makes an imported candidate searchable,
 * screenable and forwardable to a client.
 *
 * WHAT IS NOT AN ATTACHMENT: the message's own text and HTML parts, and
 * inline images - a signature logo is not somebody's CV. A part is taken
 * when it has a filename or is marked `attachment`, and is not itself
 * the readable body.
 *
 * NOTHING HERE TRUSTS THE FILENAME. It is used for display and for the
 * extension, and the file is identified by its magic bytes later, by the
 * same validator every upload goes through. An email attachment is
 * exactly as attacker-controlled as a browser upload.
 *
 * @returns {{filename:string, contentType:string, buffer:Buffer, size:number}[]}
 */
export function attachmentsOf(raw, { maxBytes = 15 * 1024 * 1024, max = 8, depth = 0 } = {}) {
  const source = String(raw == null ? '' : raw);
  const at = source.search(/\r?\n\r?\n/);
  const headers = at < 0 ? '' : source.slice(0, at);
  const body = at < 0 ? source : source.slice(at).replace(/^\r?\n\r?\n/, '');

  const head = unfold(headers);
  const ctype = (/^content-type:[ \t]*([^\r\n]+)/im.exec(head) || [])[1] || '';
  const disposition = (/^content-disposition:[ \t]*([^;\r\n]+)/im.exec(head) || [])[1] || '';

  if (/^\s*multipart\//i.test(ctype) && depth < 6) {
    const boundary = (/boundary=\s*"?([^";\r\n]+)"?/i.exec(ctype) || [])[1];
    if (boundary) {
      const marker = `--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      const out = [];
      for (const part of body.split(new RegExp(marker))) {
        if (!part.trim() || /^--\s*$/.test(part.trim())) continue;
        for (const f of attachmentsOf(part, { maxBytes, max, depth: depth + 1 })) {
          if (out.length >= max) return out;
          out.push(f);
        }
      }
      return out;
    }
  }

  const filename = decodeFilename(head);
  const attached = /attachment/i.test(disposition);
  const isBodyText = /^\s*text\/(plain|html)/i.test(ctype) && !attached;
  // A logo in a signature has a filename and a Content-ID, and is not a
  // document anybody wants on a candidate's record.
  const inlineImage = /^\s*image\//i.test(ctype) && !attached;

  if (!(filename || attached) || isBodyText || inlineImage) return [];

  let buffer;
  try { buffer = decodeBytes(head, body); } catch { return []; }
  if (!buffer.length || buffer.length > maxBytes) return [];

  return [{
    filename: filename || 'attachment',
    contentType: (ctype.split(';')[0] || '').trim().toLowerCase(),
    buffer,
    size: buffer.length,
  }];
}
