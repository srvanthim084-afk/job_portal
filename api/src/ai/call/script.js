/**
 * What the agent actually says, in each language.
 *
 * NOT a translation table. The Hindi and Telugu lines are written as
 * somebody would say them on a recruitment call, not as a word-for-word
 * rendering of the English - "Is this a good time?" translated literally
 * into Telugu sounds like a form letter, and candidates hang up on form
 * letters.
 *
 * Two deliberate rules run through all of it:
 *
 *   - English technical words stay English in every language. Nobody says
 *     the Telugu word for "React Developer", and a candidate who hears one
 *     assumes they have been called by mistake.
 *   - Every line is short. A phone call is not a paragraph, and an agent
 *     that delivers speeches gets interrupted and talked over.
 *
 * `mixed` picks the code-switched form, which is how most of these calls
 * are really conducted: Hinglish and Telugu-English rather than formal
 * Hindi or Telugu.
 */

const L = (en, hi, te, opts = {}) => ({ en, hi, te, mixed: opts.mixed || null });

/**
 * @param {object} line   one of the entries below
 * @param {string} lang   en | hi | te
 * @param {boolean} mixed the candidate is code switching
 * @param {object} vars   {name, role, company, ...}
 */
export function say(line, lang = 'en', mixed = false, vars = {}) {
  if (!line) return '';
  const pick = (mixed && line.mixed && line.mixed[lang]) || line[lang] || line.en;
  return String(pick).replace(/\{(\w+)\}/g, (_, k) =>
    (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).replace(/\s+/g, ' ').trim();
}

export const LINES = {
  /* ---- opening ---------------------------------------------------- */
  askForCandidate: L(
    'Hello, may I speak with {name}?',
    'Hello, kya main {name} se baat kar sakti hoon?',
    'Hello, {name} gaaru unnara?'),

  introduce: L(
    'Hi {name}, this is {agent} calling from {company}.',
    'Hi {name}, main {agent} bol rahi hoon {company} se.',
    'Hi {name}, nenu {agent}, {company} nunchi call chestunna.'),

  reasonApplied: L(
    'You had applied for a {role} opportunity with us.',
    'Aapne humare paas {role} ke liye apply kiya tha.',
    'Meeru maa daggara {role} position ki apply chesaru.'),

  reasonSourced: L(
    'We have a {role} opportunity that looks close to your profile.',
    'Humare paas ek {role} opportunity hai jo aapke profile se match karti hai.',
    'Maa daggara oka {role} opportunity undi, mee profile ki baaga match avutundi.',
    { mixed: { te: 'Maa daggara oka {role} opportunity undi, mee profile ki baaga match avutundi.' } }),

  goodTime: L(
    'Is this a good time for a quick conversation?',
    'Kya abhi baat karne ka sahi time hai?',
    'Ippudu konchem maatladochaa?'),

  aiDisclosure: L(
    'Just so you know, I am an AI assistant calling on behalf of the recruitment team.',
    'Aapko bata doon, main recruitment team ki taraf se ek AI assistant hoon.',
    'Mee ki cheppali ani, nenu recruitment team taraphuna AI assistant ni.'),

  recordingDisclosure: L(
    'This call may be recorded for quality purposes.',
    'Quality ke liye yeh call record ho sakti hai.',
    'Quality kosam ee call record avvachu.'),

  /* ---- language --------------------------------------------------- */
  whichLanguage: L(
    'Which language would you be more comfortable speaking in - English, Hindi, or Telugu?',
    'Aap kis language mein comfortable hain - English, Hindi ya Telugu?',
    'Meeku ee language lo comfortable - English, Hindi, leda Telugu?',
    { mixed: { te: 'Meeku ee language lo comfortable - English, Hindi, leda Telugu?' } }),

  switched: L(
    'Of course.',
    'Bilkul.',
    'Tappakunda.'),

  /* ---- the opportunity -------------------------------------------- */
  shortlisted: L(
    'Your profile has been shortlisted for consideration for this opportunity. I wanted to confirm your interest and availability before we move to the next stage.',
    'Aapka profile is opportunity ke liye shortlist hua hai. Next stage se pehle aapka interest aur availability confirm karna tha.',
    'Mee profile ee opportunity ki shortlist ayyindi. Next stage ki velle mundu mee interest, availability confirm cheddam ani.'),

  opportunity: L(
    'The role is {role}{atCompany}{inLocation}.',
    'Role hai {role}{atCompany}{inLocation}.',
    'Role {role}{atCompany}{inLocation}.'),

  askInterest: L(
    'Are you currently open to new opportunities?',
    'Kya aap abhi naye opportunities dekh rahe hain?',
    'Meeru ippudu kotha opportunities chustunnara?'),

  /* ---- not interested --------------------------------------------- */
  whyNotInterested: L(
    'Understood. May I know if you are currently not looking for a change, or if this particular opportunity is not suitable?',
    'Samajh gayi. Kya aap abhi change nahi dekh rahe, ya yeh opportunity suitable nahi lag rahi?',
    'Ardham ayyindi. Meeru ippudu change chudatam ledaa, leda ee opportunity saripodaa?'),

  noteNotInterested: L(
    'Thank you for letting me know. I will update your profile so we do not trouble you about this role again.',
    'Batane ke liye shukriya. Main aapka profile update kar deti hoon taaki is role ke liye dobara pareshan na karein.',
    'Cheppinanduku thanks. Mee profile update chestanu, ee role gurinchi malli ibbandi pettamu.'),

  doNotContact: L(
    'I understand completely. I have marked your profile so you will not receive further calls from us.',
    'Main puri tarah samajhti hoon. Maine aapka profile mark kar diya hai, aapko aage calls nahi aayengi.',
    'Purthiga ardham ayyindi. Mee profile mark chesanu, inka calls raavu.'),

  /* ---- angry, busy, hold ------------------------------------------ */
  apologise: L(
    'I completely understand, and I am sorry for disturbing you. I will keep this very brief.',
    'Main bilkul samajhti hoon, disturb karne ke liye maafi. Main bahut short rakhungi.',
    'Purthiga ardham ayyindi, ibbandi pettinanduku sorry. Chaala takkuva time teesukunta.'),

  offerToStop: L(
    'If you are not interested, I can update your profile accordingly and stop these calls.',
    'Agar aap interested nahi hain, main aapka profile update kar ke yeh calls band kar sakti hoon.',
    'Meeru interest lekapothe, mee profile update chesi ee calls aapestanu.'),

  busyCallback: L(
    'No problem at all. When would be a convenient time for us to call you back?',
    'Koi baat nahi. Hum aapko kab call back kar sakte hain?',
    'Parledu andi. Meeku eppudu convenient ga untundi, appudu call chestamu?'),

  callbackNoted: L(
    'Noted, I will have us call you back then. Thank you for your time.',
    'Note kar liya, hum tab call karenge. Aapke time ke liye shukriya.',
    'Note chesanu, appudu call chestamu. Mee time ki thanks andi.'),

  hold: L(
    'Of course, take your time.',
    'Bilkul, aaram se.',
    'Tappakunda, teesukondi.'),

  /* ---- screening --------------------------------------------------- */
  askLocation: L(
    'This role is based in {location}. Would {location} work for you?',
    'Yeh role {location} mein hai. Kya {location} aapke liye theek rahega?',
    'Ee role {location} lo undi. {location} meeku okay na?'),

  askRelocation: L(
    'The position is based in {location}. Would you be comfortable relocating if selected?',
    'Position {location} mein hai. Select hone par relocate karna comfortable rahega?',
    'Position {location} lo undi. Select aithe relocate cheyagalara?'),

  askWorkMode: L(
    'This is a {mode} position. Would that arrangement work for you?',
    'Yeh {mode} position hai. Kya yeh arrangement aapke liye theek hai?',
    'Idi {mode} position. Ee arrangement meeku okay na?'),

  salaryBand: L(
    'The budget for this position is approximately {min} to {max} LPA, depending on the overall profile and the interview. Would that range work for you?',
    'Is position ka budget lagbhag {min} se {max} LPA hai, profile aur interview ke hisaab se. Kya yeh range aapke liye theek hai?',
    'Ee position budget sumaaru {min} nunchi {max} LPA, profile mariyu interview batti. Ee range meeku okay na?'),

  askExpected: L(
    'Understood. What range would you be comfortable considering?',
    'Samajh gayi. Aap kis range mein comfortable rahenge?',
    'Ardham ayyindi. Meeru ee range lo comfortable ga untaru?',
    { mixed: { te: 'Ardham ayyindi. Meeru ee range lo comfortable ga untaru?' } }),

  noteExpectation: L(
    'I will note your expectation and our recruiter can confirm the available flexibility.',
    'Main aapki expectation note kar leti hoon, humare recruiter flexibility confirm kar denge.',
    'Mee expectation note chestanu, maa recruiter flexibility confirm chestaru.'),

  askAvailability: L(
    'How soon would you be able to join if everything works out?',
    'Sab theek raha to aap kitni jaldi join kar sakte hain?',
    'Anni sarigga jarigithe entha thondaraga join cheyagalaru?'),

  askServingNotice: L(
    'Are you currently serving your notice period?',
    'Kya aap abhi notice period serve kar rahe hain?',
    'Meeru ippudu notice period lo unnara?'),

  askSkill: L(
    'How much hands-on experience do you have with {skill}?',
    '{skill} ke saath aapka hands-on experience kitna hai?',
    '{skill} tho mee hands-on experience entha undi?'),

  confirmCurrentRole: L(
    'I have you as {title} at {company} - is that still correct?',
    'Mere paas aap {company} mein {title} hain - kya yeh abhi bhi sahi hai?',
    'Naa daggara meeru {company} lo {title} ani undi - ippatiki adhe na?'),

  askInterviewInterest: L(
    'Would you like us to take this forward and arrange an interview?',
    'Kya hum ise aage badhaakar interview arrange karein?',
    'Deenni mundhuku teesukelli interview arrange cheyyamantara?'),

  /* ---- questions and closing --------------------------------------- */
  anyQuestions: L(
    'Before we finish, do you have any questions about the role or the process?',
    'Khatam karne se pehle, role ya process ke baare mein koi sawaal hai?',
    'Mugimpu mundu, role leda process gurinchi emaina questions unnaya?'),

  dontKnow: L(
    'I do not want to give you incorrect information. I will have our recruiter confirm that for you.',
    'Main aapko galat information nahi dena chahti. Main recruiter se confirm karwa deti hoon.',
    'Meeku thappu information cheppadam ishtam ledu. Maa recruiter tho confirm chestanu.'),

  recruiterWillCall: L(
    'Our recruiter will call you about this. I have noted it against your profile.',
    'Humara recruiter aapko is baare mein call karega. Maine aapke profile mein note kar diya hai.',
    'Maa recruiter deeni gurinchi call chestaru. Mee profile lo note chesanu.'),

  closingInterested: L(
    'Thank you {name}. Our recruiter will follow up with the next steps.',
    'Shukriya {name}. Humara recruiter next steps ke liye contact karega.',
    'Thanks {name} gaaru. Maa recruiter next steps tho contact chestaru.'),

  closingGeneric: L(
    'Thank you for your time. Have a good day.',
    'Aapke time ke liye shukriya. Aapka din accha rahe.',
    'Mee time ki thanks andi. Manchi roju avvaali.'),

  /* ---- trouble ----------------------------------------------------- */
  stillThere: L(
    'Hello? Are you still there?',
    'Hello? Aap line par hain?',
    'Hello? Meeru line lo unnara?'),

  takeYourTime: L(
    'No problem if you need a moment.',
    'Koi baat nahi, aaram se.',
    'Parledu, teesukondi.'),

  notAGoodTime: L(
    'It seems this may not be a convenient time. We can arrange a callback.',
    'Lagta hai abhi sahi time nahi hai. Hum callback arrange kar sakte hain.',
    'Ippudu convenient kaadu anukunta. Callback arrange chestamu.'),

  audioTrouble: L(
    'I am sorry, the audio is not very clear. Could you please repeat that?',
    'Maaf kijiye, awaaz saaf nahi aa rahi. Kya aap dobara keh sakte hain?',
    'Sorry andi, sound clear ga raavatledu. Malli cheppagalara?'),

  audioGivingUp: L(
    'It seems we are having audio issues. I will arrange for a recruiter to contact you instead.',
    'Lagta hai audio mein problem hai. Main recruiter se aapko contact karwa deti hoon.',
    'Audio lo problem unnattu undi. Recruiter ni contact cheyamani chestanu.'),

  didNotUnderstand: L(
    'Sorry, I did not quite catch that.',
    'Maaf kijiye, main theek se samajh nahi payi.',
    'Sorry, sarigga ardham kaaledu.'),

  wrongNumber: L(
    'I am sorry for the trouble - it seems I have the wrong number. I will update our records.',
    'Pareshani ke liye maafi - lagta hai number galat hai. Main records update kar deti hoon.',
    'Ibbandi ki sorry - number thappu anukunta. Records update chestanu.'),
};

/**
 * The agent's persona, for the LLM path.
 *
 * Kept here beside the phrasebook so the rules and the rules-based
 * fallback cannot drift apart: both say the same things, one by picking
 * lines and one by being told how to speak.
 */
export function systemPrompt({ agent, company, language, mixed, candidate, job, objective, known, needed }) {
  const names = { en: 'English', hi: 'Hindi', te: 'Telugu' };
  return [
    `You are ${agent}, a recruitment calling assistant for ${company}.`,
    `You are on a live phone call with ${candidate.name}.`,
    '',
    `SPEAK IN: ${names[language] || 'English'}${mixed ? ` (the candidate is mixing it with English - match that, do not switch to formal ${names[language]})` : ''}.`,
    'Keep technical words in English. Keep every reply to one or two short sentences.',
    '',
    `THE ROLE: ${job.title}${job.location ? `, ${job.location}` : ''}${job.mode ? `, ${job.mode}` : ''}.`,
    job.skills?.length ? `Required skills: ${job.skills.join(', ')}.` : '',
    '',
    'ALREADY KNOWN - never ask for these again:',
    known.map((k) => `  - ${k}`).join('\n') || '  - nothing',
    '',
    'STILL NEEDED - ask only for these, one at a time:',
    needed.map((k) => `  - ${k}`).join('\n') || '  - nothing; confirm interest and close',
    '',
    `OBJECTIVE: ${objective}`,
    '',
    'RULES:',
    '- Never say the candidate is selected. Shortlisted is not selected.',
    '- Never promise a salary, a joining date or an outcome.',
    '- Never invent anything about the role. If you do not know, say a recruiter will confirm.',
    '- Never pressure. No "this is your only chance", no "you will lose this".',
    '- If they are busy, offer a callback and stop screening.',
    '- If they are angry, apologise once, offer to stop, do not argue.',
    '- If they ask for a recruiter, agree and note it.',
    '- Ask ONE question at a time and wait.',
  ].filter(Boolean).join('\n');
}
