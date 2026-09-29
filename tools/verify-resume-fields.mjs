/**
 * The parser reads what the resume says, and nothing it does not.
 *
 *     node tools/verify-resume-fields.mjs
 *
 * A candidate uploading a CV at registration has it read for them, and
 * whatever comes out is what a recruiter then searches on. Two faults
 * were reported as "it takes wrong info", and both were real:
 *
 *   THE SKILLS LIST SWALLOWED THE END OF THE DOCUMENT. A resume closes
 *   with "Current CTC: 18 LPA / Notice Period: 60 days / Date of Birth:
 *   12/08/1997", none of which looks like a heading, so the skills
 *   section ran to the bottom of the page and imported all of it. The
 *   candidate's profile listed their date of birth as a skill.
 *
 *   DESIGNATION AND EMPLOYER WERE NEVER FILLED IN for any resume whose
 *   experience section is prose rather than a table - which is most of
 *   them - so the recruiter's list showed a blank where the job title
 *   goes.
 *
 * Ground truth is written beside each resume here, so a regression is a
 * failing assertion rather than something somebody notices months later.
 */
import { extractFields } from '../api/src/resume/fields.js';

const CASES = [
  {
    what: 'an experienced developer, prose experience section',
    cv: `RAHUL KUMAR SHARMA
Senior Java Developer

Email: rahul.sharma@gmail.com
Mobile: +91 98450 12345
Location: Hyderabad, Telangana

PROFESSIONAL SUMMARY
Senior Java Developer with 6.5 years of experience building backend services.
Currently working at Infosys Limited since March 2021.

WORK EXPERIENCE
Infosys Limited, Hyderabad
Senior Software Engineer
March 2021 - Present

EDUCATION
B.Tech in Computer Science Engineering
JNTU Hyderabad, 2019

TECHNICAL SKILLS
Java, Spring Boot, Microservices, REST API, MySQL, Docker, Kubernetes, Git

Current CTC: 18 LPA
Expected CTC: 26 LPA
Notice Period: 60 days
Date of Birth: 12/08/1997`,
    want: {
      name: 'RAHUL KUMAR SHARMA', email: 'rahul.sharma@gmail.com', phone: '9845012345',
      location: 'Hyderabad', expYears: 6.5, noticePeriod: '60',
      currentSalary: '18', expectedSalary: '26',
      title: 'Senior Java Developer', currentCompany: 'Infosys',
    },
    skillsMustBe: ['Java', 'Spring Boot', 'Microservices', 'REST API', 'MySQL', 'Docker', 'Kubernetes', 'Git'],
  },
  {
    what: 'a fresher nurse, labelled fields at the end',
    cv: `ALIJA KHATUN
Staff Nurse

alija.khatun@example.com | 9876543210
Hyderabad

OBJECTIVE
Recently qualified nurse seeking a ward position.

EDUCATION
B.Sc Nursing, Osmania University, 2024

SKILLS
Patient Care, IV Therapy, Wound Care, Vital Signs Monitoring

Notice Period: Immediate
Expected CTC: 3.5 LPA
Father's Name: Mohammed Khatun
Languages Known: Telugu, Hindi, English`,
    want: {
      name: 'ALIJA KHATUN', email: 'alija.khatun@example.com', phone: '9876543210',
      title: 'Staff Nurse', noticePeriod: 'Immediate',
    },
    skillsMustBe: ['Patient Care', 'IV Therapy', 'Wound Care', 'Vital Signs Monitoring'],
  },
  {
    /* A two-column CV flattens to every heading, then every value - so
       "Current Designation" was followed by the next HEADING, and this
       doctor's designation read "Career Objective". Her post is dated but
       she never writes a number of years, so nothing marked her as having
       worked and her employer was blanked as if she were a fresher. */
    what: 'a doctor, two-column layout flattened to text',
    cv: `Dr.Amulya Lagadapati

MBBS, Masters in Obstetrics and Gynecology

D/O L.Uma Maheshwara Rao, Lanco Hills, Manikonda, Hyderabad T: 09676704455 E: amu@example.com

Current Designation

Career Objective

Academic qualification

Career History

Key competence and skills

Senior Resident in Obstetrics and Gynecology

To seek employment as a gynecologist at one of the largest health facilities.

M.B.B.S, Narayana Medical College, Nellore, N.T.R University 2005-2011

Senior Resident in Obstetrics and Gynecology, Golconda Area Hospital, Hyderabad Jan 2015-16`,
    want: {
      name: 'Amulya Lagadapati',
      title: 'Senior Resident in Obstetrics and Gynecology',
      currentCompany: 'Golconda Area Hospital',
    },
  },
  {
    /* Every hospital on this CV is somewhere he does NOT work: one is in
       his postal address, one is a clinical-training table. A blank
       employer is the correct answer, and "X-Ray) Hamidia Hospital" - cut
       out of the middle of the table - was not. */
    what: 'a technician whose only hospitals are an address and a training table',
    cv: `RAHUL PANDEY
RADIOLOGY TECHNICIAN | X-RAY - CT - MRI IMAGING SPECIALIST
Near Hamidia Hospital, Bhopal, Madhya Pradesh - 462001 | +91 8853052577 | rahul@example.com

PROFILE
Radiology technician with 3 years of hands-on imaging experience.

CLINICAL TRAINING EXPERIENCE
Duration Type Institution
9 Months Radiology (X-Ray) Hamidia Hospital, Bhopal
17 Months CT and MRI Saral Diagnostic and Imaging Center

SKILLS
X-Ray Positioning, CT Imaging, MRI Safety, PACS`,
    want: { name: 'RAHUL PANDEY', title: 'RADIOLOGY TECHNICIAN' },
    mustBeBlank: ['currentCompany'],
    skillsMustBe: ['X-Ray Positioning', 'CT Imaging', 'MRI Safety', 'PACS'],
  },
  {
    /* A fresher's career objective contains the word "organization", and
       a newline is an accepted separator after a label - so her employer
       was stored as "where I can utilize my knowledge of Core Java...".
       Her certifications were read as a designation for the same reason:
       "Certified in Ai Data Scientist" contains the word "scientist". */
    what: 'a fresher whose objective and certifications are not a job',
    cv: `PREMA KUMARI DASARI
6302907573 | prema@example.com

CAREER OBJECTIVE
To begin my career as a Java Developer in a challenging and growth-oriented organization
where I can utilize my knowledge of Core Java, Object-Oriented Programming and SQL.

CERTIFICATIONS
Certified in Salesforces.
Certified in Ai Data Scientist

SKILLS
Core Java, SQL, HTML, CSS`,
    want: { name: 'PREMA KUMARI DASARI' },
    mustBeBlank: ['currentCompany', 'title'],
    skillsMustBe: ['Core Java', 'SQL', 'HTML', 'CSS'],
  },
];

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

