/**
 * The voice-search dictionary: the words candidates actually say, in
 * English, romanised Telugu and Hindi, and in Telugu / Devanagari script
 * (what the browser writes when the language is set to te-IN or hi-IN).
 *
 * ONE FILE ON PURPOSE. Recruiters should add the job names their
 * candidates use here - "Ask your recruiters for 50-100 common job
 * names" - without touching the parser.
 *
 * Keys are lower-case; multi-word phrases are matched before single
 * words, longest first.
 */

/** Words that carry no search meaning. Removed before anything else. */
export const FILLER = [
  // English
  'i', 'me', 'my', 'want', 'need', 'needed', 'looking', 'look', 'for', 'a', 'an', 'the', 'some', 'any',
  'job', 'jobs', 'work', 'vacancy', 'vacancies', 'opening', 'openings', 'post', 'posts', 'search', 'find',
  'show', 'get', 'please', 'pls', 'in', 'at', 'of', 'with', 'and', 'or', 'to', 'near', 'nearby', 'around',
  'is', 'are', 'there', 'available', 'required', 'requirement', 'urgent', 'hiring', 'role', 'roles',
  'position', 'positions', 'profile', 'type', 'kind', 'like', 'only', 'also', 'okay', 'ok', 'hello', 'hi',
  // Telugu (romanised)
  'kavali', 'kaavali', 'kavalenu', 'kaavaali', 'kavalandi', 'kaavalandi', 'undi', 'unda', 'unnaya', 'unnayi',
  'lo', 'loni', 'ki', 'ku', 'ni', 'nu', 'ga', 'kosam', 'udyogam', 'udyogalu', 'udyogaalu', 'pani', 'panulu',
  'dhaggara', 'daggara', 'daggarlo', 'dhaggarlo', 'chupinchu', 'chupinchandi', 'cheppandi', 'naaku', 'naku',
  'emaina', 'edaina', 'oka', 'andi', 'ra', 'kuda', 'kooda',
  // Hindi (romanised)
  'chahiye', 'chaahiye', 'chahie', 'mujhe', 'muje', 'mein', 'me', 'ka', 'ke', 'ki', 'ko', 'hai', 'hain',
  'naukri', 'naukari', 'nokri', 'kaam', 'paas', 'aas', 'wala', 'wali', 'vala', 'vali', 'koi', 'dikhao',
  'batao', 'bhi', 'sirf', 'liye', 'lie',
  // scripts
  'కావాలి', 'కావాలండి', 'లో', 'కి', 'కు', 'ఉద్యోగం', 'ఉద్యోగాలు', 'జాబ్', 'జాబ్స్', 'పని', 'దగ్గర', 'ఉంది', 'కోసం', 'నాకు',
  'चाहिए', 'में', 'मे', 'का', 'के', 'की', 'को', 'है', 'नौकरी', 'जॉब', 'काम', 'पास', 'मुझे', 'वाला', 'वाली',
];

/** "near me" etc. as phrases - removed whole. */
export const FILLER_PHRASES = ['near me', 'ke paas', 'ke pass', 'naa daggara', 'na daggara', 'mere paas',
  'is there', 'are there', 'i want', 'i need', 'looking for', 'show me', 'job kavali', 'jobs kavali'];

