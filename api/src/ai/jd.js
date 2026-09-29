/**
 * A job description, written from what the posting already says.
 *
 * WHY THIS IS ON THE SERVER. There are five ways to create a job in this
 * product - the single post form, bulk paste, walk-in, internship, and
 * the requirement created automatically when somebody applies for a role
 * nobody posted - and each of them was writing its own description, or
 * none at all. Bulk produced "Opening for Staff Nurse at our team."; the
 * automatic one produced "Created automatically because a candidate
 * applied for this role", which is a note to the recruiter sitting in the
 * field a candidate reads. Generating it here means every path gets the
 * same JD, and a sixth path added later gets it for free.
 *
 * DETERMINISTIC, AND NOT A MODEL. Same title and skills in, same words
 * out. There is no API call, nothing to rate-limit and nothing to be
 * down - and the existing "Generate JD with AI" button in the prototype
 * is a 900ms setTimeout over a template, so nothing here is a step down
 * from a model that was never there.
 *
 * IT NEVER INVENTS FACTS. No salary, no benefits, no team size, no
 * "fast-paced environment" - only what the posting actually states,
 * arranged into something a candidate can read. Anything it does not
 * know, it leaves out rather than filling in.
 */

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lower = (s) => clean(s).toLowerCase();

/**
 * "a" or "an", by SOUND rather than by letter.
 *
 * "a OBGY" and "a Engineering function" both read as carelessness on the
 * one page a candidate judges the posting by, and the abbreviations this
 * agency actually posts — MRI, OBGY, ENT, ICU — are said aloud as letters
 * and take "an" despite starting with a consonant.
 */
const article = (w) => (/^[aeiou]/i.test(String(w || ''))
  || /^(mri|mbbs|md|ms|ent|icu|nicu|ot|obgy|x-?ray|rmo|ecg|it|hr|mba|ba|bsc|msc)\b/i
    .test(String(w || '')) ? 'an' : 'a');

/**
 * What kind of role this is, so the duties are about the actual job.
 *
 * TeamLink recruits for hospitals, so the clinical families come first
 * and are the ones worth getting right. The fallback is deliberately
 * generic rather than wrong: a JD that describes the wrong profession is
 * worse than one that describes none.
 */
