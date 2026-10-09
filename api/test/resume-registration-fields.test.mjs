/**
 * What the resume reader gives the simplified registration form: name, phone, email, highest education, the most
 * recent role and employer, skills - and the projects count that used to be wrong.
 *
 * Pure parser tests: no database, no AI. Each case is a resume written the way people write them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_API_KEY = '';
const { extractFields, highestEducation, recentEmployment } = await import('../src/resume/fields.js');

const resume = (parts) => parts.join('\n');
const HEAD = ['PRIYA SHARMA', 'priya.sharma.dev@gmail.com | +91 98765 43210', 'Hyderabad', ''];

test('two projects as bullets are two projects, not twelve', () => {
  const { fields } = extractFields(resume([...HEAD,
    'EDUCATION', 'B.Sc (Statistics), Osmania University, 2021, 78%', '',
    'Academic Projects:', '- Student Management System', '- Personal Portfolio Website', '',
    'SKILLS', 'SQL, Excel, Python']));
  assert.equal(fields.projects.length, 2, JSON.stringify(fields.projects));
  assert.match(fields.projects[0], /^Student Management System/);
  assert.match(fields.projects[1], /^Personal Portfolio Website/);
});

test('the bullet points under a project are its details, not more projects', () => {
  const { fields } = extractFields(resume([...HEAD,
    'PROJECTS',
    'Student Management System',
    '• Developed the login and attendance modules using Java and Spring Boot.',
    '• Wrote 40 unit tests with JUnit and Mockito.',
    '• Technologies: Java, Spring Boot, MySQL, Git',
    'Personal Portfolio Website',
    '• Built a responsive site with HTML, CSS and JavaScript.',
    '• Deployed it on GitHub Pages.',
    '', 'SKILLS', 'Java, SQL']));
  assert.equal(fields.projects.length, 2, JSON.stringify(fields.projects));
  assert.match(fields.projects[0], /Student Management System - .*login and attendance.*unit tests.*MySQL/);
  assert.match(fields.projects[1], /Personal Portfolio Website - .*responsive site.*GitHub Pages/);
});

test('"Name - what it did" on one line is one project, and the same title twice is one', () => {
  const { fields } = extractFields(resume([...HEAD,
    'PROJECTS',
    'Payment Gateway Integration - Spring Boot service handling UPI payments',
    'Inventory Reporting Dashboard - SQL and Java reporting for retail stores',
    'Payment Gateway Integration - Spring Boot service handling UPI payments']));
  assert.equal(fields.projects.length, 2, JSON.stringify(fields.projects));
});

test('nothing is made up: no projects, education, experience or skills section means no values', () => {
  const { fields } = extractFields(resume(['RAHUL N', 'rahul.n@example.org', 'Mobile: 9123456780', '', 'Career objective', 'To work in a growing company.']));
  for (const k of ['projects', 'highestEducation', 'educationRecords', 'skills', 'title', 'currentCompany']) {
    assert.equal(fields[k], undefined, `${k}: ${JSON.stringify(fields[k])}`);
  }
  assert.equal(fields.email, 'rahul.n@example.org');
});

test('skills are distinct, whatever the case', () => {
  const { fields } = extractFields(resume([...HEAD, 'SKILLS', 'Java, java, SQL, Sql, Spring Boot, JAVA']));
  assert.deepEqual(fields.skills, ['Java', 'SQL', 'Spring Boot']);
});

test('highest education: the highest the document supports, not the first or last written', () => {
  const a = extractFields(resume([...HEAD, 'EDUCATION',
    'SSC, ZP High School, 2013, 9.2 CGPA', 'Intermediate (MPC), Sri Chaitanya Junior College, 2015, 92%',
    'B.Tech (Computer Science), JNTU Hyderabad, 2019, 74%']));
  assert.equal(a.fields.highestEducation, "Bachelor's Degree");
  const b = extractFields(resume([...HEAD, 'EDUCATION', 'B.Tech, JNTU, 2019', 'MBA, IIM Indore, 2022', 'Intermediate, X College, 2015']));
  assert.equal(b.fields.highestEducation, "Master's Degree");
  const c = extractFields(resume([...HEAD, 'EDUCATION', 'Intermediate (MPC), Narayana College, 2020']));
  assert.equal(c.fields.highestEducation, 'Intermediate');
  const d = extractFields(resume([...HEAD, 'EDUCATION', 'Ph.D (Physics), IISc, 2018', 'M.Sc, Osmania, 2013']));
  assert.equal(d.fields.highestEducation, 'PhD');
  assert.equal(highestEducation([], null), null);
  assert.equal(highestEducation([{ level: 'Some Course' }], null), null, 'an unrecognised line supports nothing');
});

test('most recent job: by dates, in whatever order they are written', () => {
  const oldestFirst = extractFields(resume([...HEAD, 'WORK EXPERIENCE',
    'Infotech Systems - Associate Software Engineer (Jun 2019 - Jun 2020)',
    'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)',
    'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)']));
  assert.equal(oldestFirst.fields.currentCompany, 'ABC Technologies Pvt Ltd');
  assert.match(oldestFirst.fields.title, /Senior Software Engineer/);
  assert.equal(oldestFirst.notes.recentEmploymentUncertain, undefined);

  const newestFirst = extractFields(resume([...HEAD, 'WORK EXPERIENCE',
    'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)',
    'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)']));
  assert.equal(newestFirst.fields.currentCompany, 'ABC Technologies Pvt Ltd');

  const finished = extractFields(resume([...HEAD, 'WORK EXPERIENCE',
    'Alpha Soft Pvt Ltd - Software Engineer (Jan 2018 - Dec 2019)',
    'Beta Labs Pvt Ltd - Senior Software Engineer (Jan 2020 - Mar 2023)']));
  assert.equal(finished.fields.currentCompany, 'Beta Labs Pvt Ltd');
});

test('several jobs with no dates: a best guess is flagged for the candidate to check', () => {
  const r = extractFields(resume([...HEAD, 'WORK EXPERIENCE',
    'Alpha Soft Pvt Ltd - Software Engineer',
    'Beta Labs Pvt Ltd - Senior Software Engineer']));
  assert.equal(r.notes.recentEmploymentUncertain, true);
  assert.ok(recentEmployment([{ company: 'A', title: 'x', period: null }, { company: 'B', title: 'y', period: null }]).certain === false);
});

test('a referee\'s email or number is not the candidate\'s', () => {
  const ok = extractFields(resume(['ARUN KUMAR', 'arun.kumar@gmail.com | 9876501234', '', 'SKILLS', 'SQL', '',
    'REFERENCES', 'Mr. Rao, Manager, rao@client.com, 9000011111']));
  assert.equal(ok.fields.email, 'arun.kumar@gmail.com');
  assert.equal(ok.fields.phone, '9876501234');

  /* two addresses and nothing in the heading to say which is theirs: left empty, not guessed */
  const unclear = extractFields(resume(['ARUN KUMAR', 'Hyderabad', '', 'SKILLS', 'SQL', '',
    'Contact: first.person@gmail.com', 'Alternate: other.person@yahoo.com']));
  assert.equal(unclear.fields.email, undefined);
  assert.equal(unclear.notes.emailAmbiguous, true);
});

test('reading the same resume twice gives the same answer (nothing accumulates)', () => {
  const text = resume([...HEAD, 'PROJECTS', 'Student Management System', '• Built the attendance module.', '', 'SKILLS', 'Java, SQL']);
  assert.deepEqual(extractFields(text), extractFields(text));
});
