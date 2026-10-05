/**
 * The interview prep kit in Telugu and Hindi (spec §4 "Language").
 *
 * When the candidate's preferred language (candidates.preferred_language,
 * 0102) is te or hi, the kit page shows its TIPS, its BRING-LIST and its
 * fixed HEADINGS in that language. The QUESTIONS stay English: they carry
 * technical terms, and the interview itself is usually held in English.
 *
 * WHAT IS TRANSLATED, EXACTLY. A tip or bring-list item is translated
 * only when its English text is one of the rules engine's own template
 * strings (prep-kit.js TIPS / GENERAL_TIPS / BRING) - matched on the
 * whole text, not on the item's key, because a recruiter may have kept a
 * key and changed what it says. A recruiter's own wording, or a tip the
 * AI engine wrote, is shown as written (English): there is no translator
 * behind this, and a guessed translation of free text is worse than the
 * original. The recruiter's instructions are shown as written too.
 *
 * Nothing here can name the company: these are fixed strings, and the
 * kit's data never had a company column to put into them.
 */

export const KIT_LANGUAGES = ['en', 'te', 'hi'];
export const langOf = (v) => (KIT_LANGUAGES.includes(v) ? v : 'en');

/* ------------------------------------------------------------------ *
 * tips: English template text -> { te, hi }
 * ------------------------------------------------------------------ */

export const TIP_TEXT = {
  // in person
  'Reach the venue 15 minutes early.': {
    te: 'ఇంటర్వ్యూ జరిగే చోటుకి 15 నిమిషాలు ముందుగానే చేరుకోండి.',
    hi: 'इंटरव्यू की जगह पर 15 मिनट पहले पहुँचें।',
  },
  'Save the venue address on your phone so you have it offline.': {
    te: 'ఇంటర్నెట్ లేకపోయినా చూసుకునేలా చిరునామాను మీ ఫోన్‌లో సేవ్ చేసుకోండి.',
    hi: 'पता अपने फ़ोन में सेव कर लें, ताकि इंटरनेट के बिना भी देख सकें।',
  },
  'Wear formal clothes.': {
    te: 'ఫార్మల్ దుస్తులు వేసుకోండి.',
    hi: 'फ़ॉर्मल कपड़े पहनें।',
  },
  'Switch your phone to silent before you go in.': {
    te: 'లోపలికి వెళ్లే ముందు మీ ఫోన్‌ను సైలెంట్‌లో పెట్టండి.',
    hi: 'अंदर जाने से पहले अपना फ़ोन साइलेंट पर कर दें।',
  },
  // video
  'Test your camera, microphone and internet 10 minutes before.': {
    te: '10 నిమిషాల ముందే మీ కెమెరా, మైక్రోఫోన్, ఇంటర్నెట్ సరిగ్గా పనిచేస్తున్నాయో చూసుకోండి.',
    hi: '10 मिनट पहले अपना कैमरा, माइक्रोफ़ोन और इंटरनेट जाँच लें।',
  },
  'Sit in a quiet room with a plain background and good light on your face.': {
    te: 'వెనుక సాదా గోడ ఉండి, మీ ముఖం మీద మంచి వెలుతురు పడే నిశ్శబ్దమైన గదిలో కూర్చోండి.',
    hi: 'किसी शांत कमरे में बैठें, जहाँ पीछे सादी दीवार हो और चेहरे पर अच्छी रोशनी पड़े।',
  },
  'Join 5 minutes early.': {
    te: '5 నిమిషాలు ముందుగానే ఇంటర్వ్యూలో చేరండి.',
    hi: '5 मिनट पहले जुड़ जाएँ।',
  },
  'Keep your charger plugged in.': {
    te: 'ఛార్జర్ ప్లగ్ చేసి ఉంచండి.',
    hi: 'चार्जर लगाकर रखें।',
  },
  // phone
  'Take the call from a quiet place.': {
    te: 'నిశ్శబ్దంగా ఉండే చోటు నుంచి కాల్ మాట్లాడండి.',
    hi: 'कॉल किसी शांत जगह से लें।',
  },
  'Make sure your phone is fully charged.': {
    te: 'మీ ఫోన్ పూర్తిగా ఛార్జ్ అయి ఉండేలా చూసుకోండి.',
    hi: 'ध्यान रखें कि आपका फ़ोन पूरा चार्ज हो।',
  },
  'Keep your resume in front of you.': {
    te: 'మీ రెజ్యూమ్‌ను మీ ముందే ఉంచుకోండి.',
    hi: 'अपना रिज़्यूमे सामने रखें।',
  },
  'Answer in full sentences - the interviewer cannot see you.': {
    te: 'ఇంటర్వ్యూ చేసేవారు మిమ్మల్ని చూడలేరు, కాబట్టి పూర్తి వాక్యాల్లో సమాధానం చెప్పండి.',
    hi: 'पूरे वाक्यों में जवाब दें - इंटरव्यू लेने वाले आपको देख नहीं सकते।',
  },
  // TeamLink AI interview
  'Use a laptop or phone with a working camera and microphone.': {
    te: 'కెమెరా, మైక్రోఫోన్ సరిగ్గా పనిచేసే ల్యాప్‌టాప్ లేదా ఫోన్ వాడండి.',
    hi: 'ऐसा लैपटॉप या फ़ोन इस्तेमाल करें जिसका कैमरा और माइक्रोफ़ोन ठीक से काम करता हो।',
  },
  'Keep the interview open in a single tab until you finish.': {
    te: 'ఇంటర్వ్యూ పూర్తయ్యే వరకు దాన్ని ఒకే ట్యాబ్‌లో తెరిచి ఉంచండి.',
    hi: 'इंटरव्यू पूरा होने तक उसे एक ही टैब में खुला रखें।',
  },
  'Find a quiet room where nobody else will speak.': {
    te: 'వేరే ఎవరూ మాట్లాడని నిశ్శబ్దమైన గదిని ఎంచుకోండి.',
    hi: 'ऐसा शांत कमरा चुनें जहाँ कोई और न बोले।',
  },
  'Speak clearly and take a moment before each answer.': {
    te: 'స్పష్టంగా మాట్లాడండి. ప్రతి సమాధానానికి ముందు ఒక్క క్షణం ఆలోచించుకోండి.',
    hi: 'साफ़ बोलें और हर जवाब से पहले एक पल सोच लें।',
  },
  // every round except the AI interview
  'Read the job description again and prepare two or three examples that match it.': {
    te: 'ఉద్యోగ వివరణను మళ్ళీ చదవండి. దానికి సరిపోయే రెండు మూడు ఉదాహరణలు సిద్ధం చేసుకోండి.',
    hi: 'जॉब डिस्क्रिप्शन फिर से पढ़ें और उससे मेल खाते दो-तीन उदाहरण तैयार रखें।',
  },
  'Keep your answers specific: what you did, how, and the result.': {
    te: 'మీ సమాధానాలు స్పష్టంగా ఉండాలి: మీరు ఏం చేశారు, ఎలా చేశారు, ఫలితం ఏమిటి.',
    hi: 'जवाब ठोस रखें: आपने क्या किया, कैसे किया और नतीजा क्या रहा।',
  },
};