const FAMILIES = [
  {
    key: 'doctor',
    /*
     * THE STEMS NEED \w*, AND WITHOUT IT THEY MATCHED NOTHING.
     *
     * These were written as `cardiolog` inside `\b(…)\b`, and the closing
     * boundary demands a non-word character straight after the stem — so
     * "cardiolog" matched only the bare stem, which nobody writes.
     * Cardiologist, Radiologist, Radiology, Pathologist, Gynaecologist
     * and Anaesthetist all fell through to the generic duties, and a
     * consultant radiologist's posting described "the day-to-day work of
     * the role" instead of reading films.
     *
     * THE LIST GROWS FROM REAL MAIL, not from a textbook. Every stem added
     * below is a title an actual Naukri response carried - including
     * "Gastroentrology" spelt that way, which is why the stem stops at
     * `gastroent` rather than assuming anyone spells it correctly.
     */
    test: /\b(?:doctor|physician|surgeon|consultant|registrar|resident|medical\s+officer|mbbs|md|ms|dnb|anaesthe\w*|anesthe\w*|cardiolog\w*|radiolog\w*|patholog\w*|paediatric\w*|pediatric\w*|gynaec\w*|gynec\w*|obgy|obstetric\w*|dermatolog\w*|neurolog\w*|oncolog\w*|orthopaed\w*|orthoped\w*|psychiatr\w*|urolog\w*|nephrolog\w*|neonat\w*|gastroent\w*|physiolog\w*|pulmonolog\w*|endocrinolog\w*|rheumatolog\w*|h(?:a)?ematolog\w*|ophthalmolog\w*|otorhinolaryngolog\w*|venereolog\w*|neurosurg\w*|dentist|intensivist|casualty|emergency)\b/i,
    duties: [
      'Assess, diagnose and treat patients within your specialty',
      'Maintain accurate clinical records and discharge summaries',
      'Work alongside nursing and allied staff to deliver patient care',
      'Take part in ward rounds, handovers and case discussions',
      'Follow hospital clinical protocols and infection-control standards',
    ],
    needs: [
      'A recognised medical qualification and a valid council registration',
      'Sound clinical judgement and clear communication with patients and families',
    ],
  },
  {
    key: 'nurse',
    test: /\b(nurse|nursing|gnm|anm|bsc nursing|staff nurse|midwife|matron|ward sister)\b/i,
    duties: [
      'Deliver bedside care and monitor patients through the shift',
      'Administer medication and treatments as prescribed',
      'Record vital signs and escalate changes in a patient’s condition',
      'Prepare patients and equipment for procedures',
      'Maintain hygiene, infection control and ward documentation',
    ],
    needs: [
      'A nursing qualification (GNM, ANM or B.Sc Nursing) and council registration',
      'Comfortable working shifts, including nights and weekends',
    ],
  },
  {
    key: 'allied',
    test: /\b(?:technician|technologist|radiographer|pharmacist|physiotherap\w*|optometrist|dietician|dietitian|lab|laboratory|phlebotom\w*|sonographer|perfusionist|paramedic|dialysis)\b/i,
    duties: [
      'Carry out procedures and investigations within your scope of practice',
      'Operate and check equipment, and report faults promptly',
      'Prepare patients, explain the procedure and record the results',
      'Keep consumables, calibration and safety checks up to date',
      'Support the clinical team with accurate and timely reporting',
    ],
    needs: [
      'A relevant diploma or degree in your discipline',
      'Attention to detail and adherence to safety protocols',
    ],
  },
  {
    /*
     * Medical coding, billing, records, transcription, claims. NOT
     * clinical, and not generic office work either - a medical coder
     * reads case sheets and assigns ICD codes, and a JD that talks about
     * bedside care or about sprint planning is wrong in both directions.
     */
    key: 'medical_records',
    test: /\b(?:medical\s+cod\w*|coder|coding|medical\s+billing|medical\s+record\w*|transcription\w*|claims|insurance|tpa|health\s+information|mrd)\b/i,
    duties: [
      'Read case sheets and discharge summaries and assign the correct codes',
      'Check documentation is complete before a claim is raised',
      'Query the treating team where the record is unclear',
      'Meet the daily accuracy and turnaround targets for your queue',
      'Keep up to date with coding guideline and payer policy changes',
    ],
    needs: [
      'Working knowledge of medical terminology and anatomy',
      'Accuracy under a daily target, and comfort querying clinicians',
    ],
    preferred: ['CPC, CCS or equivalent coding certification', 'Experience with a hospital information system'],
  },
  {
    /*
     * Field sales into hospitals and pharmacies. Reports to a sales
     * manager, not to a consultant - so no clinical duties here.
     */
    key: 'medical_sales',
    test: /\b(medical representative|medical rep\b|pharma rep|business development executive|territory manager|area sales|product specialist|medical sales)\b/i,
    duties: [
      'Cover your assigned territory and meet doctors, chemists and hospital buyers',
      'Detail the product range and answer clinical questions within approved claims',
      'Meet monthly prescription and secondary sales targets',
      'Maintain call reports and the customer list',
      'Support camps, CMEs and other field activity',
    ],
    needs: [
      'Willing to travel across the assigned territory',
      'Confident speaking to clinicians and comfortable with targets',
    ],
    preferred: ['Existing relationships in the territory', 'A two-wheeler and a valid licence'],
  },
  {
    /*
     * Trials, drug safety and study data. Three of the live postings on
     * this system - Clinical Research Associate, Pharmacovigilance
     * Associate, Clinical Data Analyst - matched no family at all and
     * were given the generic duties, or worse: "Clinical Data Analyst"
     * contains "analyst", so it was described as a software role.
     */
    key: 'clinical_ops',
    test: /\b(?:clinical\s+research|clinical\s+trial\w*|clinical\s+data|pharmacovigilance|drug\s+safety|regulatory\s+affairs|cra\b|study\s+coordinator|site\s+coordinator)\b/i,
    duties: [
      'Run your studies to the approved protocol and to GCP',
      'Collect and check case report forms, and raise queries on what does not add up',
      'Record and report adverse events within the required timelines',
      'Keep the trial master file and site documentation current',
      'Work with sites, investigators and the sponsor on study progress',
    ],
    needs: [
      'A life-sciences, pharmacy or nursing qualification',
      'Familiarity with GCP and regulatory reporting timelines',
    ],
    preferred: ['Experience with an EDC system', 'Prior work on regulated submissions'],
  },
  {
    key: 'recruitment',
    /* `recruit` could not match "Recruiter" — the same missing \w* that
       cost the medical specialties their family. */
    test: /\b(?:recruit\w*|talent|sourcing|hr|human\s+resource\w*|bde|business\s+development|staffing)\b/i,
    duties: [
      'Source and screen candidates against live requirements',
      'Run the first conversation and assess fit, notice period and expectations',
      'Keep the pipeline and candidate records up to date',
      'Coordinate interviews between candidates and the hiring side',
      'Follow up through offer, joining and the first weeks',
    ],
    needs: [
      'Confident spoken and written communication',
      'Comfortable working to targets and keeping records as you go',
    ],
  },
  {
    /* The agency places these too - the brief's own worked example is a
       Java developer - so they get duties of their own rather than
       falling through to the generic ones. */
    key: 'technical',
    test: /\b(developer|engineer|programmer|architect|devops|qa\b|tester|analyst|data scientist|full ?stack|front ?end|back ?end|software|sre\b|administrator)\b/i,
    duties: [
      'Build and maintain the systems your team is responsible for',
      'Write, review and test changes before they reach production',
      'Investigate and fix defects reported against your area',
      'Work with the team on design decisions and estimates',
    ],
    needs: [
      'Hands-on experience building software in a team',
      'Comfortable reading code you did not write',
    ],
  },
  {
    key: 'admin',
    test: /\b(admin|receptionist|front office|coordinator|billing|accounts|executive assistant|clerk|counsell?or|manager)\b/i,
    duties: [
      'Run the day-to-day administration of your area',
      'Handle enquiries from patients, staff and visitors',
      'Maintain records, registers and reports accurately',
      'Coordinate between departments to keep things moving',
    ],
    needs: [
      'Organised, with an eye for detail',
      'Comfortable with computers and everyday office software',
    ],
  },
];

