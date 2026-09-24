/**
 * An export completes the people already here; it does not duplicate them.
 *
 *     node tools/verify-import-merge.mjs    (needs the DATABASE FREE -
 *                                            stop the dev server first)
 *
 * This is the case that matters for a portal filled from Naukri's daily
 * summary emails. Those carry a name, a title, a company and a location
 * and NO WAY TO CONTACT ANYBODY - the eight people currently in the
 * portal have neither an address nor a number, because the digest does
 * not contain one.
 *
 * The applicant export from Naukri's dashboard does carry them. So when
 * it is imported, each row has to find the person already sitting there
 * and fill them in. If it matches on address alone it finds nobody -
 * they have no address - and creates a second Bershan beside the first,
 * leaving the original uncontactable forever and the recruiter with two
 * of everybody.
 *
 * The rule is therefore: address or number first, because those identify
 * a person; failing that, NAME PLUS a corroborating field, and only
 * against a profile that has no contact details of its own.
 *
 * Both halves of that rule are dangerous if wrong, so both are tested:
 * that it MERGES when it should, and that it REFUSES to when it should
 * not - name alone, or a profile that already belongs to somebody who
 * told us who they are.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const { PGlite } = await import('@electric-sql/pglite');
let db;
try {
  db = await new PGlite(process.env.DEV_DB_DIR || 'var/dev-db');
} catch (err) {
  console.log(`ABORT: the database is in use. Stop the dev server and run this again.`);
  console.log(`       (${String(err.message).slice(0, 80)})`);
  process.exit(1);
}
const q = async (sql, p) => (await db.query(sql, p)).rows;

/*
 * THE MATCH, exactly as the importer runs it.
 *
 * Copied rather than imported because it lives inside the route's
 * transaction loop. If the two ever drift this file is wrong, which is
 * why the wording is identical and the route names this tool.
 */
const findExisting = async (email, phone, name, company, place) => {
  const byContact = await q(
    `select id, name, email, phone from candidates
      where ($1 <> '' and lower(email) = $1)
         or ($2 <> '' and length(regexp_replace($2, '[^0-9]', '', 'g')) >= 10
             and right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10)
               = right(regexp_replace($2, '[^0-9]', '', 'g'), 10))
      limit 1`, [email, phone]);
  if (byContact[0]) return { row: byContact[0], by: 'contact' };

  const byName = await q(
    `select id, name, email, phone from candidates
      where lower(name) = lower($1)
        and coalesce(email, '') = '' and coalesce(phone, '') = ''
        and (
          ($2 <> '' and lower(coalesce(current_company, '')) = lower($2))
          or ($3 <> '' and lower(coalesce(location, '')) = lower($3))
        )
      limit 1`, [name, company, place]);
  return byName[0] ? { row: byName[0], by: 'name and workplace' } : null;
};

const stamp = Date.now().toString(36);
const made = [];
const make = async (fields) => {
  const id = `cand_merge_${stamp}_${made.length}`;
  await q(`insert into candidates (id, name, email, phone, current_company, location)
           values ($1,$2,$3,$4,$5,$6)`,
    [id, fields.name, fields.email || null, fields.phone || null,
     fields.company || null, fields.location || null]);
  made.push(id);
  return id;
};

try {
  /* ---- a candidate exactly like the eight in the portal ------------- */
  const digest = await make({
    name: `Bershan ${stamp}`, company: 'G Tech Solutions', location: 'Tirunelveli',
  });
  const asStored = (await q(`select email, phone from candidates where id=$1`, [digest]))[0];
  check(!asStored.email && !asStored.phone,
    'the digest profile has no address and no number, like the real ones');

  /* ---- the export row for the same person ---------------------------- */
  const hit = await findExisting('', '', `Bershan ${stamp}`, 'G Tech Solutions', 'Tirunelveli');
  check(!!hit && hit.row.id === digest,
    `the export finds them by name and workplace (${hit ? hit.by : 'NOT FOUND'})`);

  const byPlaceOnly = await findExisting('', '', `Bershan ${stamp}`, '', 'Tirunelveli');
  check(!!byPlaceOnly && byPlaceOnly.row.id === digest,
    'the location alone corroborates when the export has no employer column');

  /* ---- and the refusals, which matter more --------------------------- */
  /*
   * Name alone must find nobody. Two people share a name often, and
   * merging them cannot be undone.
   */
  const nameOnly = await findExisting('', '', `Bershan ${stamp}`, '', '');
  check(!nameOnly, 'name alone matches nobody');

  const elsewhere = await findExisting('', '', `Bershan ${stamp}`, 'A Different Employer', 'Chennai');
  check(!elsewhere,
    'the same name at another company in another city is a different person');

  /*
   * A profile that already HAS contact details is somebody who told us
   * who they are. Filling them in from a name match would be merging two
   * real people.
   */
  const known = await make({
    name: `Priya ${stamp}`, email: `priya.${stamp}@example.invalid`,
    phone: '9845000111', company: 'Apollo Hospitals', location: 'Hyderabad',
  });
  const wouldMerge = await findExisting('', '', `Priya ${stamp}`, 'Apollo Hospitals', 'Hyderabad');
  check(!wouldMerge,
    'a profile that already has contact details is never matched by name');

  const byEmail = await findExisting(`priya.${stamp}@example.invalid`, '', '', '', '');
  check(!!byEmail && byEmail.row.id === known && byEmail.by === 'contact',
    'but the address still finds them, which is what identifies a person');

  const byPhone = await findExisting('', '9845000111', '', '', '');
  check(!!byPhone && byPhone.row.id === known,
    'and so does the number, however it is punctuated');
  const spaced = await findExisting('', '+91 98450 00111', '', '', '');
  check(!!spaced && spaced.row.id === known,
    'including with a country code and spaces');
} finally {
  for (const id of made) {
    await q(`delete from applications where candidate_id=$1`, [id]);
    await q(`delete from candidates where id=$1`, [id]);
  }
  const left = (await q(
    `select count(*)::int n from candidates where id = any($1::text[])`, [made]))[0].n;
  check(Number(left) === 0, `the fixtures were removed again (${left} left)`);
  await db.close();
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