/* ------------------------------------------------------------------ *
 * bring-list: English template text -> { te, hi }
 * ------------------------------------------------------------------ */

export const BRING_TEXT = {
  // in person
  'Two printed copies of your resume': {
    te: 'మీ రెజ్యూమ్ రెండు ప్రింట్ కాపీలు',
    hi: 'आपके रिज़्यूमे की दो प्रिंट कॉपी',
  },
  'A government photo ID': {
    te: 'ప్రభుత్వం ఇచ్చిన ఫోటో గుర్తింపు కార్డు',
    hi: 'सरकारी फ़ोटो पहचान पत्र',
  },
  'Two passport-size photographs': {
    te: 'రెండు పాస్‌పోర్ట్ సైజు ఫోటోలు',
    hi: 'दो पासपोर्ट साइज़ फ़ोटो',
  },
  'Your qualification certificates (originals and copies)': {
    te: 'మీ విద్యార్హత సర్టిఫికెట్లు (ఒరిజినల్స్, జిరాక్స్ కాపీలు)',
    hi: 'आपके शैक्षणिक प्रमाण पत्र (मूल और फ़ोटोकॉपी)',
  },
  'The venue address saved offline': {
    te: 'ఫోన్‌లో ఆఫ్‌లైన్‌గా సేవ్ చేసుకున్న చిరునామా',
    hi: 'फ़ोन में ऑफ़लाइन सेव किया हुआ पता',
  },
  'Formal clothes, ready the night before': {
    te: 'ముందు రోజు రాత్రే సిద్ధం చేసుకున్న ఫార్మల్ దుస్తులు',
    hi: 'फ़ॉर्मल कपड़े, एक रात पहले तैयार',
  },
  // video
  'Camera, microphone and internet tested': {
    te: 'కెమెరా, మైక్రోఫోన్, ఇంటర్నెట్ పరీక్షించుకోవడం',
    hi: 'कैमरा, माइक्रोफ़ोन और इंटरनेट की जाँच',
  },
  'A quiet room with a plain background': {
    te: 'వెనుక సాదా గోడ ఉండే నిశ్శబ్దమైన గది',
    hi: 'सादी दीवार वाला शांत कमरा',
  },
  'Charger plugged in': {
    te: 'ఛార్జర్ ప్లగ్ చేసి ఉంచడం',
    hi: 'चार्जर लगा हुआ',
  },
  'Your resume open to refer to': {
    te: 'చూసుకోవడానికి తెరిచి ఉంచిన మీ రెజ్యూమ్',
    hi: 'देखने के लिए खुला रखा आपका रिज़्यूमे',
  },
  'A photo ID nearby, in case you are asked': {
    te: 'అడిగితే చూపించడానికి దగ్గర్లో ఒక ఫోటో గుర్తింపు కార్డు',
    hi: 'पास में एक फ़ोटो पहचान पत्र, अगर माँगा जाए',
  },
  'Ready to join 5 minutes early': {
    te: '5 నిమిషాలు ముందుగానే చేరడానికి సిద్ధంగా ఉండటం',
    hi: '5 मिनट पहले जुड़ने के लिए तैयार',
  },
  // phone
  'Phone fully charged': {
    te: 'పూర్తిగా ఛార్జ్ అయిన ఫోన్',
    hi: 'पूरा चार्ज किया हुआ फ़ोन',
  },
  'A quiet place to take the call': {
    te: 'కాల్ మాట్లాడటానికి నిశ్శబ్దమైన చోటు',
    hi: 'कॉल लेने के लिए शांत जगह',
  },
  'Your resume in front of you': {
    te: 'మీ ముందే మీ రెజ్యూమ్',
    hi: 'आपके सामने आपका रिज़्यूमे',
  },
  'Pen and paper for notes': {
    te: 'నోట్స్ రాసుకోవడానికి పెన్ను, కాగితం',
    hi: 'नोट्स के लिए पेन और काग़ज़',
  },
  'Two questions to ask the interviewer': {
    te: 'ఇంటర్వ్యూ చేసేవారిని అడగడానికి రెండు ప్రశ్నలు',
    hi: 'इंटरव्यू लेने वाले से पूछने के लिए दो सवाल',
  },
  'Ready to answer from an unknown number': {
    te: 'తెలియని నంబర్ నుంచి కాల్ వచ్చినా ఎత్తడానికి సిద్ధంగా ఉండటం',
    hi: 'अनजान नंबर से कॉल आए तो उठाने के लिए तैयार',
  },
  // TeamLink AI interview
  'Laptop or phone with camera and microphone': {
    te: 'కెమెరా, మైక్రోఫోన్ ఉన్న ల్యాప్‌టాప్ లేదా ఫోన్',
    hi: 'कैमरा और माइक्रोफ़ोन वाला लैपटॉप या फ़ोन',
  },
  'A quiet room where nobody else will speak': {
    te: 'వేరే ఎవరూ మాట్లాడని నిశ్శబ్దమైన గది',
    hi: 'शांत कमरा, जहाँ कोई और न बोले',
  },
  'Only the interview tab open': {
    te: 'ఇంటర్వ్యూ ట్యాబ్ ఒక్కటే తెరిచి ఉండటం',
    hi: 'सिर्फ़ इंटरव्यू वाला टैब खुला हो',
  },
  'Camera on and uncovered': {
    te: 'కెమెరా ఆన్‌లో ఉండి, దేనితోనూ కప్పకుండా ఉండటం',
    hi: 'कैमरा चालू हो और ढका न हो',
  },
  'About 20 uninterrupted minutes': {
    te: 'ఎవరూ అంతరాయం కలిగించని సుమారు 20 నిమిషాలు',
    hi: 'बिना रुकावट के लगभग 20 मिनट',
  },
};