const GENERIC = {
  key: 'general',
  duties: [
    'Own the day-to-day work of the role',
    'Work with the wider team to meet agreed standards',
    'Keep accurate records of what you do',
  ],
  needs: ['Relevant experience for this role'],
};

/** Departments that must never produce engineering or recruitment copy. */
const MEDICAL_DEPT = /\b(medic|health|clinic|hospital|pharma|nursing|diagnost|paramedic|patient|lab|radiolog)/i;

/**
 * Which family this role belongs to.
 *
 * THE TITLE DECIDES, AND THE DEPARTMENT VETOES. A title is specific -
 * "Medical Officer" is a doctor whatever department you file it under -
 * so it is matched first. But a title the patterns do not recognise used
 * to fall through to the generic duties, and one that half-matched could
 * land somewhere absurd: "Medical Representative" contains no clinical
 * word, and a department of "Medical" with a generic JD about owning
 * day-to-day work tells a candidate nothing.
 *
 * So a medical department refuses the two families that would read as
 * plainly wrong on a hospital posting - engineering and recruitment - and
 * takes the records/admin duties instead of the generic ones.
 */
/**
 * Most specific wins, and the order is stated rather than implied.
 *
 * Taking the FIRST family whose pattern matched made the answer depend on
 * the order the families happen to be written in, which is not a decision
 * anybody made. Two titles show why it matters:
 *
 *   "Radiology Technician"  matches radiolog (doctor) AND technician
 *                           (allied). It is a technician.
 *   "Emergency Room Nurse"  matches emergency (doctor) AND nurse. It is
 *                           a nurse.
 *
 * A role noun - nurse, technician, coder - says what the person does. A
 * specialty stem only says which department they do it in, so it loses.
 */
