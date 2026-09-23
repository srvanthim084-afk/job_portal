/**
 * The resume that came attached to the email.
 *
 * The intake screen has always shown "Priya_Sharma.pdf" beside an
 * imported candidate, and the file was nowhere: `bodyOf` read the
 * attachment's NAME out of the MIME headers and nothing ever read the
 * bytes. So a candidate imported from a mailbox had a resume in the
 * sense that somebody could see it had existed, and none of the things a
 * resume is for - no text to search, nothing for the screening to read,
 * nothing to send a client, and a Download button with no file behind
 * it.
 *
 * This stores it, through exactly the path an uploaded resume takes:
 *
 *   validateResume   magic bytes, not the sender's word for the type
 *   storeResume      object storage, content-addressed key
 *   extractResumeText + extractFields   the same parser
 *   applyExtractedFields                into empty columns only
 *
 * THE FILENAME IS NOT TRUSTED. An email attachment is as
 * attacker-controlled as a browser upload - more so, since anybody can
 * send one - and calling something .pdf does not make it a PDF. The
 * validator reads the first bytes and refuses anything that is not
 * genuinely a document, which is what stops a mailbox becoming a way to
 * put an executable, or an HTML file, into storage.
 *
 * WHAT IT WILL NOT DO is overwrite a resume that is already on file. The
 * candidate's own upload is the one they chose; a digest arriving three
 * weeks later must not silently replace it. The file is recorded as seen
 * and skipped, with the reason, so a recruiter can decide.
 */
import { withUser } from '../db.js';
import { storeResume, ALLOWED_EXT } from '../storage.js';
import { extractResumeText } from '../resume/extract.js';
import { extractFields, parseConfidence } from '../resume/fields.js';
import { applyExtractedFields } from '../resume/apply.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

/** Names that look like a document rather than a signature image. */
const looksLikeDocument = (name) => {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return ALLOWED_EXT.includes(ext);
};

/**
 * Which attached file is the resume.
 *
 * The extension decides the ORDER, not the outcome - a document-looking
 * name is tried first because it usually is one, and everything else is
 * still tried, because plenty of real resumes arrive as `CV` with no
 * extension at all. The magic-byte check is what actually decides.
 */
function candidates(attachments) {
  const files = (attachments || []).filter((a) => a && a.buffer && a.buffer.length);
  return [
    ...files.filter((a) => looksLikeDocument(a.filename)),
    ...files.filter((a) => !looksLikeDocument(a.filename)),
  ];
}

/**
 * Store the attached resume against a candidate.
 *
 * Never throws: a resume that cannot be stored must not undo a candidate
 * and an application that were created correctly. Every outcome is
 * returned and written to the timeline instead.
 *
 * @returns {{status:'stored'|'kept_existing'|'unreadable'|'none',
 *            filename?:string, reason?:string, fields?:number}}
 */
export async function storeAttachedResume({ candidateId, applicationId, attachments }) {
  const files = candidates(attachments);
  if (!files.length) return { status: 'none' };

  const existing = await withUser(ENGINE, async (c) => (await c.query(
    `select resume_storage_path, resume_file from candidates where id=$1`,
    [candidateId])).rows[0]);

  if (existing && existing.resume_storage_path) {
    return {
      status: 'kept_existing',
      filename: files[0].filename,
      reason: `${files[0].filename} was attached, and ${existing.resume_file} is already on file`,
    };
  }

  const refused = [];

  for (const file of files) {
    let stored;
    try {
      // Magic bytes. A .pdf that is not a PDF is refused here.
      stored = await storeResume({
        candidateId,
        buffer: file.buffer,
        originalName: file.filename,
      });
    } catch (err) {
      refused.push(`${file.filename}: ${err.message}`);
      continue;
    }

    /*
     * Read it while we have it.
     *
     * A parse failure does NOT undo the store - the file is the source
     * document and is worth keeping even when it cannot be read - and
     * the reason goes on the candidate, which is the same rule the
     * upload route follows.
     */
    let parsed = null;
    let parseError = null;
    try {
      const doc = await extractResumeText(file.buffer, file.filename);
      const out = extractFields(doc.text);
      parsed = {
        parser: doc.parser,
        chars: doc.chars,
        fields: out.fields,
        found: out.found,
        confidence: parseConfidence({ fields: out.fields, chars: doc.chars }),
      };
    } catch (err) {
      parseError = err && err.message ? String(err.message).slice(0, 400) : 'could not be read';
    }

    await withUser(ENGINE, async (c) => {
      await c.query(
        `update candidates
            set resume_file=$1, resume_storage_path=$2, resume_mime=$3,
                resume_size=$4, resume_uploaded_at=now(),
                resume_parsed_at=$6, resume_parser=$7, resume_chars=$8,
                resume_fields_detected=$9, resume_parse_confidence=$10,
                resume_parse_error=$11
          where id=$5`,
        [stored.displayName, stored.path, stored.mime, stored.size, candidateId,
         parsed ? new Date() : null,
         parsed ? parsed.parser : null,
         parsed ? parsed.chars : null,
         parsed ? parsed.found : null,
         parsed ? parsed.confidence : null,
         parseError]);

      if (parsed) await applyExtractedFields(c, candidateId, parsed.fields);
    });

    if (applicationId) {
      await withUser(ENGINE, (c) => c.query(
        `select app_event($1,$2,'resume.imported',$3,'system',$4::jsonb)`,
        [applicationId, candidateId,
         `Resume ${stored.displayName} imported from the email`,
         JSON.stringify({
           fileName: stored.displayName, size: stored.size, mime: stored.mime,
           parser: parsed ? parsed.parser : null,
           fieldsDetected: parsed ? parsed.found : 0,
           parseError,
         })]));
    }

    return {
      status: 'stored',
      filename: stored.displayName,
      size: stored.size,
      fields: parsed ? parsed.found : 0,
      parseError,
    };
  }

  return {
    status: 'unreadable',
    filename: files[0].filename,
    // Names and reasons, never the contents - this ends up in an API
    // response a recruiter can read.
    reason: refused.join('; ') || 'no attached file was a readable document',
  };
}