for (const c of CASES) {
  console.log(`\n${c.what}\n`);
  const { fields } = extractFields(c.cv);

  for (const [k, want] of Object.entries(c.want)) {
    const got = fields[k];
    const ok = String(got == null ? '' : got).toLowerCase().includes(String(want).toLowerCase());
    check(ok, `  ${k} reads "${want}" (got ${JSON.stringify(got)})`);
  }

  /* A field that must NOT be filled. Half of what was reported as "wrong
     info" was the parser answering a question the resume never asked. */
  for (const k of c.mustBeBlank || []) {
    const got = fields[k];
    check(!got, `  ${k} is left blank (got ${JSON.stringify(got)})`);
  }

  if (!c.skillsMustBe) continue;
  const skills = fields.skills || [];
  /* Every skill the resume lists, and NOTHING else. The second half is
     the part that was broken. */
  for (const s of c.skillsMustBe) {
    check(skills.some((x) => x.toLowerCase() === s.toLowerCase()), `  skill "${s}" was read`);
  }
  const junk = skills.filter((x) => !c.skillsMustBe.some((s) => s.toLowerCase() === x.toLowerCase()));
  check(junk.length === 0, `  no junk in the skills list (${junk.length}${junk.length ? ': ' + JSON.stringify(junk) : ''})`);
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
