/**
 * The job-search vocabulary the voice search understands, in English, with
 * what each word should also find.
 *
 * A spoken query is reduced to CONCEPTS from this list - never searched as
 * the words that were said. "కన్సల్టెంట్ టెక్నాలజీకి సంబంధించిన ఉద్యోగాలు"
 * becomes { role: consultant, industry: technology }; the ranking then
 * looks for "consultant" (and "consulting", "advisor") in the title, the
 * skills and the description of every open job.
 *
 * Each concept:
 *   id       stable key (the English word)
 *   kind     role | tech | skill | industry | qualification
 *   label    what the candidate reads ("Python Developer")
 *   terms    the concept itself - a hit on one of these is a full match
 *   expand   synonyms and the technologies it covers - a hit is a strong
 *            match (Python -> Django, Flask, FastAPI)
 *   related  neighbouring roles / technologies - used only when nothing
 *            closer exists ("related jobs")
 *   native   spellings in Telugu / Devanagari script that do NOT sound
 *            like the English word (pure Telugu / Hindi words). English
 *            loanwords written in those scripts (కన్సల్టెంట్, डेवलपर) are
 *            matched by sound and need no entry.
 *   narrow   terms matched only in the title, skills and department -
 *            never in a description, where "it" is an ordinary word.
 *
 * ONE FILE ON PURPOSE, like voice-words.js: add the words candidates use.
 * Every term is lower case; phrases are matched on word boundaries.
 */
import { JOB_WORDS } from './voice-words.js';

const C = (id, kind, label, terms, expand = [], related = [], extra = {}) => ({
  id, kind, label, terms, expand, related, native: extra.native || [], narrow: extra.narrow || [],
});

