/**
 * Basic mode in Telugu and Hindi.
 *
 * The rules engine (career-assistant.js rulesReply, engine "rules") used
 * to answer in English only. It now answers in the language AND SCRIPT
 * the candidate wrote in - the same rule the system prompt gives the
 * model (spec Part B "Language and style"):
 *
 *   te        Telugu script (తెలుగు)            -> Telugu script
 *   hi        Devanagari (हिन्दी)                 -> Devanagari
 *   te-Latn   romanized Telugu ("naaku job kavali")  -> romanized Telugu
 *   hi-Latn   romanized Hindi ("mujhe naukri chahiye") -> romanized Hindi
 *   en        English
 *
 * When a message does not show its language (one word like "jobs", a
 * job title, an emoji), the candidate's stored preferred language (0102)
 * decides; a preference of te / hi answers in that script.
 *
 * Only the WORDS around the data are translated. Job titles, skill names,
 * scores and pay figures come from the database exactly as before, so a
 * Telugu answer is answered from the same real data as an English one.
 */
import { roundLabel } from '../interview/prep-kit-i18n.js';

export const REPLY_LANGS = ['en', 'te', 'hi', 'te-Latn', 'hi-Latn'];

/* ------------------------------------------------------------------ *
 * detection
 * ------------------------------------------------------------------ */

const TELUGU = /[ఀ-౿]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;

/* Words that are distinctive in romanized Telugu / Hindi and are not
   ordinary English words ("main", "to", "me", "hi", "ki" are left out on
   purpose - they would turn English into Hindi). */
const TE_WORDS = new Set(`naaku naku nenu meeru mee maa naa kavali kaavali kavalandi ela elaa enti emiti emi entha enta
  ekkada eppudu cheyali cheyyali cheyyala cheyala cheyochha cheyocha cheyandi cheyyandi chesi chesanu chestanu
  unnaya unnayi unnai unda undi ledu levu leda avvali avvadaniki avutundi avthundi gurinchi kosam udyogam udyogalu
  udyogam jeetham jitham nerchukovali nerchukovalante nerchukovaali sahayam cheppandi cheppu chepandi chudandi
  chupinchu chupinchandi ivvandi baagundi bagundi telusukovali saripotunda saripothunda emaina evaina inka
  dorukutunda dorkutunda raavali ravali`.split(/\s+/).filter(Boolean));
const HI_WORDS = new Set(`mujhe mujhko mera meri mere chahiye chaahiye chahie kaise kya kyaa kaun kaunsi kaunsa konsi konsa
  kitni kitna kitne naukri naukari hai hain hoon hu karu karun karoon karna karni karein kare batao bataiye bataye
  bataen seekhni seekhna seekhu seekhun sakta sakti sakte liye taiyari tayari taiyaari nahi nahin aap aapka aapki
  aapke kahan kab dikhao dikhaiye dijiye sudhare sudharu sudharun sudhaarein paisa paise tankhwah milegi milega
  achha accha chaiye kijiye`.split(/\s+/).filter(Boolean));
/* Plain English, to tell "show me jobs" (English) from "jobs" (unknown). */
const EN_WORDS = new Set(`i me my mine what which how why when where should could would can do does did is are am was
  the a an to for of about with and or please show find give tell help want need any some you your there this that
  get got have has improve`.split(/\s+/).filter(Boolean));

/**
 * The language and script to answer in.
 * @param text       the candidate's message
 * @param preferred  candidates.preferred_language ('en' | 'te' | 'hi')
 */
export function detectLanguage(text, preferred = 'en') {
  const s = String(text || '');
  const te = (s.match(TELUGU) || []).length;
  const hi = (s.match(DEVANAGARI) || []).length;
  if (te || hi) return te >= hi ? 'te' : 'hi';

  const words = s.toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  let rte = 0; let rhi = 0; let ren = 0;
  for (const w of words) {
    if (TE_WORDS.has(w)) rte += 1;
    if (HI_WORDS.has(w)) rhi += 1;
    if (EN_WORDS.has(w)) ren += 1;
  }
  if (rte || rhi) {
    if (rte > rhi) return 'te-Latn';
    if (rhi > rte) return 'hi-Latn';
    return preferred === 'hi' ? 'hi-Latn' : 'te-Latn';
  }
  if (ren) return 'en';
  return ['te', 'hi'].includes(preferred) ? preferred : 'en';
}