/* ------------------------------------------------------------------ *
 * the page's fixed words
 * ------------------------------------------------------------------ */

export const KIT_LABELS = {
  en: {
    back: '← Interviews',
    date: 'Date',
    duration: 'Duration',
    round: 'Round',
    toBeConfirmed: 'To be confirmed',
    addToCalendar: '📅 Add to calendar',
    practice: '💬 Practice with AI Assistant',
    where: 'Where',
    venue: 'Venue',
    openInMaps: '📍 Open in Google Maps',
    venuePending: 'The venue address will be shared here once it is confirmed.',
    phoneCall: 'The interviewer will call you on your registered phone number.',
    aiInterview: 'This is a TeamLink AI interview, taken in your browser.',
    meetingLink: 'Meeting link',
    join: '🎥 Join interview',
    linkOpen: 'The link is open.',
    joinOpens: 'Join opens 15 minutes before the start.',
    linkPending: 'The meeting link will be shared here once it is confirmed.',
    contact: 'Contact',
    fromRecruiter: 'From your recruiter',
    questions: 'Likely questions',
    questionsHint: 'Tap a question to see why interviewers ask it.',
    tips: 'Tips',
    bring: 'What to bring',
    ready: '{done} of {total} ready',
    hour: '{n} hour',
    hours: '{n} hours',
    minutes: '{n} min',
    preparing: 'Your recruiter is preparing your prep kit. It will appear here, and we will send you the link.',
  },
  te: {
    back: '← ఇంటర్వ్యూలు',
    date: 'తేదీ',
    duration: 'వ్యవధి',
    round: 'రౌండ్',
    toBeConfirmed: 'ఇంకా ఖరారు కాలేదు',
    addToCalendar: '📅 క్యాలెండర్‌లో చేర్చండి',
    practice: '💬 AI అసిస్టెంట్‌తో ప్రాక్టీస్ చేయండి',
    where: 'ఎక్కడ',
    venue: 'ఇంటర్వ్యూ జరిగే చోటు',
    openInMaps: '📍 Google Mapsలో తెరవండి',
    venuePending: 'చిరునామా ఖరారైన వెంటనే ఇక్కడ చూపిస్తాం.',
    phoneCall: 'ఇంటర్వ్యూ చేసేవారు మీ రిజిస్టర్డ్ ఫోన్ నంబర్‌కు కాల్ చేస్తారు.',
    aiInterview: 'ఇది TeamLink AI ఇంటర్వ్యూ. ఇది మీ బ్రౌజర్‌లోనే జరుగుతుంది.',
    meetingLink: 'మీటింగ్ లింక్',
    join: '🎥 ఇంటర్వ్యూలో చేరండి',
    linkOpen: 'లింక్ ఇప్పుడు తెరుచుకుంటుంది.',
    joinOpens: 'ఇంటర్వ్యూ మొదలయ్యే 15 నిమిషాల ముందు నుంచి చేరవచ్చు.',
    linkPending: 'మీటింగ్ లింక్ ఖరారైన వెంటనే ఇక్కడ చూపిస్తాం.',
    contact: 'సంప్రదించాల్సిన వ్యక్తి',
    fromRecruiter: 'మీ రిక్రూటర్ సూచనలు',
    questions: 'అడిగే అవకాశం ఉన్న ప్రశ్నలు',
    questionsHint: 'ఒక ప్రశ్నను ఎందుకు అడుగుతారో తెలుసుకోవడానికి దాని మీద నొక్కండి. ఇంటర్వ్యూ ఇంగ్లీష్‌లో జరిగే అవకాశం ఉన్నందున ప్రశ్నలు ఇంగ్లీష్‌లోనే ఉన్నాయి.',
    tips: 'సూచనలు',
    bring: 'సిద్ధంగా ఉంచుకోవాల్సినవి',
    ready: '{total}లో {done} సిద్ధం',
    hour: '{n} గంట',
    hours: '{n} గంటలు',
    minutes: '{n} నిమిషాలు',
    preparing: 'మీ రిక్రూటర్ మీ ఇంటర్వ్యూ ప్రిపరేషన్ కిట్‌ను సిద్ధం చేస్తున్నారు. అది ఇక్కడ కనిపిస్తుంది, దాని లింక్‌ను కూడా మీకు పంపిస్తాం.',
  },
  hi: {
    back: '← इंटरव्यू',
    date: 'तारीख़',
    duration: 'अवधि',
    round: 'राउंड',
    toBeConfirmed: 'अभी तय नहीं',
    addToCalendar: '📅 कैलेंडर में जोड़ें',
    practice: '💬 AI असिस्टेंट के साथ अभ्यास करें',
    where: 'कहाँ',
    venue: 'इंटरव्यू की जगह',
    openInMaps: '📍 Google Maps में खोलें',
    venuePending: 'पता तय होते ही यहाँ दिखाया जाएगा।',
    phoneCall: 'इंटरव्यू लेने वाले आपके रजिस्टर्ड फ़ोन नंबर पर कॉल करेंगे।',
    aiInterview: 'यह TeamLink AI इंटरव्यू है, जो आपके ब्राउज़र में ही होगा।',
    meetingLink: 'मीटिंग लिंक',
    join: '🎥 इंटरव्यू में जुड़ें',
    linkOpen: 'लिंक अब खुल गया है।',
    joinOpens: 'इंटरव्यू शुरू होने से 15 मिनट पहले से जुड़ सकते हैं।',
    linkPending: 'मीटिंग लिंक तय होते ही यहाँ दिखाया जाएगा।',
    contact: 'संपर्क',
    fromRecruiter: 'आपके रिक्रूटर की ओर से',
    questions: 'पूछे जा सकने वाले सवाल',
    questionsHint: 'कोई सवाल क्यों पूछा जाता है, यह जानने के लिए उस पर टैप करें। इंटरव्यू आम तौर पर अंग्रेज़ी में होता है, इसलिए सवाल अंग्रेज़ी में ही दिए गए हैं।',
    tips: 'सुझाव',
    bring: 'क्या-क्या तैयार रखें',
    ready: '{total} में से {done} तैयार',
    hour: '{n} घंटा',
    hours: '{n} घंटे',
    minutes: '{n} मिनट',
    preparing: 'आपके रिक्रूटर आपकी इंटरव्यू तैयारी किट बना रहे हैं। यह यहीं दिखेगी, और हम आपको इसका लिंक भी भेजेंगे।',
  },
};