const TECH_AND_OFFICE = [
  /* ---- roles (office / IT) ---- */
  C('developer', 'role', 'Developer', ['developer', 'developers', 'programmer', 'programmers', 'coder', 'software developer'],
    ['software engineer', 'sde', 'engineer'], ['tester', 'analyst'], { native: ['ప్రోగ్రామర్', 'प्रोग्रामर'] }),
  C('engineer', 'role', 'Engineer', ['engineer', 'engineers', 'engineering'], ['developer'], ['technician']),
  C('consultant', 'role', 'Consultant', ['consultant', 'consultants', 'consulting'],
    ['advisor', 'adviser', 'technology consultant', 'it consultant', 'functional consultant', 'technical consultant'],
    ['analyst', 'business analyst'], { native: ['సలహాదారు', 'सलाहकार'] }),
  C('analyst', 'role', 'Analyst', ['analyst', 'analysts', 'business analyst', 'data analyst'], ['analytics', 'analysis'], ['consultant']),
  C('tester', 'role', 'Tester', ['tester', 'testing', 'qa', 'quality assurance', 'test engineer'],
    ['selenium', 'manual testing', 'automation testing'], ['developer']),
  C('designer', 'role', 'Designer', ['designer', 'designers'], ['ui ux', 'ux', 'ui', 'graphic design', 'figma', 'photoshop'], []),
  C('manager', 'role', 'Manager', ['manager', 'managers', 'management'], ['team lead', 'lead'], ['supervisor']),
  C('supervisor', 'role', 'Supervisor', ['supervisor', 'team leader'], ['incharge', 'in charge'], ['manager']),
  C('executive', 'role', 'Executive', ['executive', 'executives'], ['associate', 'officer'], []),
  C('hr', 'role', 'HR', ['hr', 'human resources', 'recruiter', 'recruitment', 'talent acquisition'], ['hr executive', 'hr recruiter'], [],
    { narrow: ['hr'] }),
  C('admin', 'role', 'Admin', ['admin', 'administration', 'administrator', 'office admin'], ['back office'], []),
  C('doctor', 'role', 'Doctor', ['doctor', 'physician', 'medical officer', 'mbbs'], ['cardiologist', 'surgeon'], ['nurse'],
    { native: ['వైద్యుడు', 'डॉक्टर'] }),
  C('intern', 'role', 'Intern', ['intern', 'interns', 'internship', 'trainee'], ['apprentice'], []),

  /* ---- technologies ---- */
  C('python', 'tech', 'Python', ['python'], ['django', 'flask', 'fastapi', 'pandas', 'numpy', 'python developer', 'pyspark'],
    ['data science', 'machine learning']),
  C('java', 'tech', 'Java', ['java', 'core java', 'advanced java'], ['spring', 'spring boot', 'springboot', 'j2ee', 'hibernate', 'java developer', 'jsp', 'servlets'],
    ['kotlin', 'android']),
  C('javascript', 'tech', 'JavaScript', ['javascript', 'js'], ['typescript', 'node', 'nodejs', 'react', 'angular', 'vue'], ['frontend'],
    { narrow: ['js'] }),
  C('react', 'tech', 'React', ['react', 'reactjs', 'react js'], ['redux', 'next js', 'nextjs', 'frontend react', 'react native'], ['javascript', 'frontend', 'angular']),
  C('angular', 'tech', 'Angular', ['angular', 'angularjs'], ['typescript'], ['react', 'frontend']),
  C('node', 'tech', 'Node.js', ['node', 'nodejs', 'node js'], ['express', 'nestjs'], ['javascript', 'backend']),
  C('dotnet', 'tech', '.NET', ['net', 'dotnet', 'dot net', 'asp net', 'c#'], ['csharp', 'mvc'], ['java'], { narrow: ['net'] }),
  C('php', 'tech', 'PHP', ['php'], ['laravel', 'wordpress', 'codeigniter'], ['web developer']),
  C('sql', 'tech', 'SQL', ['sql', 'database', 'mysql', 'postgresql', 'oracle'], ['plsql', 'pl sql', 'dba', 'sql server'], ['data analyst']),
  C('ai', 'tech', 'AI', ['ai', 'artificial intelligence'],
    ['machine learning', 'ml', 'deep learning', 'generative ai', 'genai', 'gen ai', 'llm', 'llms', 'nlp',
      'natural language processing', 'computer vision', 'ai engineer', 'ml engineer', 'data scientist', 'prompt engineering'],
    ['data science', 'python'], { native: ['కృత్రిమ మేధ', 'కృత్రిమ మేధస్సు', 'कृत्रिम बुद्धिमत्ता', 'ఏఐ', 'ఏ ఐ', 'एआई', 'ए आई'], narrow: ['ai', 'ml'] }),
  C('ml', 'tech', 'Machine Learning', ['machine learning', 'ml'], ['deep learning', 'ai', 'artificial intelligence', 'llm', 'nlp', 'computer vision', 'data scientist'],
    ['data science', 'python'], { native: ['ఎంఎల్', 'मशीन लर्निंग'], narrow: ['ml', 'ai'] }),
  C('data science', 'tech', 'Data Science', ['data science', 'data scientist'], ['machine learning', 'statistics', 'analytics'], ['ai', 'python', 'data analyst']),
  C('cloud', 'tech', 'Cloud', ['cloud', 'aws', 'azure', 'gcp'], ['devops', 'kubernetes', 'docker'], ['devops']),
  C('devops', 'tech', 'DevOps', ['devops', 'dev ops'], ['jenkins', 'docker', 'kubernetes', 'ci cd', 'terraform'], ['cloud']),
  C('sap', 'tech', 'SAP', ['sap'], ['sap fico', 'sap mm', 'sap sd', 'abap', 'hana'], ['consultant']),
  C('salesforce', 'tech', 'Salesforce', ['salesforce'], ['crm'], ['consultant']),
  C('android', 'tech', 'Android', ['android'], ['kotlin', 'mobile app'], ['flutter', 'java']),
  C('flutter', 'tech', 'Flutter', ['flutter'], ['dart'], ['android', 'mobile app', 'kotlin']),
  C('frontend', 'tech', 'Frontend', ['frontend', 'front end', 'ui developer'], ['react', 'angular', 'vue', 'html', 'css', 'javascript'], ['web developer']),
  C('backend', 'tech', 'Backend', ['backend', 'back end'], ['api', 'node', 'java', 'python', 'microservices'], ['full stack']),
  C('full stack', 'tech', 'Full Stack', ['full stack', 'fullstack', 'mern', 'mean'], ['frontend', 'backend', 'react', 'node'], ['web developer']),
  C('web', 'tech', 'Web', ['web developer', 'web development', 'website'], ['html', 'css', 'wordpress'], ['frontend']),
  C('excel', 'skill', 'Excel', ['excel', 'ms excel', 'advanced excel'], ['spreadsheet', 'vlookup', 'pivot'], ['data entry']),
  C('tally', 'skill', 'Tally', ['tally', 'tally erp', 'tally prime'], ['gst', 'accounting'], ['accountant']),
  C('gst', 'skill', 'GST', ['gst'], ['taxation', 'tds'], ['accountant']),
  C('autocad', 'skill', 'AutoCAD', ['autocad', 'auto cad'], ['cad', 'drafting'], ['engineer']),
  C('digital marketing', 'skill', 'Digital Marketing', ['digital marketing', 'seo', 'social media marketing'], ['sem', 'google ads', 'content marketing'], ['marketing']),
  C('networking', 'skill', 'Networking', ['networking', 'network engineer', 'ccna'], ['lan', 'firewall'], ['cloud']),
  C('cyber security', 'skill', 'Cyber Security', ['cyber security', 'cybersecurity', 'information security'], ['soc', 'vapt'], ['networking']),
  C('photoshop', 'skill', 'Photoshop', ['photoshop'], ['graphic design', 'illustrator'], ['designer']),
  C('communication', 'skill', 'Communication', ['communication', 'communication skills'], ['spoken english'], []),
  C('english', 'skill', 'English', ['english', 'spoken english'], ['communication'], [], { native: ['ఇంగ్లీష్', 'इंग्लिश', 'अंग्रेजी'] }),

  /* ---- industries / fields ---- */
  C('technology', 'industry', 'Technology', ['technology', 'technologies', 'tech', 'it', 'information technology'],
    ['software', 'it services', 'developer', 'engineer'], ['consultant'], { narrow: ['it', 'tech'] }),
  C('software', 'industry', 'Software', ['software', 'software development', 'software engineer'],
    ['developer', 'programmer', 'it', 'engineer'], ['tester'], { narrow: ['it'] }),
  C('healthcare', 'industry', 'Healthcare', ['healthcare', 'health care', 'hospital', 'medical', 'clinic'], ['nurse', 'doctor', 'pharmacy'], [],
    { native: ['ఆసుపత్రి', 'అస్పత్రి', 'अस्पताल'] }),
  C('banking', 'industry', 'Banking', ['banking', 'bank', 'finance', 'financial', 'insurance', 'nbfc'], ['loan', 'credit'], ['accountant']),
  C('bpo', 'industry', 'BPO', ['bpo', 'kpo', 'call centre', 'call center'], ['voice process', 'non voice', 'customer support'], ['telecaller']),
  C('education', 'industry', 'Education', ['education', 'school', 'college', 'edtech'], ['teacher', 'tutor'], [], { native: ['విద్య', 'शिक्षा'] }),
  C('retail', 'industry', 'Retail', ['retail', 'showroom', 'supermarket', 'mall'], ['cashier', 'sales'], []),
  C('manufacturing', 'industry', 'Manufacturing', ['manufacturing', 'factory', 'plant', 'production'], ['machine operator'], [],
    { native: ['ఫ్యాక్టరీ', 'కర్మాగారం', 'फैक्ट्री', 'कारखाना'] }),
  C('logistics', 'industry', 'Logistics', ['logistics', 'supply chain', 'transport'], ['warehouse', 'delivery', 'driver'], []),
  C('hospitality', 'industry', 'Hospitality', ['hospitality', 'hotel', 'restaurant'], ['cook', 'waiter', 'housekeeping'], []),
  C('construction', 'industry', 'Construction', ['construction', 'civil'], ['site engineer', 'supervisor'], []),
  C('pharma', 'industry', 'Pharma', ['pharma', 'pharmaceutical'], ['pharmacist', 'medical representative'], ['healthcare']),

  /* ---- qualifications ---- */
  C('btech', 'qualification', 'B.Tech', ['btech', 'b tech', 'be', 'engineering graduate'], ['mtech'], [], { narrow: ['be'] }),
  C('degree', 'qualification', 'Graduate', ['degree', 'graduate', 'graduation', 'any graduate', 'bsc', 'bcom', 'ba', 'bba'], ['post graduate'], [],
    { native: ['డిగ్రీ', 'డిగ్రీ', 'ग्रेजुएट', 'स्नातक'], narrow: ['ba'] }),
  C('mba', 'qualification', 'MBA', ['mba', 'pgdm'], [], []),
  C('mca', 'qualification', 'MCA', ['mca'], [], []),
  C('inter', 'qualification', 'Intermediate / 12th', ['intermediate', 'inter', '12th', 'twelfth', 'puc'], [], [],
    { native: ['ఇంటర్', 'ఇంటర్మీడియట్', 'बारहवीं'] }),
  C('ssc', 'qualification', '10th', ['10th', 'ssc', 'tenth', 'matriculation'], [], [], { native: ['పదో తరగతి', 'దసవీ', 'दसवीं'] }),
];