/** Spoken job names -> the English title the board uses. */
export const JOB_WORDS = {
  driver: ['driver', 'drivers', 'draivar', 'driving', 'car driver', 'gaadi driver', 'chauffeur', 'ड्राइवर', 'డ్రైవర్'],
  'delivery boy': ['delivery boy', 'delivery boys', 'delivery', 'delivery executive', 'dilivery boy', 'delivary boy',
    'courier boy', 'डिलीवरी बॉय', 'डिलीवरी', 'డెలివరీ బాయ్', 'డెలివరీ'],
  telecaller: ['telecaller', 'tele caller', 'telecalling', 'tele calling', 'calling job', 'call centre', 'call center',
    'bpo', 'customer care', 'customer support', 'टेलीकॉलर', 'కాల్ సెంటర్', 'టెలికాలర్'],
  nurse: ['nurse', 'nurses', 'nursing', 'staff nurse', 'nursu', 'नर्स', 'నర్స్'],
  'data entry': ['data entry', 'data entri', 'data entry operator', 'typing job', 'typist', 'computer operator',
    'डाटा एंट्री', 'डेटा एंट्री', 'డేటా ఎంట్రీ'],
  sales: ['sales', 'sales executive', 'salesman', 'sales man', 'sales girl', 'marketing', 'field sales', 'सेल्स', 'సేల్స్'],
  'security guard': ['security guard', 'security', 'watchman', 'chowkidar', 'gaurd', 'गार्ड', 'सिक्योरिटी', 'సెక్యూరిటీ'],
  electrician: ['electrician', 'electrition', 'electrican', 'bijli mistri', 'wireman', 'इलेक्ट्रीशियन', 'ఎలక్ట్రీషియన్'],
  teacher: ['teacher', 'teachers', 'tutor', 'teaching', 'adhyapakudu', 'upadhyayudu', 'teacher post', 'shikshak',
    'adhyapak', 'टीचर', 'शिक्षक', 'టీచర్'],
  accountant: ['accountant', 'accounts', 'accounting', 'tally', 'munim', 'lekhapal', 'अकाउंटेंट', 'అకౌంటెంట్'],
  cook: ['cook', 'chef', 'vantavadu', 'vanta manishi', 'rasoiya', 'bawarchi', 'khana banane', 'कुक', 'కుక్'],
  helper: ['helper', 'helpers', 'sahayakudu', 'madadgar', 'हेल्पर', 'హెల్పర్'],
  plumber: ['plumber', 'plumbing', 'प्लंबर', 'ప్లంబర్'],
  mechanic: ['mechanic', 'bike mechanic', 'car mechanic', 'mistri', 'मैकेनिक', 'మెకానిక్'],
  carpenter: ['carpenter', 'vadrangi', 'badhai', 'कारपेंटर', 'కార్పెంటర్'],
  tailor: ['tailor', 'darji', 'darzi', 'stitching', 'दर्जी', 'టైలర్'],
  receptionist: ['receptionist', 'reception', 'front office', 'रिसेप्शनिस्ट', 'రిసెప్షనిస్ట్'],
  'office boy': ['office boy', 'peon', 'attender', 'ऑफिस बॉय', 'ఆఫీస్ బాయ్'],
  housekeeping: ['housekeeping', 'house keeping', 'cleaner', 'cleaning', 'safai', 'हाउसकीपिंग', 'హౌస్ కీపింగ్'],
  warehouse: ['warehouse', 'godown', 'store keeper', 'storekeeper', 'picker', 'वेयरहाउस', 'గోడౌన్'],
  packer: ['packer', 'packing', 'पैकर', 'ప్యాకింగ్'],
  welder: ['welder', 'welding', 'वेल्डर', 'వెల్డర్'],
  beautician: ['beautician', 'beauty parlour', 'parlour', 'ब्यूटीशियन'],
  pharmacist: ['pharmacist', 'pharmacy', 'chemist', 'फार्मासिस्ट', 'ఫార్మసిస్ట్'],
  'lab technician': ['lab technician', 'lab tech', 'laboratory', 'लैब टेक्नीशियन'],
  'field executive': ['field executive', 'field work', 'field job'],
  cashier: ['cashier', 'billing', 'कैशियर', 'క్యాషియర్'],
  waiter: ['waiter', 'steward', 'वेटर', 'వెయిటర్'],
  'medical coder': ['medical coder', 'medical coding'],
  'customer service': ['customer service', 'customer executive'],
  'back office': ['back office', 'backoffice'],
  'machine operator': ['machine operator', 'operator', 'cnc operator'],
};

/** Work mode. Values are the job board's own mode strings. */
export const MODE_WORDS = {
  Remote: ['work from home', 'wfh', 'from home', 'home based', 'home job', 'online job', 'remote',
    'intlo nunchi', 'intlo nundi', 'inti nunchi', 'inti nundi', 'intinunchi', 'intlonunchi',
    'ghar se', 'ghar baithe', 'ghar baith ke', 'घर से', 'घर बैठे', 'ఇంటి నుంచి', 'ఇంట్లో నుంచి'],
  Hybrid: ['hybrid'],
  Onsite: ['work from office', 'office job', 'onsite', 'on site'],
};

/** Employment type. Values are the job board's own type strings. */
export const TYPE_WORDS = {
  'Part-time': ['part time', 'part-time', 'parttime', 'partime', 'पार्ट टाइम', 'పార్ట్ టైమ్'],
  'Full-time': ['full time', 'full-time', 'fulltime', 'फुल टाइम', 'ఫుల్ టైమ్'],
  Internship: ['internship', 'intern', 'interns', 'इंटर्नशिप', 'ఇంటర్న్‌షిప్'],
  Contract: ['contract', 'contract job', 'temporary'],
  'Walk-in': ['walk in', 'walk-in', 'walkin', 'वॉक इन'],
};

export const FRESHER_PHRASES = ['fresher', 'freshers', 'no experience', 'without experience', 'zero experience',
  '0 experience', 'experience ledu', 'experience leni', 'anubhavam ledu', 'anubhavam leni', 'anubhav nahi',
  'bina experience', 'experience nahi', 'फ्रेशर', 'अनुभव नहीं', 'ఫ్రెషర్', 'అనుభవం లేదు'];