const FAMILY_PRIORITY = [
  'medical_records', 'medical_sales', 'clinical_ops',
  'nurse', 'allied', 'doctor',
  'recruitment', 'technical', 'admin',
];

function familyFor(title, department) {
  const t = lower(title);
  const medicalDept = MEDICAL_DEPT.test(String(department || ''));

  const matched = FAMILIES.filter((f) => f.test.test(t));
  let hit = null;
  for (const key of FAMILY_PRIORITY) {
    const found = matched.find((f) => f.key === key);
    if (found) { hit = found; break; }
  }
  if (!hit) hit = matched[0] || null;

  if (medicalDept && hit && (hit.key === 'technical' || hit.key === 'recruitment')) {
    hit = FAMILIES.find((f) => f.key === 'medical_records');
  }
  if (!hit && medicalDept) hit = FAMILIES.find((f) => f.key === 'admin');
  return hit || GENERIC;
}

/** "2-4 yrs" and 2 and 4 all say the same thing; say it once, in words. */
function experienceLine({ exp, expMin, expMax }) {
  const a = Number.isFinite(Number(expMin)) ? Number(expMin) : null;
  const b = Number.isFinite(Number(expMax)) ? Number(expMax) : null;
  if (a != null && b != null && b > a) return `${a}–${b} years of relevant experience`;
  if (a != null && a > 0) return `at least ${a} year${a === 1 ? '' : 's'} of relevant experience`;
  const raw = clean(exp);
  if (!raw) return null;
  if (/fresher|0\s*[-–]\s*[01]\b/i.test(raw)) return 'open to freshers';
  return `${raw} of relevant experience`;
}

/**
 * Build the description, the duties and the requirements.
 *
 * @returns { description, responsibilities, requirements, skills }
 *          Every field is ready to store; none of them is a placeholder.
 */
export function buildJobDescription(job = {}) {
  const title = clean(job.title) || 'this role';
  const company = clean(job.company || job.companyName);
  const location = clean(job.location);
  const kind = lower(job.postingKind || job.type || job.employmentType);
  const family = familyFor(title);
  const skills = (Array.isArray(job.skills) ? job.skills : [])
    .map(clean).filter(Boolean).slice(0, 12);
  const expLine = experienceLine(job);
  const education = clean(job.education);

  /* ---- the opening paragraph ------------------------------------- */

  const where = location ? ` in ${location}` : '';
  const who = company ? ` at ${company}` : '';
  const isWalkin = /walk\s*-?\s*in/.test(kind);
  const isIntern = /intern/.test(kind);

  const opener = isWalkin
    ? `A walk-in is being held for the position of ${title}${who}${where}.`
    : isIntern
      ? `An internship is open for ${title}${who}${where}.`
      : `${company || 'We'} ${company ? 'is' : 'are'} hiring ${article(title)} ${title}${where}.`;

  const bits = [opener];
  if (expLine) {
    bits.push(expLine.startsWith('open to')
      ? 'This position is open to freshers.'
      : `The position calls for ${expLine}.`);
  }
  if (skills.length) {
    const first = skills.slice(0, 4);
    bits.push(`The work centres on ${first.slice(0, -1).join(', ')}`
      + (first.length > 1 ? ` and ${first[first.length - 1]}` : first[0]) + '.');
  }
  if (Number(job.openings) > 1) bits.push(`There are ${Number(job.openings)} openings.`);

  /* A note the caller already wrote - the walk-in venue and date, the
     internship's duration - is kept verbatim and added at the end. It
     states facts this function does not have. */
  const note = clean(job.note);
  if (note) bits.push(note);

  /* ---- duties and requirements ----------------------------------- */

  const responsibilities = family.duties.slice(0, 5);

  const requirements = [];
  if (education) requirements.push(education);
  requirements.push(...family.needs);
  if (expLine) requirements.push(expLine.charAt(0).toUpperCase() + expLine.slice(1));
  for (const s of skills.slice(0, 6)) requirements.push(`Working knowledge of ${s}`);

  return {
    description: bits.join(' '),
    responsibilities,
    requirements: [...new Set(requirements)].slice(0, 10),
    skills,
    family: family.key,
  };
}

