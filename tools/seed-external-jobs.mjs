/**
 * Sample external postings, so the external-jobs layer has something in it.
 *
 *     node tools/seed-external-jobs.mjs             # report what it would do
 *     node tools/seed-external-jobs.mjs --confirm   # create the sources and the jobs
 *     node tools/seed-external-jobs.mjs --confirm --match   # …and score every candidate
 *     node tools/seed-external-jobs.mjs --remove    # take all of it out again
 *
 * READ THIS BEFORE YOU TRUST A ROW.
 *
 * THESE ARE NOT REAL LISTINGS. TeamLink has no API key, no partner feed
 * and no authorised access to Naukri, Shine or Indeed, and reading their
 * pages without one is not something this codebase will do. So the three
 * sources are created with job_collection_method = 'manual', which is the
 * truth - somebody types these in - and the postings below are written
 * here rather than collected from anywhere.
 *
 * WHAT IS MADE UP, AND WHAT IS NOT. The employers are invented. Every
 * name below is fictional, deliberately, so that no real hospital or
 * company has a vacancy attributed to it that it never advertised. The
 * apply links point at .invalid, a domain reserved by RFC 2606 that can
 * never resolve - a sample posting should not send a candidate to a real
 * page that has nothing to do with it.
 *
 * The ROLES, the SKILLS and the CITIES are chosen to match the candidates
 * actually on this system - clinical staff and data/software people,
 * mostly around Hyderabad - because a sample job nobody matches teaches
 * you nothing about whether matching works.
 *
 * TAKING IT OUT is one command: --remove deletes the three sources, and
 * the jobs, matches and external applications go with them by cascade.
 * Nothing in TeamLink's own tables is touched either way.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const CONFIRM = process.argv.includes('--confirm');
const REMOVE = process.argv.includes('--remove');
const MATCH = process.argv.includes('--match');

/* Named so they can be found and removed again without guessing. */
const SOURCES = [
  { key: 'naukri', name: 'Naukri' },
  { key: 'shine', name: 'Shine' },
  { key: 'indeed', name: 'Indeed' },
];

/*
 * The vacancies. `on` lists which boards carry each one - a vacancy on
 * two or three boards is the case the deduplication exists for, and
 * several below are deliberately advertised more than once, with the
 * title written differently each time, the way boards actually do it.
 */