export const POSTED_PHRASES = {
  1: ['today', 'posted today', 'ivvala', 'eeroju', 'ee roju', 'aaj', 'आज', 'ఈరోజు', 'ఇవాళ'],
  7: ['this week', 'ee vaaram', 'ee varam', 'is hafte', 'iss hafte', 'इस हफ्ते', 'ఈ వారం'],
};

/** Words that say "a salary follows / is about money". */
export const SALARY_WORDS = ['salary', 'salaries', 'pay', 'package', 'ctc', 'income', 'rupees', 'rs', 'inr', '₹',
  'jeetham', 'jitham', 'jeetam', 'vetanam', 'tankha', 'tanakha', 'tankhwah', 'pagaar', 'pagar',
  'सैलरी', 'वेतन', 'तनख्वाह', 'జీతం', 'సాలరీ'];
/** "above / at least". */
export const ABOVE_WORDS = ['paina', 'painna', 'pina', 'meeda', 'mida', 'above', 'over', 'more than', 'minimum',
  'at least', 'atleast', 'upar', 'se upar', 'se zyada', 'zyada', 'kanna ekkuva', 'ekkuva', 'ऊपर', 'से ज्यादा',
  'పైన', 'కంటే ఎక్కువ'];
export const PER_MONTH = ['per month', 'a month', 'monthly', 'month', 'nelaki', 'nelaku', 'nela', 'mahina',
  'mahine', 'mahiney', 'prati maah', 'महीना', 'महीने', 'నెలకు'];
export const PER_YEAR = ['per year', 'per annum', 'a year', 'yearly', 'annual', 'saal', 'varshaniki', 'सालाना'];
export const YEARS_WORDS = ['years', 'year', 'yrs', 'yr', 'saal', 'sal', 'samvatsaralu', 'samvatsaram',
  'varshalu', 'varsham', 'साल', 'సంవత్సరాలు'];
export const EXPERIENCE_WORDS = ['experience', 'exp', 'anubhavam', 'anubhav', 'अनुभव', 'అనుభవం'];

/** Number words -> value. Multipliers are separate. */
export const NUMBER_WORDS = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  // Telugu
  okati: 1, rendu: 2, moodu: 3, mudu: 3, naalugu: 4, nalugu: 4, aidu: 5, aydu: 5, aaru: 6, aru: 6, edu: 7,
  enimidi: 8, tommidi: 9, padi: 10, padakondu: 11, pannendu: 12, padamoodu: 13, padhnalugu: 14,
  padihenu: 15, padhihenu: 15, padhaenu: 15, padahaaru: 16, padaharu: 16, padihedu: 17, paddenimidi: 18,
  pandommidi: 19, iravai: 20, iruvai: 20, muppai: 30, nalabhai: 40, nalabai: 40, yabhai: 50, yabai: 50,
  aravai: 60, debbai: 70, enabhai: 80, tombhai: 90,
  // Hindi
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8,
  nau: 9, das: 10, gyarah: 11, barah: 12, baarah: 12, terah: 13, chaudah: 14, pandrah: 15, pandra: 15,
  solah: 16, satrah: 17, atharah: 18, unnis: 19, bees: 20, tees: 30, chalis: 40, pachas: 50, pachaas: 50,
  saath: 60, sattar: 70, assi: 80, nabbe: 90,
  // scripts
  'పదిహేను': 15, 'పది': 10, 'ఇరవై': 20, 'ముప్పై': 30, 'पंद्रह': 15, 'दस': 10, 'बीस': 20, 'तीस': 30,
};

export const MULTIPLIERS = {
  hundred: 100, sau: 100, vanda: 100, 'వంద': 100, 'सौ': 100,
  thousand: 1000, k: 1000, velu: 1000, veyyi: 1000, vela: 1000, hazaar: 1000, hazar: 1000, hajar: 1000,
  hazzar: 1000, 'వేలు': 1000, 'వేల': 1000, 'हज़ार': 1000, 'हजार': 1000,
  lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000, laksha: 100000, lakshalu: 100000,
  'लाख': 100000, 'లక్ష': 100000, 'లక్షలు': 100000,
};

/** The public search's salary options (LPA). A spoken salary maps to the largest one at or below it. */
export const SALARY_OPTIONS_LPA = [3, 5, 8, 12, 18, 25];
/** The public search's experience options. */
export const EXP_OPTIONS = ['0–1 yrs', '1–3 yrs', '2–4 yrs', '3–5 yrs', '3–6 yrs', '5–8 yrs'];
/** The public search's posted-date options. */
export const POSTED_OPTIONS = ['1', '3', '7', '15', '30'];
/** Modes and types every job form offers; the live board's own values are added at runtime. */
export const BASE_MODES = ['Onsite', 'Remote', 'Hybrid'];
export const BASE_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Walk-in'];