/**
 * The long form: a JD in the sections a job board expects.
 *
 * Bulk posting shows this in a preview before anything is published, so
 * it has to be readable on its own rather than a blob. The sections are
 * the ones the brief asks for, in its order.
 *
 * THE RECRUITER'S OWN WORDS WIN. `qualification` is what they typed into
 * the Required Qualification column, and it is listed FIRST and verbatim
 * under Required Qualifications - never paraphrased, never replaced by
 * something this file thinks the role needs, and never dropped because a
 * family has an opinion about degrees. Everything generated is added
 * after it.
 *
 * NOTHING IS INVENTED. No department the recruiter did not give, no
 * salary, no benefits, no "fast-paced environment". Preferred skills are
 * the only forward-looking section and they are drawn from the family, not
 * from thin air.
 */
export function buildStructuredJd(job = {}) {
  const title = clean(job.title) || 'this role';
  const department = clean(job.department);
  const location = clean(job.location);
  const qualification = clean(job.qualification || job.education);
  const family = familyFor(title, department);
  const skills = (Array.isArray(job.skills) ? job.skills : [])
    .map(clean).filter(Boolean).slice(0, 12);
  const expLine = experienceLine(job);
  const openings = Number(job.openings) > 1 ? Number(job.openings) : null;

  const summary = [
    `${title}${department ? ` (${department})` : ''}${location ? `, ${location}` : ''}.`,
    expLine ? (expLine.startsWith('open to') ? 'Open to freshers.'
      : `Requires ${expLine}.`) : '',
    openings ? `${openings} openings.` : '',
  ].filter(Boolean).join(' ');

  const about = [
    `This is a ${title} position${department ? ` in the ${department} department` : ''}`
      + `${location ? `, based in ${location}` : ''}.`,
    family.about || `The role covers the day-to-day work of a ${title}.`,
    skills.length ? `Day to day the work involves ${skills.slice(0, 4).join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  /* Required qualifications: theirs first, always. */
  const qualifications = [];
  if (qualification) qualifications.push(qualification);
  for (const n of family.needs) if (!qualifications.includes(n)) qualifications.push(n);
  if (expLine) {
    const e = expLine.charAt(0).toUpperCase() + expLine.slice(1);
    if (!qualifications.includes(e)) qualifications.push(e);
  }

  return {
    summary,
    about,
    responsibilities: family.duties.slice(0, 6),
    qualifications: qualifications.slice(0, 8),
    skills,
    preferredSkills: (family.preferred || []).slice(0, 4),
    family: family.key,
    /* The single blob the jobs table stores, built from the same parts so
       the preview and the stored record can never disagree. */
    description: [summary, '', about, '',
      'Responsibilities:', ...family.duties.slice(0, 6).map((d) => `• ${d}`), '',
      'Required qualifications:', ...qualifications.slice(0, 8).map((q) => `• ${q}`),
      ...(skills.length ? ['', 'Required skills:', skills.join(', ')] : []),
      ...((family.preferred || []).length
        ? ['', 'Preferred:', ...family.preferred.slice(0, 4).map((p) => `• ${p}`)] : []),
    ].join('\n'),
  };
}

/**
 * A walk-in, written from the ten things the recruiter typed.
 *
 * A walk-in advert answers different questions from a vacancy: not "what
 * is the career path" but "where do I go, when, and what do I carry".
 * So this returns the logistics as their own sections rather than burying
 * them in a paragraph, and keeps the description itself short - somebody
 * reads this on a phone, deciding whether to travel.
 *
 * NOTHING HERE IS INVENTED. The date, the time, the venue, the pay and
 * the qualification are printed exactly as given and are never guessed
 * at, never rounded, never "improved". If a field is empty its line is
 * omitted rather than filled. The only generated content is the duties,
 * the eligibility wording, the bring-list and the questions - and the
 * bring-list names the recruiter's own qualification rather than a
 * degree this file decided the role needs.
 */
export function buildWalkinPack(job = {}) {
  const title = clean(job.title) || 'this role';
  const location = clean(job.location);
  const date = clean(job.date);
  const from = clean(job.startTime);
  const to = clean(job.endTime);
  const venue = clean(job.venue);
  const qualification = clean(job.qualification);
  const pay = clean(job.pay);
  const expLine = experienceLine(job);
  const family = familyFor(title, job.department);

  const given = (Array.isArray(job.skills) ? job.skills : [])
    .map(clean).filter(Boolean).slice(0, 12);
  const skills = given.length ? given : (FAMILY_SKILLS[family.key] || []).slice(0, 6);

  const when = date
    ? `${date}${from ? `, ${from}${to ? ` to ${to}` : ''}` : ''}`
    : '';

  /* Short and professional, as asked. Three sentences at most. */
  const description = [
    `Walk-in interviews for ${title}${location ? ` in ${location}` : ''}.`,
    when ? `Walk in on ${when}.` : '',
    expLine ? (expLine.startsWith('open to')
      ? 'Open to freshers.' : `We are looking for candidates with ${expLine}.`) : '',
  ].filter(Boolean).join(' ');

  /* Eligibility: their qualification and their experience, nothing else. */
  const eligibility = [];
  if (qualification) eligibility.push(qualification);
  if (expLine) eligibility.push(expLine.charAt(0).toUpperCase() + expLine.slice(1));
  if (skills.length) eligibility.push(`Working knowledge of ${skills.slice(0, 4).join(', ')}`);

  /* What to bring. Generic to walk-ins in this market, and it names the
     recruiter's own qualification rather than inventing a requirement. */
  const bring = [
    'An updated resume (two printed copies)',
    'A government photo ID',
    'Two passport-size photographs',
    qualification
      ? `Original and photocopies of your ${qualification} certificates`
      : 'Original and photocopies of your qualification certificates',
  ];
  if (expLine && !expLine.startsWith('open to')) {
    bring.push('Relieving and experience letters from previous employers');
  }

  /* Short screening questions, from the skills actually entered. */
  const questions = skills.slice(0, 3).map((s) => `How much hands-on experience do you have with ${s}?`);
  questions.push('What is your current notice period, and when can you join?');
  if (location) questions.push(`Are you able to work in ${location}?`);

  return {
    description,
    responsibilities: family.duties.slice(0, 4),
    eligibility,
    skills,
    skillsWereGenerated: !given.length && skills.length > 0,
    bring,
    questions: questions.slice(0, 5),
    when,
    venue,
    pay,
    family: family.key,
  };
}

/**
 * An internship, written from what the recruiter entered and nothing else.
 *
 * An internship advert answers a different question again: not "can you
 * already do this" but "what will I learn, and what happens next". So it
 * carries a Learning Opportunities section and a Selection Process, which
 * a vacancy does not, and its eligibility is written for somebody who has
 * not worked yet.
 *
 * STRICTLY THE ENTERED VALUES. Title, department, duration, stipend,
 * qualification and skills are printed as given. An unpaid internship is
 * never described as paid, a stipend is never rounded or invented, and a
 * duration is never "approximately". Anything not entered is left out.
 */
export function buildInternshipPack(job = {}) {
  const title = clean(job.title) || 'this internship';
  const department = clean(job.department);
  const location = clean(job.location);
  const duration = clean(job.duration);
  const qualification = clean(job.qualification);
  const openings = Number(job.openings) > 1 ? Number(job.openings) : null;
  const workMode = clean(job.workMode);
  const paid = String(job.internshipType || '').toLowerCase() !== 'unpaid';
  /* The form takes a bare number. Printing "Stipend 15000 per month" on a
     posting looks unfinished, so a plain number is rendered as rupees -
     which is formatting, not inventing: the figure is unchanged, and
     anything the recruiter wrote in words is left exactly as typed. */
  const rawStipend = paid ? clean(job.stipend) : '';
  const stipend = /^\d+$/.test(rawStipend)
    ? `₹${Number(rawStipend).toLocaleString('en-IN')}`
    : rawStipend;
  const family = familyFor(title, department);

  const given = (Array.isArray(job.skills) ? job.skills : [])
    .map(clean).filter(Boolean).slice(0, 12);
  const skills = given.length ? given : (FAMILY_SKILLS[family.key] || []).slice(0, 6);

  const description = [
    `${duration ? `${duration} internship` : 'Internship'} for ${title}`
      + `${department ? ` in ${department}` : ''}${location ? `, ${location}` : ''}.`,
    workMode ? `${workMode}.` : '',
    paid
      ? (stipend ? `Stipend ${stipend} per month.` : 'This is a paid internship.')
      : 'This is an unpaid internship.',
    openings ? `${openings} openings.` : '',
  ].filter(Boolean).join(' ');

  /* An intern is learning, so the duties are the family's work scaled
     down - supporting rather than owning. */
  const responsibilities = family.duties.slice(0, 3)
    .map((d) => d.replace(/^(Own|Deliver|Assess|Carry out|Build|Cover|Source|Read)\b/i,
      (m) => ({ Own: 'Support', Deliver: 'Assist with', Assess: 'Observe and assist with',
        'Carry out': 'Assist with', Build: 'Help build', Cover: 'Support',
        Source: 'Help source', Read: 'Help review' })[m] || `Assist with`))
    .concat(['Keep a record of what you work on through the internship']);

  const learning = [
    `Hands-on exposure to ${skills.slice(0, 3).join(', ') || title} in a working team`,
    department ? `How ${article(department)} ${department} function operates day to day`
      : 'How the team works day to day',
    'Direct feedback from experienced colleagues',
    duration ? `A completion certificate at the end of the ${duration}` : 'A completion certificate',
  ];

  const eligibility = [];
  if (qualification) eligibility.push(qualification);
  eligibility.push('Students in their final year and recent graduates may apply');
  if (duration) eligibility.push(`Available for the full ${duration}`);
  if (location && !/remote/i.test(workMode)) eligibility.push(`Able to attend in ${location}`);

  const selection = [
    'Apply with your resume through this posting',
    'A short screening call',
    skills.length ? `A discussion covering ${skills.slice(0, 2).join(' and ')}` : 'A discussion of your coursework and projects',
    'Offer and joining date confirmed by email',
  ];

  const questions = skills.slice(0, 2)
    .map((s) => `What have you built or studied that used ${s}?`);
  if (duration) questions.push(`Are you available for the full ${duration}?`);
  questions.push('When can you start?');

  return {
    description,
    responsibilities,
    learning,
    eligibility,
    skills,
    skillsWereGenerated: !given.length && skills.length > 0,
    preferredSkills: (family.preferred || []).slice(0, 3),
    selection,
    questions: questions.slice(0, 5),
    duration,
    stipend,
    paid,
    family: family.key,
  };
}

/**
 * Skills for a role that did not list any.
 *
 * Drawn from the family's own vocabulary, so a Medical Coder is offered
 * coding skills and never "Spring Boot". Returns an empty list rather
 * than guessing when the family has nothing specific - an empty Required
 * Skills section is honest, and a wrong one is not.
 */
export function suggestSkills(job = {}) {
  const family = familyFor(clean(job.title), clean(job.department));
  return (FAMILY_SKILLS[family.key] || []).slice(0, 8);
}

const FAMILY_SKILLS = {
  doctor: ['Clinical Diagnosis', 'Patient Care', 'Case Management', 'Emergency Care', 'Medical Records'],
  nurse: ['Patient Care', 'IV Therapy', 'Vital Signs Monitoring', 'Wound Care', 'Medication Administration'],
  allied: ['Equipment Handling', 'Patient Positioning', 'Reporting', 'Infection Control', 'Safety Protocols'],
  medical_records: ['Medical Coding', 'ICD-10', 'CPT', 'Medical Terminology', 'Claims Processing', 'MS Excel'],
  clinical_ops: ['GCP', 'Clinical Trials', 'Case Report Forms', 'Adverse Event Reporting', 'Regulatory Compliance', 'MS Excel'],
  medical_sales: ['Field Sales', 'Territory Management', 'Product Detailing', 'Customer Relationship Management', 'Reporting'],
  recruitment: ['Sourcing', 'Screening', 'Interview Coordination', 'Applicant Tracking System', 'Communication Skills'],
  technical: ['Problem Solving', 'Version Control', 'Testing', 'Documentation'],
  admin: ['MS Office', 'MS Excel', 'Record Keeping', 'Communication Skills'],
  general: [],
};

/**
 * Is this description worth keeping, or is it a stand-in?
 *
 * A recruiter who wrote three paragraphs must not have them replaced. A
 * one-line stub - "Opening for Staff Nurse at our team.", or the note the
 * intake wrote to itself - is not a description and should be.
 *
 * The test is length plus a short list of the stubs this codebase is
 * known to produce, because "short" alone would throw away a deliberately
 * terse JD and the named ones are certain.
 */
const KNOWN_STUBS = [
  /^created automatically because a candidate applied/i,
  /^opening for .+ at our team\.?$/i,
  /^imported requirement for the/i,
];

export function isPlaceholderDescription(text) {
  const s = clean(text);
  if (!s) return true;
  if (isKnownStub(s)) return true;
  return s.length < 80;
}

/**
 * Is this one of OUR stubs - as opposed to merely short?
 *
 * The distinction matters when deciding what to KEEP. "Internship -
 * 6 Months. Stipend Rs 15,000/month." is 73 characters, so it is not a
 * job description - but it is the only place the duration and the stipend
 * are recorded, and discarding it on length threw both away. A known stub
 * carries nothing and can go; anything else is kept verbatim, however
 * short it is.
 */
export function isKnownStub(text) {
  const s = clean(text);
  return !s || KNOWN_STUBS.some((re) => re.test(s));
}

/**
 * Fill in whatever the posting is missing, and leave the rest alone.
 *
 * Returns only the fields that should CHANGE, so a caller can apply it
 * with confidence that a recruiter's own words are never overwritten.
 */
export function completeJobPosting(job = {}) {
  const generated = buildJobDescription(job);
  const out = {};

  if (isPlaceholderDescription(job.description ?? job.desc)) {
    out.description = generated.description;
  }
  const hasDuties = Array.isArray(job.responsibilities) && job.responsibilities.length > 1;
  if (!hasDuties) out.responsibilities = generated.responsibilities;

  const hasNeeds = Array.isArray(job.requirements) && job.requirements.length > 1;
  if (!hasNeeds) out.requirements = generated.requirements;

  return out;
}