/** How the interview is held, by location type. */
export const MODE_LABELS = {
  en: { in_person: 'In person', video: 'Video call', phone: 'Phone call', teamlink_ai: 'TeamLink AI interview' },
  te: { in_person: 'నేరుగా హాజరు', video: 'వీడియో కాల్', phone: 'ఫోన్ కాల్', teamlink_ai: 'TeamLink AI ఇంటర్వ్యూ' },
  hi: { in_person: 'आमने-सामने', video: 'वीडियो कॉल', phone: 'फ़ोन कॉल', teamlink_ai: 'TeamLink AI इंटरव्यू' },
};

/** The interview's status pill. */
export const STATUS_LABELS = {
  te: { Scheduled: 'షెడ్యూల్ అయింది', Completed: 'పూర్తయింది', Cancelled: 'రద్దయింది', 'No Show': 'హాజరు కాలేదు' },
  hi: { Scheduled: 'तय है', Completed: 'पूरा हुआ', Cancelled: 'रद्द', 'No Show': 'उपस्थित नहीं हुए' },
};

/**
 * The round, as a candidate may read it. "Client Round" is said
 * "Company Round" in every language (0051: candidates never see the word).
 */
const ROUND_LABELS = {
  te: { technical: 'టెక్నికల్ రౌండ్', company: 'కంపెనీ రౌండ్', hr: 'HR రౌండ్', ai: 'AI ఇంటర్వ్యూ', other: 'ఇంటర్వ్యూ' },
  hi: { technical: 'टेक्निकल राउंड', company: 'कंपनी राउंड', hr: 'HR राउंड', ai: 'AI इंटरव्यू', other: 'इंटरव्यू' },
};
export function roundLabel(type, lang = 'en') {
  const raw = String(type || 'Interview');
  const en = raw.replace(/\bclients\b/gi, 'Companies').replace(/\bclient\b/gi, 'Company');
  const L = ROUND_LABELS[langOf(lang)];
  if (!L) return en;
  const t = raw.toLowerCase();
  if (/ai interview/.test(t)) return L.ai;
  if (/\bhr\b/.test(t)) return L.hr;
  if (/client|company/.test(t)) return L.company;
  if (/technical/.test(t)) return L.technical;
  if (/^interview$/.test(t.trim())) return L.other;
  return en;
}

/** A template tip in the candidate's language; anything else as written. */
export function tipIn(text, lang) {
  const l = langOf(lang);
  if (l === 'en') return text;
  const t = TIP_TEXT[String(text || '').trim()];
  return (t && t[l]) || text;
}

/** A template bring-list item in the candidate's language; anything else as written. */
export function bringIn(text, lang) {
  const l = langOf(lang);
  if (l === 'en') return text;
  const t = BRING_TEXT[String(text || '').trim()];
  return (t && t[l]) || text;
}

export const labelsFor = (lang) => ({ ...KIT_LABELS.en, ...(KIT_LABELS[langOf(lang)] || {}) });

/** The date line, in the candidate's language (Telugu / Hindi month and day names). */
export const DATE_LOCALE = { en: 'en-GB', te: 'te-IN', hi: 'hi-IN' };