const VACANCIES = [
  // ---- clinical ----------------------------------------------------
  { t: 'Staff Nurse - ICU', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Patient Care', 'ICU', 'Nursing', 'IV Therapy', 'Vital Signs Monitoring'],
    e: '2-5 yrs', pay: '₹3.5-5 LPA', on: ['naukri', 'shine'],
    alt: { shine: 'ICU Staff Nurse' } },
  { t: 'Staff Nurse - General Ward', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Patient Care', 'Nursing', 'GNM', 'Wound Care'], e: '1-3 yrs',
    pay: '₹2.4-3.6 LPA', on: ['naukri'] },
  { t: 'GNM Nurse', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['GNM', 'Nursing', 'Patient Care'], e: '0-2 yrs', pay: '₹2-3 LPA',
    on: ['shine', 'indeed'], alt: { indeed: 'Nurse - GNM' } },
  { t: 'Emergency Room Nurse', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Emergency', 'Patient Care', 'Nursing', 'Triage'], e: '2-6 yrs',
    pay: '₹3-5 LPA', on: ['naukri'] },
  { t: 'Duty Doctor - Casualty', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Casualty', 'Emergency', 'Patient Care', 'Clinical Diagnosis'], e: '1-4 yrs',
    pay: '₹8-14 LPA', on: ['naukri', 'indeed'], alt: { indeed: 'Casualty Duty Doctor' } },
  { t: 'Medical Officer', co: 'Cedarwood Hospital', loc: 'Bengaluru',
    s: ['MBBS', 'Patient Care', 'Clinical Diagnosis'], e: '1-5 yrs',
    pay: '₹9-15 LPA', on: ['shine'] },
  { t: 'Consultant Radiologist', co: 'Northstar Diagnostics', loc: 'Hyderabad',
    s: ['Radiology', 'CT', 'MRI', 'USG', 'Reporting'], e: '3-8 yrs',
    pay: '₹24-36 LPA', on: ['naukri', 'shine', 'indeed'],
    alt: { shine: 'Radiologist - Consultant', indeed: 'Radiologist' } },
  { t: 'Radiology Technician', co: 'Northstar Diagnostics', loc: 'Hyderabad',
    s: ['X-Ray', 'CT', 'MRI', 'Radiology Equipment Operation'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['indeed'] },
  { t: 'CT and MRI Technologist', co: 'Bluewater Imaging Centre', loc: 'Chennai',
    s: ['CT', 'MRI', 'Radiology', 'Patient Positioning'], e: '2-5 yrs',
    pay: '₹3-5 LPA', on: ['naukri'] },
  { t: 'Laboratory Technician', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['Laboratory', 'Phlebotomy', 'Sample Collection', 'Biochemistry'], e: '1-3 yrs',
    pay: '₹2-3.2 LPA', on: ['shine', 'indeed'], alt: { indeed: 'Lab Technician' } },
  { t: 'Physiotherapist', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Physiotherapy', 'Rehabilitation', 'Patient Care'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['naukri'] },
  { t: 'Hospital Pharmacist', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Pharmacy', 'Dispensing', 'Inventory'], e: '1-4 yrs',
    pay: '₹2.4-3.6 LPA', on: ['indeed'] },
  { t: 'OT Technician', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Operation Theatre', 'Sterilisation', 'Surgical Assistance'], e: '1-5 yrs',
    pay: '₹2.4-4 LPA', on: ['shine'] },
  { t: 'Dialysis Technician', co: 'Cedarwood Hospital', loc: 'Vijayawada',
    s: ['Dialysis', 'Patient Care', 'Nephrology'], e: '1-4 yrs',
    pay: '₹2.4-3.6 LPA', on: ['naukri'] },
  { t: 'Consultant - Obstetrics and Gynaecology', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Obstetrics', 'Gynaecology', 'Antenatal Care', 'Deliveries'], e: '3-8 yrs',
    pay: '₹18-30 LPA', on: ['naukri', 'shine'], alt: { shine: 'OBG Consultant' } },
  { t: 'Consultant Cardiologist', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Cardiology', 'Echocardiography', 'ECG', 'Patient Care'], e: '4-10 yrs',
    pay: '₹30-48 LPA', on: ['indeed'] },
  { t: 'Paediatrician', co: 'Greenfield Medical Centre', loc: 'Nellore',
    s: ['Paediatrics', 'Patient Care', 'Neonatal Care'], e: '2-6 yrs',
    pay: '₹15-24 LPA', on: ['shine'] },
  { t: 'Anaesthetist', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Anaesthesia', 'Operation Theatre', 'Critical Care'], e: '3-8 yrs',
    pay: '₹20-32 LPA', on: ['naukri'] },
  { t: 'Nursing Superintendent', co: 'Cedarwood Hospital', loc: 'Hyderabad',
    s: ['Nursing', 'Patient Care', 'Team Management', 'Hospital'], e: '6-12 yrs',
    pay: '₹6-9 LPA', on: ['indeed'] },
  { t: 'Home Care Nurse', co: 'CareBridge Home Health', loc: 'Hyderabad',
    s: ['Patient Care', 'Nursing', 'Elderly Care'], e: '0-3 yrs',
    pay: '₹2-3 LPA', on: ['shine'] },

  // ---- data and software ------------------------------------------
  { t: 'Python Developer', co: 'Bluepeak Technologies', loc: 'Hyderabad',
    s: ['Python', 'SQL', 'REST API', 'Git'], e: '2-4 yrs', pay: '₹6-11 LPA',
    on: ['naukri', 'indeed'], alt: { indeed: 'Developer - Python' } },
  { t: 'Java Developer', co: 'Redwood Software Labs', loc: 'Hyderabad',
    s: ['Java', 'Spring Boot', 'SQL', 'REST API'], e: '2-5 yrs',
    pay: '₹7-13 LPA', on: ['naukri'] },
  { t: 'Data Analyst', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['SQL', 'Excel', 'Power BI', 'Data Analysis'], e: '1-3 yrs',
    pay: '₹4-8 LPA', on: ['naukri', 'shine', 'indeed'],
    alt: { shine: 'Analyst - Data', indeed: 'Data Analyst (SQL, Power BI)' } },
  { t: 'Power BI Developer', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Power BI', 'SQL', 'Excel', 'DAX'], e: '2-5 yrs', pay: '₹6-12 LPA',
    on: ['shine'] },
  { t: 'SQL Developer', co: 'Bluepeak Technologies', loc: 'Bengaluru',
    s: ['SQL', 'Stored Procedures', 'Database Design'], e: '2-5 yrs',
    pay: '₹6-11 LPA', on: ['indeed'] },
  { t: 'Full Stack Developer', co: 'Redwood Software Labs', loc: 'Hyderabad',
    s: ['HTML', 'CSS', 'Javascript', 'React', 'Node'], e: '2-5 yrs',
    pay: '₹8-15 LPA', on: ['naukri'] },
  { t: 'Frontend Developer', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['HTML', 'CSS', 'Javascript', 'React'], e: '1-3 yrs',
    pay: '₹5-9 LPA', on: ['shine', 'indeed'], alt: { indeed: 'UI Developer' } },
  { t: 'Machine Learning Engineer', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Python', 'Machine Learning', 'Artificial Intelligence', 'SQL'], e: '2-5 yrs',
    pay: '₹10-18 LPA', on: ['naukri'] },
  { t: 'Data Entry Operator', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['Data Entry', 'MS Office', 'Excel'], e: '0-2 yrs', pay: '₹1.8-2.6 LPA',
    on: ['indeed'] },
  { t: 'MIS Executive', co: 'Bluepeak Technologies', loc: 'Hyderabad',
    s: ['Excel', 'SQL', 'MS Office', 'Reporting'], e: '1-4 yrs',
    pay: '₹3-5 LPA', on: ['naukri', 'shine'], alt: { shine: 'Executive - MIS' } },
  { t: 'QA Engineer', co: 'Redwood Software Labs', loc: 'Pune',
    s: ['Manual Testing', 'SQL', 'Test Cases'], e: '1-4 yrs',
    pay: '₹4-8 LPA', on: ['shine'] },
  { t: 'Business Analyst', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Excel', 'SQL', 'Requirement Gathering', 'Communication Skills'], e: '2-5 yrs',
    pay: '₹6-11 LPA', on: ['indeed'] },

  // ---- hospital support --------------------------------------------
  { t: 'Front Office Executive - Hospital', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['MS Office', 'Communication Skills', 'Patient Care'], e: '0-3 yrs',
    pay: '₹1.8-3 LPA', on: ['naukri'] },
  { t: 'Medical Billing Executive', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Medical Billing', 'Excel', 'MS Office'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['shine'] },
  { t: 'HR Recruiter - Healthcare', co: 'CareBridge Home Health', loc: 'Hyderabad',
    s: ['Recruitment', 'Screening', 'Communication Skills', 'MS Office'], e: '1-4 yrs',
    pay: '₹2.4-4.5 LPA', on: ['naukri', 'indeed'],
    alt: { indeed: 'Healthcare Recruiter' } },
  { t: 'Accounts Executive', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Accounting', 'Excel', 'Tally'], e: '1-4 yrs', pay: '₹2.4-4 LPA',
    on: ['indeed'] },

  // ---- more clinical, across the cities the candidates are in ------
  { t: 'ICU Staff Nurse', co: 'Bluewater Imaging Centre', loc: 'Bengaluru',
    s: ['ICU', 'Patient Care', 'Ventilator Management', 'Nursing'], e: '2-6 yrs',
    pay: '₹3.6-5.5 LPA', on: ['naukri', 'indeed'], alt: { indeed: 'Nurse - ICU' } },
  { t: 'Operation Theatre Nurse', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Operation Theatre', 'Sterilisation', 'Patient Care'], e: '2-5 yrs',
    pay: '₹3-4.5 LPA', on: ['shine'] },
  { t: 'Neonatal Nurse', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Neonatal Intensive Care', 'Patient Care', 'Nursing'], e: '1-4 yrs',
    pay: '₹2.8-4.2 LPA', on: ['naukri'] },
  { t: 'Dialysis Nurse', co: 'Cedarwood Hospital', loc: 'Chennai',
    s: ['Dialysis', 'Nursing', 'Patient Care'], e: '1-4 yrs',
    pay: '₹2.6-3.8 LPA', on: ['indeed'] },
  { t: 'Ward Sister', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Nursing', 'Team Management', 'Patient Care'], e: '5-10 yrs',
    pay: '₹4.8-7 LPA', on: ['shine'] },
  { t: 'Junior Resident - Medicine', co: 'Cedarwood Hospital', loc: 'Hyderabad',
    s: ['MBBS', 'Clinical Diagnosis', 'Patient Care'], e: '0-2 yrs',
    pay: '₹9-13 LPA', on: ['naukri'] },
  { t: 'Senior Resident - Surgery', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Surgery', 'Patient Care', 'Operation Theatre'], e: '2-5 yrs',
    pay: '₹14-20 LPA', on: ['shine', 'indeed'], alt: { indeed: 'Surgery Senior Resident' } },
  { t: 'Consultant Orthopaedics', co: 'Lakeview Hospitals', loc: 'Vijayawada',
    s: ['Orthopaedics', 'Surgery', 'Patient Care'], e: '4-9 yrs',
    pay: '₹24-38 LPA', on: ['naukri'] },
  { t: 'Consultant Neurologist', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Neurology', 'Clinical Diagnosis', 'Patient Care'], e: '4-10 yrs',
    pay: '₹28-44 LPA', on: ['indeed'] },
  { t: 'Consultant Dermatologist', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['Dermatology', 'Patient Care', 'Clinical Diagnosis'], e: '3-7 yrs',
    pay: '₹18-28 LPA', on: ['shine'] },
  { t: 'Consultant Psychiatrist', co: 'CareBridge Home Health', loc: 'Bengaluru',
    s: ['Psychiatry', 'Counselling', 'Patient Care'], e: '3-8 yrs',
    pay: '₹20-32 LPA', on: ['naukri'] },
  { t: 'General Physician', co: 'Greenfield Medical Centre', loc: 'Nellore',
    s: ['MBBS', 'Clinical Diagnosis', 'Patient Care'], e: '1-5 yrs',
    pay: '₹10-16 LPA', on: ['naukri', 'shine'], alt: { shine: 'Physician - General Medicine' } },
  { t: 'Emergency Medicine Officer', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Emergency', 'Casualty', 'Patient Care', 'Clinical Diagnosis'], e: '1-5 yrs',
    pay: '₹10-16 LPA', on: ['indeed'] },
  { t: 'Intensivist - Critical Care', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Critical Care', 'Ventilator Management', 'Patient Care'], e: '3-8 yrs',
    pay: '₹26-40 LPA', on: ['shine'] },

  // ---- allied and diagnostics --------------------------------------
  { t: 'X-Ray Technician', co: 'Northstar Diagnostics', loc: 'Hyderabad',
    s: ['X-Ray', 'Radiology Equipment Operation', 'Patient Positioning'], e: '0-3 yrs',
    pay: '₹1.8-3 LPA', on: ['indeed', 'shine'], alt: { shine: 'Radiographer - X-Ray' } },
  { t: 'Ultrasound Technician', co: 'Bluewater Imaging Centre', loc: 'Hyderabad',
    s: ['Ultrasound', 'Sonography', 'Reporting'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['naukri'] },
  { t: 'ECG Technician', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['ECG', 'Patient Care', 'Equipment Handling'], e: '0-3 yrs',
    pay: '₹1.8-2.8 LPA', on: ['shine'] },
  { t: 'Blood Bank Technician', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['Laboratory', 'Blood Banking', 'Sample Collection'], e: '1-4 yrs',
    pay: '₹2.2-3.4 LPA', on: ['indeed'] },
  { t: 'Phlebotomist', co: 'Northstar Diagnostics', loc: 'Hyderabad',
    s: ['Phlebotomy', 'Sample Collection', 'Patient Care'], e: '0-3 yrs',
    pay: '₹1.6-2.6 LPA', on: ['naukri', 'indeed'], alt: { indeed: 'Lab Phlebotomist' } },
  { t: 'Biomedical Engineer', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Equipment Handling', 'Preventive Maintenance', 'Safety Protocols'], e: '2-5 yrs',
    pay: '₹3-5 LPA', on: ['shine'] },
  { t: 'Clinical Nutritionist', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Dietetics', 'Patient Care', 'Counselling'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['naukri'] },
  { t: 'Speech Therapist', co: 'CareBridge Home Health', loc: 'Bengaluru',
    s: ['Speech Therapy', 'Rehabilitation', 'Patient Care'], e: '1-4 yrs',
    pay: '₹2.6-4.2 LPA', on: ['indeed'] },
  { t: 'Occupational Therapist', co: 'Cedarwood Hospital', loc: 'Chennai',
    s: ['Rehabilitation', 'Patient Care', 'Therapy Planning'], e: '1-5 yrs',
    pay: '₹2.8-4.5 LPA', on: ['shine'] },
  { t: 'Optometrist', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['Optometry', 'Vision Testing', 'Patient Care'], e: '1-4 yrs',
    pay: '₹2.4-3.8 LPA', on: ['naukri'] },

  // ---- clinical operations and records -----------------------------
  { t: 'Medical Coder', co: 'Northstar Diagnostics', loc: 'Hyderabad',
    s: ['Medical Coding', 'ICD-10', 'CPT', 'Medical Terminology'], e: '1-4 yrs',
    pay: '₹3-6 LPA', on: ['naukri', 'shine', 'indeed'],
    alt: { shine: 'Coder - Medical', indeed: 'Medical Coding Specialist' } },
  { t: 'Medical Transcriptionist', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['Transcription', 'Medical Terminology', 'MS Office'], e: '0-3 yrs',
    pay: '₹2-3.5 LPA', on: ['indeed'] },
  { t: 'Clinical Research Associate', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Clinical Trials', 'GCP', 'Case Report Forms'], e: '2-5 yrs',
    pay: '₹5-9 LPA', on: ['naukri', 'shine'], alt: { shine: 'CRA - Clinical Research' } },
  { t: 'Pharmacovigilance Associate', co: 'Cobalt Analytics', loc: 'Bengaluru',
    s: ['Adverse Event Reporting', 'Drug Safety', 'Regulatory Compliance'], e: '1-4 yrs',
    pay: '₹4-8 LPA', on: ['indeed'] },
  { t: 'Medical Billing Executive', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['Medical Billing', 'Claims Processing', 'Excel'], e: '1-4 yrs',
    pay: '₹2.4-4 LPA', on: ['naukri'] },
  { t: 'Insurance Claims Analyst', co: 'Cobalt Analytics', loc: 'Pune',
    s: ['Claims Processing', 'Medical Terminology', 'Excel'], e: '2-5 yrs',
    pay: '₹4-7 LPA', on: ['shine'] },
  { t: 'Medical Records Officer', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Medical Records', 'MS Office', 'Record Keeping'], e: '1-4 yrs',
    pay: '₹2.2-3.6 LPA', on: ['indeed'] },

  // ---- medical sales -----------------------------------------------
  { t: 'Medical Representative', co: 'CareBridge Home Health', loc: 'Hyderabad',
    s: ['Field Sales', 'Territory Management', 'Product Detailing'], e: '0-3 yrs',
    pay: '₹2.4-4.5 LPA', on: ['naukri', 'indeed'],
    alt: { indeed: 'Pharma Medical Rep' } },
  { t: 'Area Sales Manager - Pharma', co: 'CareBridge Home Health', loc: 'Bengaluru',
    s: ['Field Sales', 'Team Management', 'Territory Management'], e: '4-8 yrs',
    pay: '₹7-12 LPA', on: ['shine'] },
  { t: 'Hospital Business Development Executive', co: 'Meridian Multispecialty Hospital',
    loc: 'Hyderabad', s: ['Business Development', 'Communication Skills', 'Field Sales'],
    e: '1-4 yrs', pay: '₹3-5.5 LPA', on: ['naukri'] },

  // ---- data and software, matching the tech half of the pool -------
  { t: 'Senior Java Developer', co: 'Redwood Software Labs', loc: 'Hyderabad',
    s: ['Java', 'Spring Boot', 'Microservices', 'SQL'], e: '4-8 yrs',
    pay: '₹14-22 LPA', on: ['naukri', 'indeed'], alt: { indeed: 'Java Developer - Senior' } },
  { t: 'Backend Developer', co: 'Bluepeak Technologies', loc: 'Hyderabad',
    s: ['Python', 'REST API', 'SQL', 'Git'], e: '2-5 yrs',
    pay: '₹8-14 LPA', on: ['shine'] },
  { t: 'React Developer', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['React', 'Javascript', 'HTML', 'CSS'], e: '2-5 yrs',
    pay: '₹7-13 LPA', on: ['naukri'] },
  { t: 'Node.js Developer', co: 'Redwood Software Labs', loc: 'Bengaluru',
    s: ['Node', 'Javascript', 'REST API', 'SQL'], e: '2-5 yrs',
    pay: '₹8-14 LPA', on: ['indeed'] },
  { t: 'Data Engineer', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Python', 'SQL', 'ETL', 'Data Warehousing'], e: '2-6 yrs',
    pay: '₹9-16 LPA', on: ['shine', 'naukri'], alt: { naukri: 'Engineer - Data' } },
  { t: 'Data Scientist', co: 'Cobalt Analytics', loc: 'Hyderabad',
    s: ['Python', 'Machine Learning', 'SQL', 'Statistics'], e: '2-6 yrs',
    pay: '₹12-20 LPA', on: ['indeed'] },
  { t: 'Automation Test Engineer', co: 'Redwood Software Labs', loc: 'Pune',
    s: ['Selenium', 'Java', 'Test Cases'], e: '2-5 yrs',
    pay: '₹6-11 LPA', on: ['naukri'] },
  { t: 'DevOps Engineer', co: 'Bluepeak Technologies', loc: 'Hyderabad',
    s: ['Docker', 'Kubernetes', 'CI/CD', 'Linux'], e: '3-6 yrs',
    pay: '₹12-20 LPA', on: ['shine'] },
  { t: 'Database Administrator', co: 'Bluepeak Technologies', loc: 'Hyderabad',
    s: ['SQL', 'PostgreSQL', 'Backup and Recovery'], e: '3-7 yrs',
    pay: '₹8-15 LPA', on: ['indeed'] },
  { t: 'Support Engineer', co: 'Amberline Digital', loc: 'Hyderabad',
    s: ['Troubleshooting', 'SQL', 'Communication Skills'], e: '1-3 yrs',
    pay: '₹3-6 LPA', on: ['naukri'] },
  { t: 'Technical Writer', co: 'Redwood Software Labs', loc: 'Bengaluru',
    s: ['Documentation', 'MS Office', 'Communication Skills'], e: '1-4 yrs',
    pay: '₹4-8 LPA', on: ['shine'] },

  // ---- office and support ------------------------------------------
  { t: 'Hospital Administrator', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Hospital', 'Team Management', 'MS Office'], e: '5-10 yrs',
    pay: '₹6-10 LPA', on: ['naukri'] },
  { t: 'Patient Care Coordinator', co: 'Greenfield Medical Centre', loc: 'Hyderabad',
    s: ['Patient Care', 'Communication Skills', 'MS Office'], e: '0-3 yrs',
    pay: '₹2-3.4 LPA', on: ['indeed', 'shine'], alt: { shine: 'Coordinator - Patient Care' } },
  { t: 'Telecaller - Healthcare', co: 'CareBridge Home Health', loc: 'Hyderabad',
    s: ['Communication Skills', 'Data Entry', 'MS Office'], e: '0-2 yrs',
    pay: '₹1.8-2.6 LPA', on: ['naukri'] },
  { t: 'Admin Executive', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['MS Office', 'Excel', 'Record Keeping'], e: '1-4 yrs',
    pay: '₹2.2-3.5 LPA', on: ['shine'] },
  { t: 'Payroll Executive', co: 'Meridian Multispecialty Hospital', loc: 'Hyderabad',
    s: ['Accounting', 'Excel', 'Payroll'], e: '2-5 yrs',
    pay: '₹3-5 LPA', on: ['indeed'] },
  { t: 'Store Executive - Hospital', co: 'Cedarwood Hospital', loc: 'Vijayawada',
    s: ['Inventory', 'MS Office', 'Record Keeping'], e: '1-4 yrs',
    pay: '₹2-3.2 LPA', on: ['naukri'] },
  { t: 'Quality Executive - NABH', co: 'Sunrise Health City', loc: 'Hyderabad',
    s: ['Quality Assurance', 'Documentation', 'Audit'], e: '2-6 yrs',
    pay: '₹3.5-6 LPA', on: ['shine'] },
  { t: 'Housekeeping Supervisor', co: 'Lakeview Hospitals', loc: 'Hyderabad',
    s: ['Team Management', 'Infection Control'], e: '2-6 yrs',
    pay: '₹2-3.2 LPA', on: ['indeed'] },
];

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) fail.push(what);
};

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const M = { delete: 'del' };
const api = async (m0, p, b) => {
  const m = M[m0] || m0;
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

try {
  await api('post', '/auth/login', {
    email: process.env.TL_ADMIN || 'admin@teamlink.com',
    password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026',
    role: 'admin',
  });

  /* Is the feature even on? Without it the routes are not mounted. */
  try { await api('get', '/external/config'); } catch {
    console.log('\nEXTERNAL_JOBS_ENABLED is not true, so /api/external/* does not exist.');
    console.log('Set it in .env and restart, then run this again.\n');
    process.exit(1);
  }

  const existing = (await api('get', '/external/sources')).sources || [];

  /* ---- remove ----------------------------------------------------- */
  if (REMOVE) {
    const mine = existing.filter((s) => SOURCES.some((k) => k.name === s.name));
    if (!mine.length) { console.log('None of these sources exist.'); process.exit(0); }
    for (const s of mine) {
      const gone = await api('delete', `/external/sources/${encodeURIComponent(s.id)}`);
      console.log(`removed ${s.name}: ${gone.removedJobs} job(s), `
        + `${gone.removedMatches} match(es), ${gone.removedApplications} application(s)`);
    }
    console.log('\nTeamLink’s own jobs, candidates and applications are untouched.');
    process.exit(0);
  }

  /* ---- what would happen ------------------------------------------ */
  const rows = [];
  for (const v of VACANCIES) {
    for (const on of v.on) {
      rows.push({ board: on, title: (v.alt && v.alt[on]) || v.t, v });
    }
  }
  const dupes = VACANCIES.filter((v) => v.on.length > 1).length;

  console.log(`${SOURCES.length} sources, ${VACANCIES.length} vacancies, ${rows.length} postings`);
  console.log(`   ${dupes} vacancy(ies) appear on more than one board — the dedup case\n`);

  if (!CONFIRM) {
    for (const s of SOURCES) {
      const n = rows.filter((r) => r.board === s.key).length;
      console.log(`   ${s.name.padEnd(8)} ${n} posting(s)`);
    }
    console.log('\nThese are SAMPLE postings with invented employers and .invalid apply links.');
    console.log('TeamLink has no authorised access to Naukri, Shine or Indeed, so nothing');
    console.log('here was collected from them.\n');
    console.log('Run again with --confirm to create them, then --match to score candidates.');
    console.log('Run with --remove to take all of it out again.');
    process.exit(0);
  }

  /* ---- sources ---------------------------------------------------- */
  console.log('Sources\n');
  const idOf = {};
  for (const s of SOURCES) {
    const already = existing.find((x) => x.name === s.name);
    const saved = (await api('post', '/external/sources', {
      ...(already ? { id: already.id } : {}),
      name: s.name,
      sourceType: 'job_board',
      /* MANUAL, because that is the truth: there is no key and no feed,
         so a human enters these. Setting it to 'feed' would claim an
         integration that does not exist. */
      collectionMethod: 'manual',
      applicationMethod: 'redirect',
      autoApplySupported: false,
      active: true,
    })).source;
    idOf[s.key] = saved.id;
    check(!!saved.id, `  ${s.name} (${saved.collectionMethod}, apply by ${saved.applicationMethod})`);
  }

  /* ---- postings ---------------------------------------------------- */
  console.log('\nPostings\n');
  let posted = 0;
  for (const s of SOURCES) {
    const forBoard = rows.filter((r) => r.board === s.key).map(({ title, v }) => ({
      externalJobId: `${s.key}-${slug(title)}-${slug(v.co)}`,
      title,
      company: v.co,
      location: v.loc,
      skills: v.s,
      experience: v.e,
      salary: v.pay,
      employmentType: 'Full-time',
      applicationUrl: `https://sample.invalid/${s.key}/${slug(title)}`,
      description: `${title} at ${v.co}, ${v.loc}. `
        + `Looking for ${v.e} of experience in ${v.s.slice(0, 3).join(', ')}. `
        + `SAMPLE POSTING — created by tools/seed-external-jobs.mjs, not collected from ${s.name}.`,
      postedAt: new Date(Date.now() - Math.floor(Math.random() * 14) * 864e5).toISOString(),
    }));

    const out = await api('post', '/external/jobs', { sourceId: idOf[s.key], jobs: forBoard });
    posted += out.saved;
    check(out.saved === forBoard.length,
      `  ${s.name.padEnd(8)} ${out.saved} of ${forBoard.length} stored`
      + (out.linked ? `, ${out.linked} linked as duplicates` : ''));
  }

  const summary = await api('get', '/external/summary');
  console.log(`\n${summary.openJobs} external job(s) on ${summary.activeSources} active source(s)`);
  console.log(`${summary.duplicates} posting(s) recognised as the same vacancy on another board`);

  /* ---- matching ---------------------------------------------------- */
  if (MATCH) {
    console.log('\nScoring candidates (reads their profile, changes nothing on it)\n');
    const cands = (await api('get', '/candidates?limit=500')).candidates || [];
    const t0 = Date.now();
    let scored = 0;
    let best = null;
    for (const c of cands) {
      try {
        const out = await api('post', '/external/match', { candidateId: c.id });
        scored++;
        if (out.best && (!best || out.best.percentage > best.percentage)) {
          best = { ...out.best, who: c.name };
        }
      } catch { /* a candidate with nothing to match on */ }
      if (scored % 25 === 0) process.stdout.write(`   ${scored}/${cands.length}\r`);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`   ${scored} candidate(s) scored in ${secs}s          `);
    if (best) {
      console.log(`   best match: ${best.who} — ${best.percentage}% for `
        + `${best.title}${best.company ? ' at ' + best.company : ''}`);
    }
    const after = await api('get', '/external/summary');
    console.log(`   ${after.matches} match(es) stored`);
  }

  console.log('\nThese are SAMPLE postings. The employers are invented and the apply');
  console.log('links point at .invalid, which cannot resolve. Remove all of it with:');
  console.log('   node tools/seed-external-jobs.mjs --remove');
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  await browser.close();
  if (fail.length) { console.log(`\n${fail.length} failed`); process.exit(1); }
}
