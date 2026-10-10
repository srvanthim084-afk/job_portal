/**
 * What the resume reader gives the simplified registration form: name, phone, email, highest education, the most
 * recent role and employer, skills - and the projects count that used to be wrong.
 *
 * Pure parser tests: no database, no AI. Each case is a resume written the way people write them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_API_KEY = '';
const { extractFields, highestEducation, recentEmployment, totalExperienceMonths, shortDegree } = await import('../src/resume/fields.js');

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

test('responsibilities under a job belong to that job; a bullet is never a job of its own', () => {
  const { fields } = extractFields(resume([...HEAD, 'WORK EXPERIENCE',
    'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)',
    '• Built payment microservices in Java and Spring Boot.',
    '• Developed REST APIs, SQL reporting and dashboards.',
    '• Mentored 3 junior engineers.',
    'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)',
    '- Worked on SQL reporting, Excel automation',
    '- Wrote unit tests with JUnit.',
    '', 'SKILLS', 'Java, SQL']));
  assert.equal(fields.employmentHistory.length, 2, JSON.stringify(fields.employmentHistory));
  assert.match(fields.employmentHistory[0].details, /payment microservices.*REST APIs.*Mentored/);
  assert.match(fields.employmentHistory[1].details, /SQL reporting.*unit tests/);
  assert.doesNotMatch(fields.employmentHistory[0].details, /unit tests/, 'the next job\'s lines are not this job\'s');
});

/* ------------------------------------------------------------------ *
 * "Role | Company - Place" with the dates below; total experience; degrees in full; Word line breaks
 * ------------------------------------------------------------------ */
const PIPED = resume(['RAHUL KUMAR REDDY', 'SOFTWARE DEVELOPER | 3 YEARS OF EXPERIENCE',
  '+91 98765 43210 | rahul.reddy@example.com | Hyderabad, Telangana',
  'Preferred Location: Hyderabad, Bengaluru | Notice Period: 30 Days', '',
  'WORK EXPERIENCE',
  'Software Developer | ABC Technologies Pvt. Ltd. — Hyderabad, Telangana', 'June 2023 – Present',
  'Developed responsive web applications using React.js.', 'Built REST APIs using Node.js.',
  'Junior Web Developer | Bright Solutions Pvt. Ltd. — Vijayawada, Andhra Pradesh', 'June 2022 – May 2023',
  'Created responsive web pages using HTML and CSS.', '',
  'EDUCATION', 'Bachelor of Technology (B.Tech), Computer Science and Engineering',
  'Sunrise Institute of Technology | Jawaharlal Nehru Technological University | 2022 | 78%', '',
  'TECHNICAL SKILLS', 'Programming: JavaScript, Java, SQL', 'Frontend: HTML5, CSS3, React.js']);

test('"Role | Company - Place" with the dates on the next line: every job, its company and its dates', () => {
  const { fields } = extractFields(PIPED);
  assert.equal(fields.employmentHistory.length, 2, JSON.stringify(fields.employmentHistory));
  assert.deepEqual(fields.employmentHistory.map((e) => [e.company, e.title, e.period]), [
    ['ABC Technologies Pvt. Ltd.', 'Software Developer', 'June 2023 – Present'],
    ['Bright Solutions Pvt. Ltd.', 'Junior Web Developer', 'June 2022 – May 2023'],
  ]);
  assert.equal(fields.currentCompany, 'ABC Technologies Pvt. Ltd.');
  assert.match(fields.employmentHistory[0].details, /responsive web applications.*REST APIs/);
  assert.doesNotMatch(fields.employmentHistory[0].details, /HTML and CSS/, 'the next job\'s lines are its own');
});

test('total experience: every job\'s dates added up (overlaps once), not the one figure in the headline', () => {
  const { fields } = extractFields(PIPED);
  /* June 2022 - May 2023 (12 months) + June 2023 - today: more than the "3 YEARS" the headline states */
  assert.ok(fields.expYears > 4, String(fields.expYears));
  const oct2026 = new Date(2026, 9, 10);
  const jobs = [{ period: 'June 2023 – Present' }, { period: 'June 2022 – May 2023' }];
  assert.equal(totalExperienceMonths(jobs, oct2026), 53, '41 + 12 months');
  /* overlapping jobs count once; "2018 - 2020" style years work; a job without dates adds nothing */
  assert.equal(totalExperienceMonths([{ period: 'Jan 2020 - Dec 2021' }, { period: 'Jun 2021 - Mar 2022' }], oct2026), 27);
  assert.equal(totalExperienceMonths([{ period: '2018 - 2020' }], oct2026), 36);
  assert.equal(totalExperienceMonths([{ period: null }], oct2026), null);
  /* no dates anywhere: the stated figure is used */
  const stated = extractFields(resume([...HEAD, 'Total Experience: 6 years', '', 'SKILLS', 'SQL']));
  assert.equal(stated.fields.expYears, 6);
});

test('a degree written out in full is read as its short form, with the field of study and the institution apart', () => {
  const { fields } = extractFields(PIPED);
  assert.equal(fields.educationRecords.length, 1);
  const e = fields.educationRecords[0];
  assert.deepEqual([e.qualification, e.specialization, e.institution, e.passingYear, e.score],
    ['B.Tech', 'Computer Science and Engineering', 'Sunrise Institute of Technology', '2022', '78%']);
  assert.equal(fields.highestEducation, "Bachelor's Degree");
  assert.equal(shortDegree('Master of Business Administration (MBA), Finance'), 'MBA, Finance');
  assert.equal(shortDegree('Bachelor of Science in Statistics'), 'B.Sc in Statistics');
});

test('a Word resume\'s line breaks inside one paragraph are kept: skills are not glued to the next label', async () => {
  const { extractResumeText } = await import('../src/resume/extract.js');
  const { makeDocx } = await import('../../tools/lib/docx.mjs');
  const buf = makeDocx(['RAHUL KUMAR REDDY', '+91 98765 43210 | rahul.reddy@example.com | Hyderabad\nPreferred Location: Hyderabad',
    'TECHNICAL SKILLS', 'Programming: JavaScript, Java, SQL\nFrontend: HTML5, CSS3\nTools: Git, GitHub']);
  const doc = await extractResumeText(buf, 'resume.docx');
  assert.match(doc.text, /SQL\nFrontend: HTML5/);
  assert.match(doc.text, /Hyderabad\nPreferred Location/);
  const { fields } = extractFields(doc.text);
  assert.deepEqual(fields.skills, ['JavaScript', 'Java', 'SQL', 'HTML5', 'CSS3', 'Git', 'GitHub']);
});

test('preferred location: every city named, up to the next field on the line', () => {
  const { fields } = extractFields(PIPED);
  assert.equal(fields.preferredLocation, 'Hyderabad, Bengaluru');
});