/* ------------------------------------------------------------------ *
 * intents: English, romanized and both scripts
 *
 * The same order as the prototype's assistantReply(); each test runs on
 * the lower-cased message whatever its language, because romanized
 * Telugu and Hindi borrow the English words ("job", "resume").
 * ------------------------------------------------------------------ */

export const INTENTS = [
  ['fee', /\b(fee|fees|deposit|registration (charge|amount)|pay (money|to get)|money for (a|the) job)\b|dabbu(lu)? katt|paise? (dena|dene|jama)|ఫీజు|డబ్బు(లు)? కట్ట|డిపాజిట్|फीस|फ़ीस|पैसे (देने|जमा)|डिपॉज़िट/],
  ['profile', /improve|profile|resume|biodata|sudhar|merugu|ప్రొఫైల్|రెజ్యూమ|బయోడేటా|మెరుగు|प्रोफ़ाइल|प्रोफाइल|रिज़्यूमे|रिज्यूमे|बायोडाटा|सुधार/],
  ['jobs', /job|match|recommend|udyog|naukri|naukari|ఉద్యోగ|జాబ్|नौकरी|नौकरियाँ|जॉब/],
  ['apply', /should i apply|ready|apply|అప్లై|దరఖాస్తు|अप्लाई|आवेदन/],
  ['career', /career|path|future|next role|కెరీర్|భవిష్యత్|करियर|कैरियर|भविष्य/],
  ['interview', /interview|prep|taiyari|tayari|ఇంటర్వ్యూ|ఇంటర్వూ|इंटरव्यू|साक्षात्कार/],
  ['salary', /salary|pay|ctc|jeetham|jitham|tankhwah|vetan|జీతం|శాలరీ|సాలరీ|सैलरी|वेतन|तनख्वाह|तनख़्वाह/],
  ['skills', /skill|gap|learn|nerchuk|seekh|sikh|నైపుణ్య|స్కిల్|నేర్చుకో|स्किल|कौशल|सीख/],
];

export function intentOf(text) {
  const t = String(text || '').toLowerCase();
  for (const [name, re] of INTENTS) if (re.test(t)) return name;
  return 'help';
}

/* ------------------------------------------------------------------ *
 * the words around the data
 * ------------------------------------------------------------------ */

const FIELD = {
  te: {
    'current job title': 'ప్రస్తుత ఉద్యోగ హోదా', skills: 'స్కిల్స్ (నైపుణ్యాలు)', education: 'విద్యార్హత',
    'years of experience': 'అనుభవం (సంవత్సరాలు)', 'current location': 'ప్రస్తుతం ఉంటున్న ప్రాంతం',
    'preferred job location': 'ఉద్యోగం కోరుకునే ప్రాంతం', 'expected salary': 'ఆశిస్తున్న జీతం',
    resume: 'రెజ్యూమ్', 'profile summary': 'ప్రొఫైల్ సారాంశం',
  },
  hi: {
    'current job title': 'मौजूदा जॉब टाइटल', skills: 'स्किल्स', education: 'शिक्षा',
    'years of experience': 'अनुभव (साल)', 'current location': 'अभी कहाँ रहते हैं',
    'preferred job location': 'पसंदीदा जॉब लोकेशन', 'expected salary': 'अपेक्षित सैलरी',
    resume: 'रिज़्यूमे', 'profile summary': 'प्रोफ़ाइल सारांश',
  },
};
const field = (lang, f) => (FIELD[lang] && FIELD[lang][f]) || f;
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Every Basic-mode sentence, per language. Functions take the real data;
 * `en` is the original wording, unchanged.
 */
