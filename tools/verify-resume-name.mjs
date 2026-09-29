/**
 * A section heading is never a name, and a suburb is never a city.
 *
 * WHAT THIS EXISTS FOR. A candidate uploaded a CV and the Full name box
 * came back "CORE SKILLS"; the City box came back "HYDERNAGAR", which is
 * a neighbourhood inside an address line. Both travelled into the
 * profile, and from there into the recruiter's table and the greeting on
 * an email. Neither was a parsing near-miss - both were values the rules
 * positively accepted.
 *
 * Every case below is a resume shape that produced one of those, or one
 * that must keep working and would break under a blunter fix (a surname
 * that begins like a heading, a two-word city, a genuinely unlabelled
 * document).
 *
 *   node tools/verify-resume-name.mjs
 */
import { extractFields } from '../api/src/resume/fields.js';

let pass = 0, fail = 0;

function check(label, text, expect) {
  const got = extractFields(text).fields || {};
  const problems = [];
  for (const [k, want] of Object.entries(expect)) {
    const have = got[k] === undefined ? null : got[k];
    const ok = want === null ? (have === null || have === '') : have === want;
    if (!ok) problems.push(`${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(have)}`);
  }
  if (problems.length) {
    fail += 1;
    console.log(`  FAIL  ${label}`);
    problems.forEach((p) => console.log(`          ${p}`));
  } else {
    pass += 1;
    console.log(`  ok    ${label}`);
  }
}

/* ------------------------------------------------------------------ *
 * the reported fault
 * ------------------------------------------------------------------ */

check('CORE SKILLS above the name (the reported bug)', `
CORE SKILLS
Patient Care, Triage, ICU Monitoring

PALLAVI U
Staff Nurse
Email: pallavi.u@example.com
Phone: 9100000001
Address: Plot 42, Hydernagar, Kukatpally, Hyderabad 500072
`, { name: 'Pallavi U', location: 'Hyderabad' });

check('SUMMARY first', `
SUMMARY
Four years in critical care.

Meena Reddy
meena@example.com
Current Location: Secunderabad
`, { name: 'Meena Reddy', location: 'Secunderabad' });

check('OBJECTIVE first', `
OBJECTIVE
To work in a challenging environment.

Ravi Kumar Naidu
ravi@example.com
`, { name: 'Ravi Kumar Naidu' });

check('a two-column sidebar ahead of the header', `
TECHNICAL SKILLS
EDUCATION
LANGUAGES
CERTIFICATIONS
PROJECTS

Bhavana Sharma
Senior Developer
bhavana@example.com
`, { name: 'Bhavana Sharma' });

/* ------------------------------------------------------------------ *
 * what must keep working
 * ------------------------------------------------------------------ */

check('a labelled name still wins', `
CORE SKILLS
Name: Keerthi Gujjula
keerthi@example.com
`, { name: 'Keerthi Gujjula' });

check("a father's name is still not the candidate's", `
Sandeep Verma
Father's Name: Mohan Verma
sandeep@example.com
`, { name: 'Sandeep Verma' });

check('ALL CAPS becomes Title Case', `
ARJUN RAO
arjun@example.com
`, { name: 'Arjun Rao' });

check('an initial stays upper', `
PALLAVI U
p.u@example.com
`, { name: 'Pallavi U' });

check("D'Souza keeps its capital", `
MARIA D'SOUZA
maria@example.com
`, { name: "Maria D'Souza" });

/* ------------------------------------------------------------------ *
 * refusing rather than guessing
 * ------------------------------------------------------------------ */

check('nothing that looks like a name leaves it EMPTY', `
CURRICULUM VITAE
CORE SKILLS
WORK EXPERIENCE
EDUCATION
DECLARATION
upallavi271@example.com
`, { name: null });



check('a dotted email local part is offered, not filled', `
SKILLS
PROJECTS
priya.menon@example.com
`, { name: null, nameSuggestion: 'Priya Menon' });

check('digits are stripped before the email is offered', `
CORE SKILLS
WORK EXPERIENCE
upallavi271@example.com
`, { name: null, nameSuggestion: 'Upallavi' });

/* ------------------------------------------------------------------ *
 * the shapes the brief names
 * ------------------------------------------------------------------ */

check('a name that is only in the header IMAGE leaves it empty, with an offer', `
CORE SKILLS
Patient Care, ICU

WORK EXPERIENCE
Apollo Hospitals, Staff Nurse

mangalapalli.sravanthi@example.com
9100000009
`, { name: null, nameSuggestion: 'Mangalapalli Sravanthi' });

check('initials only', `
U PALLAVI
u.pallavi@example.com
`, { name: 'U Pallavi' });

check('a single-name candidate is no longer lost', `
Deepika
deepika@example.com
Current Location: Hyderabad
`, { name: 'Deepika', location: 'Hyderabad' });

check('a lone heading is still refused, even as one word', `
SUMMARY
Experienced professional.
`, { name: null });

check('a scanned page with no text layer invents nothing', `

`, { name: null, location: null });

check('a scanned page whose OCR produced only noise invents nothing', `
|||  ---   ...
### ***
`, { name: null, location: null });

check('a PIN code line gives the city', `
Rahul Verma
rahul@example.com
H.No 8-2-120, Road No 2, Banjara Hills, Hyderabad 500034
`, { name: 'Rahul Verma', location: 'Hyderabad' });

/* ------------------------------------------------------------------ *
 * the city
 * ------------------------------------------------------------------ */

check('a suburb in an address yields the CITY', `
Divya Rao
divya@example.com
Address: 3-4-101, Hydernagar, Kukatpally, Hyderabad, Telangana
`, { name: 'Divya Rao', location: 'Hyderabad' });

check('a two-word city beats the one inside it', `
Nikhil Patel
nikhil@example.com
Current Location: Navi Mumbai, Maharashtra
`, { location: 'Navi Mumbai' });

check('an unrecognised place leaves the city EMPTY', `
Anitha Menon
anitha@example.com
Address: 12/3 Some Colony, Nowhereville
`, { name: 'Anitha Menon', location: null });

check('the city is found in the header when unlabelled', `
Swathi Reddy
Staff Nurse | Warangal | swathi@example.com
`, { name: 'Swathi Reddy', location: 'Warangal' });

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