/* The everyday jobs the voice dictionary already knows (driver, nurse,
   telecaller ...) are roles too: their spoken forms stay in voice-words.js,
   their English forms become terms here. */
const ROLE_EXTRA = {
  driver: { expand: ['chauffeur', 'cab driver', 'delivery driver'], related: ['delivery boy'] },
  'delivery boy': { expand: ['delivery executive', 'delivery partner', 'rider', 'courier'], related: ['driver'] },
  telecaller: { expand: ['telesales', 'tele sales', 'call centre', 'call center', 'customer care', 'voice process', 'bpo'], related: ['customer service'] },
  nurse: { expand: ['staff nurse', 'gnm', 'anm', 'nursing'], related: ['healthcare'] },
  'data entry': { expand: ['data entry operator', 'typist', 'computer operator', 'back office'], related: ['back office'] },
  sales: { expand: ['sales executive', 'business development', 'bde', 'marketing executive', 'field sales'], related: ['marketing'] },
  accountant: { expand: ['accounts', 'accounting', 'tally', 'gst', 'bookkeeping'], related: ['cashier'] },
  'customer service': { expand: ['customer support', 'customer care', 'helpdesk'], related: ['telecaller'] },
};

function buildRoleConcepts() {
  const have = new Set(TECH_AND_OFFICE.map((c) => c.id));
  const out = [];
  for (const [title, words] of Object.entries(JOB_WORDS)) {
    if (have.has(title)) continue;
    const latin = words.filter((w) => !/[\u0900-\u097f\u0c00-\u0c7f]/.test(w)).map((w) => w.toLowerCase());
    const extra = ROLE_EXTRA[title] || {};
    const label = title.replace(/\b\w/g, (m) => m.toUpperCase());
    out.push(C(title, 'role', label, [...new Set([title, ...latin])], extra.expand || [], extra.related || []));
  }
  return out;
}