export const T = {
  en: {
    fee: () => 'TeamLink does not charge candidates for jobs. If anyone asks you to pay a fee for a job or an interview, '
      + 'please do not pay - it is a common job fraud.',
    profileComplete: (resume) => `Your profile has all the main details${resume ? ' and a resume on file' : ''}. `
      + 'Keep your skills current and add recent projects - see [Profile](#/candidate/profile).',
    profileMissing: (fields, resume) => `To strengthen your profile, add: **${fields.join(', ')}**.`
      + (resume ? '' : ' Uploading a resume fills most of it in for you - see [Resume](#/candidate/resume).')
      + ' Update it on [Profile](#/candidate/profile).',
    noJobs: () => 'I don\'t see an open job to recommend right now - check [Search Jobs](#/candidate/search) again soon.',
    jobsHead: () => 'Your best matches right now:',
    jobLine: (link, loc, score) => `- ${link} - ${loc || 'location not stated'}, **${score}% match**`,
    jobsTail: () => 'Open a job to see why it fits and to apply.',
    noJobToEvaluate: () => 'I don\'t see an open job to evaluate right now.',
    verdict: (s) => (s >= 70 ? 'Yes - you are a strong fit, apply.'
      : s >= 50 ? 'Worth applying - you meet much of what it asks for.'
        : 'Build a few skills first - you meet only part of what it asks for.'),
    applyLine: (link, s, verdict) => `For ${link} (**${s}% match**): ${verdict}`,
    applyMissing: (skills) => ` Skills it asks for that you don't list: ${skills.join(', ')}.`,
    careerRole: (role) => `You are heading towards **${role}** roles. `,
    careerNoRole: () => 'Add your preferred role to your profile so I can suggest a path. ',
    careerGaps: (list) => `The skills the jobs closest to you ask for most are: ${list.join(', ')}. Learning these is the most direct next step.`,
    careerTail: () => ' See the AI Career Hub for a fuller plan.',
    noInterview: () => 'You don\'t have an upcoming interview yet. Once one is booked, I can help you prepare - see [Interviews](#/candidate/interviews).',
    interview: (iv) => `Your next interview: **${iv.type}** for ${iv.title || 'your application'}`
      + `${iv.date ? ` on ${iv.date}` : ''}${iv.time ? ` at ${iv.time}` : ''}.\n`
      + '- Practise a two-minute introduction about your experience and skills.\n'
      + '- Prepare one real example of a problem you solved.\n'
      + '- Read the job description again and match your skills to it.',
    salaryNoExpected: () => 'Add your expected salary to [Profile](#/candidate/profile) and I can compare it with open jobs.',
    salaryNoJob: () => 'I don\'t see an open job to compare your expected salary with right now.',
    salaryNoRange: (link, x) => `${link} does not state a pay range, so I can't compare it with your expected ₹${x} LPA.`,
    salaryCompare: (x, link, pay, fits) => `Your expected salary is ₹${x} LPA. ${link} pays ${pay} - `
      + (fits ? 'your expectation is within its range.' : 'your expectation is above its range.'),
    skillItem: (s, n) => `**${s}** (${n} job${n === 1 ? '' : 's'})`,
    skillsGaps: (items) => `Across the jobs closest to your profile, the skills you don't list yet are: ${items.join(', ')}.`,
    skillsNone: () => 'You already list the skills the jobs closest to your profile ask for.',
    help: (first) => `Hi${first ? ` ${first}` : ''}! I can help with: improving your profile, finding matching jobs, whether you should apply somewhere, `
      + 'your career path, interview prep, salary fit, or skill gaps. Try asking about one of those!',
  },

  te: {
    fee: () => 'TeamLink ఉద్యోగాల కోసం అభ్యర్థుల నుంచి ఎలాంటి డబ్బు తీసుకోదు. ఉద్యోగం లేదా ఇంటర్వ్యూ కోసం ఎవరైనా ఫీజు కట్టమని అడిగితే '
      + 'దయచేసి కట్టకండి - అది తరచుగా జరిగే ఉద్యోగ మోసం.',
    profileComplete: (resume) => `మీ ప్రొఫైల్‌లో ముఖ్యమైన వివరాలన్నీ ఉన్నాయి${resume ? ', రెజ్యూమ్ కూడా ఉంది' : ''}. `
      + 'మీ స్కిల్స్‌ను ఎప్పటికప్పుడు అప్‌డేట్ చేస్తూ, ఇటీవలి ప్రాజెక్టులను చేర్చండి - [ప్రొఫైల్](#/candidate/profile) చూడండి.',
    profileMissing: (fields, resume) => `మీ ప్రొఫైల్‌ను బలంగా చేయడానికి ఇవి చేర్చండి: **${fields.join(', ')}**.`
      + (resume ? '' : ' రెజ్యూమ్ అప్‌లోడ్ చేస్తే చాలా వివరాలు వాటంతట అవే నిండిపోతాయి - [రెజ్యూమ్](#/candidate/resume) చూడండి.')
      + ' [ప్రొఫైల్](#/candidate/profile)లో అప్‌డేట్ చేయండి.',
    noJobs: () => 'ప్రస్తుతం మీకు సూచించడానికి ఓపెన్ ఉద్యోగం ఏదీ కనిపించడం లేదు - కొంచెం తర్వాత మళ్ళీ [ఉద్యోగాలు వెతకండి](#/candidate/search).',
    jobsHead: () => 'ప్రస్తుతం మీకు బాగా సరిపోయే ఉద్యోగాలు:',
    jobLine: (link, loc, score) => `- ${link} - ${loc || 'ప్రాంతం పేర్కొనలేదు'}, **${score}% మ్యాచ్**`,
    jobsTail: () => 'అది మీకు ఎందుకు సరిపోతుందో చూడటానికి, అప్లై చేయడానికి ఆ ఉద్యోగాన్ని తెరవండి.',
    noJobToEvaluate: () => 'ప్రస్తుతం పరిశీలించడానికి ఓపెన్ ఉద్యోగం ఏదీ కనిపించడం లేదు.',
    verdict: (s) => (s >= 70 ? 'అవును - మీరు దీనికి బాగా సరిపోతారు, అప్లై చేయండి.'
      : s >= 50 ? 'అప్లై చేయడం మంచిదే - ఇది అడిగే వాటిలో చాలావరకు మీ దగ్గర ఉన్నాయి.'
        : 'ముందు కొన్ని స్కిల్స్ నేర్చుకోండి - ఇది అడిగే వాటిలో కొంత భాగమే ఇప్పుడు మీ దగ్గర ఉంది.'),
    applyLine: (link, s, verdict) => `${link} (**${s}% మ్యాచ్**): ${verdict}`,
    applyMissing: (skills) => ` ఇది అడుగుతున్న, మీ ప్రొఫైల్‌లో లేని స్కిల్స్: ${skills.join(', ')}.`,
    careerRole: (role) => `మీరు **${role}** ఉద్యోగాల దిశగా వెళ్తున్నారు. `,
    careerNoRole: () => 'మీకు సరైన దారి సూచించడానికి, మీరు కోరుకునే ఉద్యోగ హోదాను ప్రొఫైల్‌లో చేర్చండి. ',
    careerGaps: (list) => `మీకు దగ్గరగా ఉన్న ఉద్యోగాలు ఎక్కువగా అడిగే స్కిల్స్: ${list.join(', ')}. వీటిని నేర్చుకోవడమే మీ తదుపరి సరైన అడుగు.`,
    careerTail: () => ' పూర్తి ప్లాన్ కోసం AI Career Hub చూడండి.',
    noInterview: () => 'మీకు ఇంకా ఏ ఇంటర్వ్యూ షెడ్యూల్ కాలేదు. ఒకటి బుక్ అయిన వెంటనే, సిద్ధం కావడంలో సహాయం చేస్తాను - [ఇంటర్వ్యూలు](#/candidate/interviews) చూడండి.',
    interview: (iv) => `మీ తదుపరి ఇంటర్వ్యూ: ${iv.title || 'మీ దరఖాస్తు'} కోసం **${roundLabel(iv.type, 'te')}**`
      + `${iv.date ? `, తేదీ ${iv.date}` : ''}${iv.time ? `, సమయం ${iv.time}` : ''}.\n`
      + '- మీ అనుభవం, స్కిల్స్ గురించి రెండు నిమిషాల పరిచయాన్ని ప్రాక్టీస్ చేయండి.\n'
      + '- మీరు పరిష్కరించిన ఒక నిజమైన సమస్యను ఉదాహరణగా సిద్ధం చేసుకోండి.\n'
      + '- ఉద్యోగ వివరణను మళ్ళీ చదివి, మీ స్కిల్స్‌ను దానితో పోల్చుకోండి.',
    salaryNoExpected: () => 'మీరు ఆశిస్తున్న జీతాన్ని [ప్రొఫైల్](#/candidate/profile)లో చేర్చండి, అప్పుడు ఓపెన్ ఉద్యోగాలతో పోల్చి చెబుతాను.',
    salaryNoJob: () => 'మీరు ఆశిస్తున్న జీతంతో పోల్చడానికి ప్రస్తుతం ఓపెన్ ఉద్యోగం ఏదీ కనిపించడం లేదు.',
    salaryNoRange: (link, x) => `${link}లో జీతం పరిధి ఇవ్వలేదు, కాబట్టి మీరు ఆశిస్తున్న ₹${x} LPAతో పోల్చలేను.`,
    salaryCompare: (x, link, pay, fits) => `మీరు ఆశిస్తున్న జీతం ₹${x} LPA. ${link} ఇచ్చే జీతం ${pay} - `
      + (fits ? 'మీ అంచనా ఆ పరిధిలోనే ఉంది.' : 'మీ అంచనా ఆ పరిధి కంటే ఎక్కువగా ఉంది.'),
    skillItem: (s, n) => `**${s}** (${n} ${plural(n, 'ఉద్యోగం', 'ఉద్యోగాలు')})`,
    skillsGaps: (items) => `మీ ప్రొఫైల్‌కు దగ్గరగా ఉన్న ఉద్యోగాలు అడుగుతున్న, మీరు ఇంకా చేర్చని స్కిల్స్: ${items.join(', ')}.`,
    skillsNone: () => 'మీ ప్రొఫైల్‌కు దగ్గరగా ఉన్న ఉద్యోగాలు అడిగే స్కిల్స్ అన్నీ మీ ప్రొఫైల్‌లో ఇప్పటికే ఉన్నాయి.',
    help: (first) => `నమస్కారం${first ? ` ${first}` : ''}! నేను వీటిలో సహాయం చేయగలను: మీ ప్రొఫైల్‌ను మెరుగుపరచడం, మీకు సరిపోయే ఉద్యోగాలు, `
      + 'ఒక ఉద్యోగానికి అప్లై చేయాలా వద్దా, మీ కెరీర్ దారి, ఇంటర్వ్యూ ప్రిపరేషన్, జీతం, నేర్చుకోవాల్సిన స్కిల్స్. వీటిలో ఏదైనా అడగండి!',
  },

  'te-Latn': {
    fee: () => 'TeamLink job kosam candidates nunchi okka rupayi kuda teesukodu. Job leda interview kosam evaraina fees kattamani adigithe '
      + 'dayachesi kattakandi - adi chaala common ga jarige job mosam.',
    profileComplete: (resume) => `Mee profile lo mukhyamaina details anni unnayi${resume ? ', resume kuda undi' : ''}. `
      + 'Mee skills ni eppatikappudu update chestu, recent projects add cheyandi - [Profile](#/candidate/profile) chudandi.',
    profileMissing: (fields, resume) => `Mee profile ni strong cheyyadaniki ivi add cheyandi: **${fields.join(', ')}**.`
      + (resume ? '' : ' Resume upload chesthe chaala details automatic ga fill avuthayi - [Resume](#/candidate/resume) chudandi.')
      + ' [Profile](#/candidate/profile) lo update cheyandi.',
    noJobs: () => 'Ippudu meeku suggest cheyyadaniki open job edi kanipinchatledu - konchem tarvata malli [Search Jobs](#/candidate/search) chudandi.',
    jobsHead: () => 'Ippudu meeku baaga saripoye jobs:',
    jobLine: (link, loc, score) => `- ${link} - ${loc || 'location ivvaledu'}, **${score}% match**`,
    jobsTail: () => 'Adi meeku enduku saripotundo chudataniki, apply cheyyadaniki aa job ni open cheyandi.',
    noJobToEvaluate: () => 'Ippudu chudadaniki open job edi kanipinchatledu.',
    verdict: (s) => (s >= 70 ? 'Avunu - meeru deeniki baaga saripotaru, apply cheyandi.'
      : s >= 50 ? 'Apply cheyyadam manchide - idi adige vaatilo chaalavaraku mee daggara unnayi.'
        : 'Mundu konni skills nerchukondi - idi adige vaatilo konta bhaagame ippudu mee daggara undi.'),
    applyLine: (link, s, verdict) => `${link} (**${s}% match**): ${verdict}`,
    applyMissing: (skills) => ` Idi adugutunna, mee profile lo leni skills: ${skills.join(', ')}.`,
    careerRole: (role) => `Meeru **${role}** jobs vaipu veltunnaru. `,
    careerNoRole: () => 'Meeku correct path suggest cheyyadaniki, meeru korukune role ni profile lo add cheyandi. ',
    careerGaps: (list) => `Meeku daggaraga unna jobs ekkuvaga adige skills: ${list.join(', ')}. Veetini nerchukovadame mee next step.`,
    careerTail: () => ' Full plan kosam AI Career Hub chudandi.',
    noInterview: () => 'Meeku inka e interview schedule kaledu. Okati book ayina ventane, prepare avvadamlo help chestanu - [Interviews](#/candidate/interviews) chudandi.',
    interview: (iv) => `Mee next interview: ${iv.title || 'mee application'} kosam **${roundLabel(iv.type, 'en')}**`
      + `${iv.date ? `, date ${iv.date}` : ''}${iv.time ? `, time ${iv.time}` : ''}.\n`
      + '- Mee experience, skills gurinchi rendu nimishala introduction practice cheyandi.\n'
      + '- Meeru solve chesina oka real problem ni example ga ready chesukondi.\n'
      + '- Job description malli chadivi, mee skills ni daanitho match chesukondi.',
    salaryNoExpected: () => 'Meeru expect chestunna salary ni [Profile](#/candidate/profile) lo add cheyandi, appudu open jobs tho compare chesi cheptanu.',
    salaryNoJob: () => 'Mee expected salary tho compare cheyyadaniki ippudu open job edi kanipinchatledu.',
    salaryNoRange: (link, x) => `${link} lo salary range ivvaledu, anduke mee expected ₹${x} LPA tho compare cheyyalenu.`,
    salaryCompare: (x, link, pay, fits) => `Mee expected salary ₹${x} LPA. ${link} icche salary ${pay} - `
      + (fits ? 'mee expectation aa range lone undi.' : 'mee expectation aa range kante ekkuva undi.'),
    skillItem: (s, n) => `**${s}** (${n} job${n === 1 ? '' : 's'})`,
    skillsGaps: (items) => `Mee profile ki daggaraga unna jobs adugutunna, meeru inka add cheyyani skills: ${items.join(', ')}.`,
    skillsNone: () => 'Mee profile ki daggaraga unna jobs adige skills anni mee profile lo already unnayi.',
    help: (first) => `Namaskaram${first ? ` ${first}` : ''}! Nenu veetilo help cheyagalanu: mee profile improve cheyyadam, meeku saripoye jobs, `
      + 'oka job ki apply cheyyala vadda, mee career path, interview preparation, salary, nerchukovalsina skills. Veetilo edaina adagandi!',
  },

  hi: {
    fee: () => 'TeamLink नौकरी के लिए उम्मीदवारों से कोई पैसा नहीं लेता। अगर कोई नौकरी या इंटरव्यू के लिए फ़ीस माँगे, '
      + 'तो कृपया पैसे न दें - यह एक आम नौकरी धोखाधड़ी है।',
    profileComplete: (resume) => `आपकी प्रोफ़ाइल में सभी ज़रूरी जानकारी है${resume ? ' और रिज़्यूमे भी अपलोड है' : ''}। `
      + 'अपनी स्किल्स अपडेट रखें और हाल के प्रोजेक्ट जोड़ें - [प्रोफ़ाइल](#/candidate/profile) देखें।',
    profileMissing: (fields, resume) => `अपनी प्रोफ़ाइल मज़बूत बनाने के लिए ये जोड़ें: **${fields.join(', ')}**।`
      + (resume ? '' : ' रिज़्यूमे अपलोड करने से ज़्यादातर जानकारी अपने-आप भर जाती है - [रिज़्यूमे](#/candidate/resume) देखें।')
      + ' इसे [प्रोफ़ाइल](#/candidate/profile) पर अपडेट करें।',
    noJobs: () => 'अभी आपको सुझाने के लिए कोई खुली नौकरी नहीं दिख रही - थोड़ी देर बाद फिर से [नौकरियाँ खोजें](#/candidate/search)।',
    jobsHead: () => 'अभी आपके लिए सबसे अच्छी नौकरियाँ:',
    jobLine: (link, loc, score) => `- ${link} - ${loc || 'जगह नहीं बताई गई'}, **${score}% मैच**`,
    jobsTail: () => 'यह आपके लिए क्यों सही है, यह देखने और अप्लाई करने के लिए जॉब खोलें।',
    noJobToEvaluate: () => 'अभी परखने के लिए कोई खुली नौकरी नहीं दिख रही।',
    verdict: (s) => (s >= 70 ? 'हाँ - आप इसके लिए काफ़ी उपयुक्त हैं, अप्लाई करें।'
      : s >= 50 ? 'अप्लाई करना ठीक रहेगा - यह जो माँगता है, उसका ज़्यादातर हिस्सा आपके पास है।'
        : 'पहले कुछ स्किल्स सीख लें - यह जो माँगता है, उसका कुछ ही हिस्सा अभी आपके पास है।'),
    applyLine: (link, s, verdict) => `${link} (**${s}% मैच**): ${verdict}`,
    applyMissing: (skills) => ` यह जो स्किल्स माँगता है, पर आपकी प्रोफ़ाइल में नहीं हैं: ${skills.join(', ')}।`,
    careerRole: (role) => `आप **${role}** वाली नौकरियों की ओर बढ़ रहे हैं। `,
    careerNoRole: () => 'आपको सही रास्ता सुझाने के लिए अपनी प्रोफ़ाइल में पसंदीदा रोल जोड़ें। ',
    careerGaps: (list) => `आपके सबसे क़रीबी जॉब्स जो स्किल्स सबसे ज़्यादा माँगते हैं: ${list.join(', ')}। इन्हें सीखना ही अगला सही क़दम है।`,
    careerTail: () => ' पूरी योजना के लिए AI Career Hub देखें।',
    noInterview: () => 'अभी आपका कोई इंटरव्यू तय नहीं हुआ है। जैसे ही कोई बुक होगा, मैं तैयारी में मदद करूँगा - [इंटरव्यू](#/candidate/interviews) देखें।',
    interview: (iv) => `आपका अगला इंटरव्यू: ${iv.title || 'आपके आवेदन'} के लिए **${roundLabel(iv.type, 'hi')}**`
      + `${iv.date ? `, तारीख़ ${iv.date}` : ''}${iv.time ? `, समय ${iv.time}` : ''}।\n`
      + '- अपने अनुभव और स्किल्स के बारे में दो मिनट का परिचय बोलकर अभ्यास करें।\n'
      + '- कोई असली समस्या जो आपने सुलझाई हो, उसका एक उदाहरण तैयार रखें।\n'
      + '- जॉब डिस्क्रिप्शन फिर से पढ़ें और अपनी स्किल्स उससे मिलाएँ।',
    salaryNoExpected: () => 'अपनी अपेक्षित सैलरी [प्रोफ़ाइल](#/candidate/profile) में जोड़ें, फिर मैं उसे खुली नौकरियों से मिलाकर बताऊँगा।',
    salaryNoJob: () => 'आपकी अपेक्षित सैलरी से तुलना करने के लिए अभी कोई खुली नौकरी नहीं दिख रही।',
    salaryNoRange: (link, x) => `${link} में सैलरी रेंज नहीं दी गई है, इसलिए आपकी अपेक्षित ₹${x} LPA से तुलना नहीं कर सकता।`,
    salaryCompare: (x, link, pay, fits) => `आपकी अपेक्षित सैलरी ₹${x} LPA है। ${link} की सैलरी ${pay} है - `
      + (fits ? 'आपकी अपेक्षा इस रेंज के अंदर है।' : 'आपकी अपेक्षा इस रेंज से ज़्यादा है।'),
    skillItem: (s, n) => `**${s}** (${n} जॉब)`,
    skillsGaps: (items) => `आपकी प्रोफ़ाइल के सबसे क़रीबी जॉब्स जो स्किल्स माँगते हैं, पर जो आपने अभी तक नहीं जोड़ीं: ${items.join(', ')}।`,
    skillsNone: () => 'आपकी प्रोफ़ाइल के क़रीबी जॉब्स जो स्किल्स माँगते हैं, वे सब आपकी प्रोफ़ाइल में पहले से हैं।',
    help: (first) => `नमस्ते${first ? ` ${first}` : ''}! मैं इनमें मदद कर सकता हूँ: आपकी प्रोफ़ाइल बेहतर बनाना, आपके लिए सही नौकरियाँ, `
      + 'किसी नौकरी के लिए अप्लाई करें या नहीं, करियर का रास्ता, इंटरव्यू की तैयारी, सैलरी, और कौन-सी स्किल्स सीखनी हैं। इनमें से कुछ भी पूछिए!',
  },

  'hi-Latn': {
    fee: () => 'TeamLink naukri ke liye candidates se koi paisa nahi leta. Agar koi job ya interview ke liye fees maange, '
      + 'to please paise mat dijiye - yeh ek aam naukri fraud hai.',
    profileComplete: (resume) => `Aapki profile mein saari zaroori details hain${resume ? ' aur resume bhi upload hai' : ''}. `
      + 'Apni skills update rakhiye aur recent projects jodiye - [Profile](#/candidate/profile) dekhiye.',
    profileMissing: (fields, resume) => `Apni profile strong banane ke liye yeh jodiye: **${fields.join(', ')}**.`
      + (resume ? '' : ' Resume upload karne se zyaadatar details apne-aap bhar jaati hain - [Resume](#/candidate/resume) dekhiye.')
      + ' Ise [Profile](#/candidate/profile) par update kijiye.',
    noJobs: () => 'Abhi aapko suggest karne ke liye koi open job nahi dikh rahi - thodi der baad phir se [Search Jobs](#/candidate/search) dekhiye.',
    jobsHead: () => 'Abhi aapke liye sabse achhi jobs:',
    jobLine: (link, loc, score) => `- ${link} - ${loc || 'location nahi di gayi'}, **${score}% match**`,
    jobsTail: () => 'Yeh aapke liye kyun sahi hai dekhne aur apply karne ke liye job kholiye.',
    noJobToEvaluate: () => 'Abhi dekhne ke liye koi open job nahi dikh rahi.',
    verdict: (s) => (s >= 70 ? 'Haan - aap iske liye kaafi fit hain, apply kijiye.'
      : s >= 50 ? 'Apply karna theek rahega - yeh jo maangta hai uska zyaadatar hissa aapke paas hai.'
        : 'Pehle kuch skills seekh lijiye - yeh jo maangta hai uska kuch hi hissa abhi aapke paas hai.'),
    applyLine: (link, s, verdict) => `${link} (**${s}% match**): ${verdict}`,
    applyMissing: (skills) => ` Yeh jo skills maangta hai par aapki profile mein nahi hain: ${skills.join(', ')}.`,
    careerRole: (role) => `Aap **${role}** jobs ki taraf badh rahe hain. `,
    careerNoRole: () => 'Aapko sahi raasta suggest karne ke liye apni profile mein preferred role jodiye. ',
    careerGaps: (list) => `Aapke sabse kareebi jobs jo skills sabse zyaada maangte hain: ${list.join(', ')}. Inhe seekhna hi agla sahi kadam hai.`,
    careerTail: () => ' Poore plan ke liye AI Career Hub dekhiye.',
    noInterview: () => 'Abhi aapka koi interview tay nahi hua hai. Jaise hi koi book hoga, main taiyari mein madad karunga - [Interviews](#/candidate/interviews) dekhiye.',
    interview: (iv) => `Aapka agla interview: ${iv.title || 'aapki application'} ke liye **${roundLabel(iv.type, 'en')}**`
      + `${iv.date ? `, date ${iv.date}` : ''}${iv.time ? `, time ${iv.time}` : ''}.\n`
      + '- Apne experience aur skills ke baare mein do minute ka introduction bolkar practice kijiye.\n'
      + '- Koi real problem jo aapne solve ki ho, uska ek example taiyaar rakhiye.\n'
      + '- Job description phir se padhiye aur apni skills usse match kijiye.',
    salaryNoExpected: () => 'Apni expected salary [Profile](#/candidate/profile) mein jodiye, phir main use open jobs se compare karke bataunga.',
    salaryNoJob: () => 'Aapki expected salary se compare karne ke liye abhi koi open job nahi dikh rahi.',
    salaryNoRange: (link, x) => `${link} mein salary range nahi di gayi hai, isliye aapki expected ₹${x} LPA se compare nahi kar sakta.`,
    salaryCompare: (x, link, pay, fits) => `Aapki expected salary ₹${x} LPA hai. ${link} ki salary ${pay} hai - `
      + (fits ? 'aapki expectation is range ke andar hai.' : 'aapki expectation is range se zyaada hai.'),
    skillItem: (s, n) => `**${s}** (${n} job${n === 1 ? '' : 's'})`,
    skillsGaps: (items) => `Aapki profile ke sabse kareebi jobs jo skills maangte hain, par jo aapne abhi tak nahi jodi: ${items.join(', ')}.`,
    skillsNone: () => 'Aapki profile ke kareebi jobs jo skills maangte hain, woh sab aapki profile mein pehle se hain.',
    help: (first) => `Namaste${first ? ` ${first}` : ''}! Main inmein madad kar sakta hoon: aapki profile behtar banana, aapke liye sahi jobs, `
      + 'kisi job ke liye apply karein ya nahi, career path, interview ki taiyari, salary, aur kaunsi skills seekhni hain. Inmein se kuch bhi poochhiye!',
  },
};

/** The missing-field names, in the reply's language (romanized keeps the English words). */
export const fieldNames = (lang, fields) => fields.map((f) => field(lang, f));

/** The question the home page's suggestion card asks, in the candidate's language. */
export const SUGGESTION_QUESTION = {
  en: 'What skills should I learn?',
  te: 'నేను ఏ స్కిల్స్ నేర్చుకోవాలి?',
  hi: 'मुझे कौन-सी स्किल्स सीखनी चाहिए?',
};
