/**
 * Which candidate does this resume belong to?
 *
 * The candidates imported from a job board's summary email arrive with a
 * name, a title, a company and a location, and no resume - the mail
 * carries none. The CVs turn up separately: forwarded in a batch,
 * downloaded from the board's dashboard, dropped in a folder. Somebody
 * then has to open each one, work out who it is, find them in the
 * portal and attach it. For eighty-seven candidates that is a day's
 * work, and it is exactly the kind of work that gets skipped.
 *
 * So the resume is read and the person is looked up from what it says.
 *
 * THE ORDER IS THE WHOLE DESIGN, because attaching a CV to the wrong
 * person is worse than attaching none: it is the document that gets sent
 * to a client.
 *
 *   email      identifies a person. Nobody else has it.
 *   phone      the same, matched on the last ten digits so a country
 *              code does not make two numbers out of one.
 *   name AND   only against a candidate who has NEITHER an address nor a
 *   workplace  number - somebody the portal cannot otherwise identify -
 *              and only when the company or the city agrees too.
 *
 * NEVER NAME ALONE. Two people share a name often, and a CV attached to
 * the wrong one cannot be undone by noticing later.
 *
 * Anything that does not match by one of those is returned unmatched,
 * with what was read from it, for a person to place. A guess would be
 * indistinguishable from a match on screen, and that is the failure this
 * is built to avoid.
 */
import { withUser } from '../db.js';

/** Digits only, last ten - what identifies an Indian mobile. */
const tail10 = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

const clean = (v) => String(v == null ? '' : v).trim();

/**
 * Find the candidate a resume belongs to.
 *
 * @param session  the acting user - the lookup runs under THEIR row-level
 *                 security, so a recruiter can only ever match a resume
 *                 to somebody they are entitled to see.
 * @param fields   what the extractor read out of the resume
 * @returns {{candidateId, name, by}|null}
 */
export async function matchResumeToCandidate(session, fields = {}) {
  const email = clean(fields.email).toLowerCase();
  const phone = tail10(fields.phone || fields.altPhone);
  const name = clean(fields.name);
  const company = clean(fields.currentCompany);
  const place = clean(fields.location);

  return withUser(session, async (c) => {
    /* ---- the address, which identifies a person ---------------------- */
    if (email) {
      const { rows } = await c.query(
        `select id, name from candidates where lower(email) = $1 limit 1`, [email]);
      if (rows[0]) return { candidateId: rows[0].id, name: rows[0].name, by: 'email address' };
    }

    /* ---- the number, ditto ------------------------------------------- */
    if (phone) {
      const { rows } = await c.query(
        `select id, name from candidates
          where length(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')) >= 10
            and right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = $1
          limit 1`, [phone]);
      if (rows[0]) return { candidateId: rows[0].id, name: rows[0].name, by: 'phone number' };
    }

    /*
     * ---- the name, and only with corroboration ----------------------
     *
     * Restricted to candidates the portal cannot identify any other way.
     * A candidate who HAS an address is somebody who told us who they
     * are; matching them by name would be overruling that with a guess.
     *
     * The count is checked: two people of that name at that company is
     * not a match, it is a reason to ask.
     */
    if (name && (company || place)) {
      const { rows } = await c.query(
        `select id, name from candidates
          where lower(name) = lower($1)
            and coalesce(email, '') = '' and coalesce(phone, '') = ''
            and (
              ($2 <> '' and lower(coalesce(current_company, '')) = lower($2))
              or ($3 <> '' and lower(coalesce(location, '')) = lower($3))
            )
          limit 2`, [name, company, place]);
      if (rows.length === 1) {
        return { candidateId: rows[0].id, name: rows[0].name, by: 'name and workplace' };
      }
      if (rows.length > 1) {
        return null;      // ambiguous is not a match
      }
    }

    return null;
  });
}