TECH_AND_OFFICE.push(C('data', 'skill', 'Data', ['data', 'data analytics', 'data engineering', 'big data'],
  ['data analyst', 'data engineer', 'data scientist', 'sql', 'etl', 'analytics', 'power bi', 'tableau'], ['data science'],
  { native: ['డేటా', 'डेटा', 'डाटा'] }));

export const CONCEPTS = [...TECH_AND_OFFICE, ...buildRoleConcepts()];
export const CONCEPT_BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]));

/*
 * Telugu / Devanagari spellings of the owner's list, written out even where
 * the sound match would find them, so they never depend on it - including
 * the two-word forms ("ఫ్రంట్ ఎండ్") and the forms without the zero-width
 * non-joiner (సాఫ్ట్వేర్) that some keyboards and recognisers produce.
 */
const NATIVE_EXTRA = {
  consultant: ['కన్సల్టెంట్', 'కన్సల్టెంట్స్', 'కన్సల్టింగ్', 'कंसल्टेंट'],
  technology: ['టెక్నాలజీ', 'టెక్', 'టెక్నాలజీస్', 'टेक्नोलॉजी'],
  frontend: ['ఫ్రంటెండ్', 'ఫ్రంట్ ఎండ్', 'ఫ్రంట్‌ఎండ్', 'फ्रंटएंड', 'फ्रंट एंड'],
  backend: ['బ్యాకెండ్', 'బ్యాక్ ఎండ్', 'బ్యాక్‌ఎండ్', 'बैकएंड', 'बैक एंड'],
  cloud: ['క్లౌడ్', 'क्लाउड'],
  software: ['సాఫ్ట్‌వేర్', 'సాఫ్ట్వేర్', 'సాఫ్ట్ వేర్', 'सॉफ्टवेयर', 'सॉफ्टवेर'],
  tester: ['టెస్టింగ్', 'టెస్టర్', 'टेस्टिंग'],
  developer: ['డెవలపర్', 'డెవలపర్స్', 'डेवलपर'],
  engineer: ['ఇంజనీర్', 'ఇంజినీర్', 'ఇంజనీర్స్', 'इंजीनियर'],
  ai: ['ఆర్టిఫిషియల్ ఇంటెలిజెన్స్', 'आर्टिफिशियल इंटेलिजेंस'],
  ml: ['మెషిన్ లెర్నింగ్', 'మెషీన్ లెర్నింగ్'],
  python: ['పైథాన్', 'पायथन'],
  java: ['జావా', 'जावा'],
  react: ['రియాక్ట్', 'रिएक्ट'],
};
for (const [id, words] of Object.entries(NATIVE_EXTRA)) {
  const c = CONCEPT_BY_ID.get(id);
  if (c) words.forEach((w) => { if (!c.native.includes(w)) c.native.push(w); });
}

/**
 * Words that carry no search meaning in a NATIVE-script sentence, beyond
 * the dictionary's FILLER: "related to", "currently", "I am", "where",
 * "any" ... Matched after the Telugu case endings are taken off.
 */
export const NATIVE_FILLER = [
  'సంబంధించిన', 'సంబంధిత', 'ప్రస్తుతం', 'ఉన్నాను', 'ఉన్నా', 'ఉంటాను', 'ఉంటున్నాను', 'ఉన్నాయి', 'ఉన్నాయా', 'ఉందా', 'ఏమైనా', 'ఏదైనా',
  'నేను', 'నా', 'మా', 'కావాలి', 'కావాలండి', 'కావాలా', 'కోసం', 'చూస్తున్నాను', 'వెతుకుతున్నాను', 'చేయాలి', 'చేస్తాను', 'పని', 'జాబ్', 'జాబ్స్',
  'ఉద్యోగం', 'ఉద్యోగాలు', 'ఉద్యోగ', 'సంబంధం', 'రంగం', 'రంగంలో', 'ఫీల్డ్', 'లో', 'కి', 'కు', 'ని', 'ను', 'తో', 'గా', 'మరియు', 'లేదా', 'ఇక్కడ',
  'అక్కడ', 'ఎక్కడ', 'దగ్గర', 'దగ్గరలో', 'అండి', 'దయచేసి', 'చెప్పండి', 'చూపించండి', 'చూపించు', 'ఏ', 'ఈ', 'ఆ', 'ఒక', 'కొన్ని',
  'संबंधित', 'सम्बंधित', 'वर्तमान', 'अभी', 'फिलहाल', 'हूं', 'हूँ', 'मैं', 'मुझे', 'मेरे', 'मेरा', 'लिए', 'चाहिए', 'नौकरी', 'नौकरियां', 'नौकरियाँ',
  'जॉब', 'जॉब्स', 'काम', 'में', 'से', 'की', 'का', 'के', 'को', 'और', 'या', 'कोई', 'कुछ', 'है', 'हैं', 'रहता', 'रहती', 'रहा', 'रही', 'क्षेत्र', 'फील्ड',
  'दिखाओ', 'बताओ', 'ढूंढ', 'ढूंढो', 'रहा हूं',
];

/** Latin words (English and romanised Telugu / Hindi) with no search meaning, beyond FILLER. */
export const LATIN_FILLER = ['related', 'relevant', 'regarding', 'about', 'currently', 'current', 'presently', 'staying', 'living',
  'located', 'based', 'from', 'unnanu', 'unna', 'unnaya', 'unnaya', 'sambandhinchina', 'prasthutham', 'abhi', 'filhal', 'hoon', 'hu',
  'field', 'sector', 'domain', 'industry', 'company', 'companies', 'good', 'best', 'new', 'latest', 'any', 'some', 'all', 'job', 'jobs',
  'vacancy', 'vacancies', 'want', 'need', 'looking', 'searching', 'kavali', 'chahiye', 'please', 'show', 'me', 'my', 'i', 'am', 'in',
  'at', 'for', 'of', 'with', 'and', 'or', 'the', 'a', 'an', 'to', 'lo', 'ki', 'ku', 'mein', 'me', 'se', 'ka', 'ke', 'ko', 'hai', 'hain'];
