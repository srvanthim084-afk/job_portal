/**
 * What did the candidate just mean?
 *
 * The conversation branches on intent, not on keywords in a script, which
 * is the difference between an assistant and a phone menu. Intent is
 * detected in all three languages at once, because a candidate answers
 * "avunu", "haan" and "yes" to the same question and the agent must not
 * care which.
 *
 * Order matters and is deliberate. "I'm interested but I'm in a meeting"
 * is BUSY, not INTERESTED: acting on the first half and ploughing into
 * screening questions is exactly the behaviour that gets recruiters
 * blocked. The urgent intents are therefore matched first.
 */

const has = (t, ...res) => res.some((r) => r.test(t));

/* Every pattern covers English, Hindi and Telugu, romanised and native. */

const P = {
  wrongNumber: [
    /\b(wrong number|galat number|who is this|kaun bol|evaru meeru|number tappu)\b/i,
    /\b(no one by that name|aisa koi nahi|alanti peru evaru leru)\b/i,
  ],
  doNotContact: [
    /\b(do not call|don'?t call me|stop calling|never call|remove my number|unsubscribe)\b/i,
    /\b(phone mat karo|call mat kar|number hata|dobara mat)\b/i,
    /\b(call cheyakandi|call cheyyakandi|number teesey|malli call cheyakandi)\b/i,
  ],
  angry: [
    /\b(how many times|again and again|so many calls|irritating|harass|fed up|bakwas|nonsense)\b/i,
    /\b(kitni baar|baar baar|pareshan|tang kar)\b/i,
    /\b(enni sarlu|marla marla|virakti|ibbandi)\b/i,
    /\b(waste of time|time waste)\b/i,
  ],
  busy: [
    /\b(busy|in a meeting|driving|can'?t talk|not a good time|later|call me back|call back)\b/i,
    /\b(meeting mein|abhi busy|baad mein|thodi der|baad me call)\b/i,
    /\b(meeting lo|ippudu kaadu|tarvata call|busy ga|tarwata)\b/i,
  ],
  recruiter: [
    /\b(speak to (a |the )?(recruiter|human|person|someone)|talk to (a |the )?(recruiter|human)|real person)\b/i,
    /\b(kisi insaan se|recruiter se baat)\b/i,
    /\b(recruiter tho matladali|manishi tho)\b/i,
  ],
  notInterested: [
    /\b(not interested|no thanks|no thank you|not looking|happy where i am|don'?t want)\b/i,
    /\b(nahi chahiye|interest nahi|dhoond nahi raha|abhi nahi)\b/i,
    /\b(vaddu|interest ledu|chudatledu|ippudu vaddu)\b/i,
  ],
  alreadyJoined: [
    /\b(already joined|i have joined|accepted an offer|offer accept|new job|joined another)\b/i,
    /\b(join kar liya|offer le liya|naukri lag)\b/i,
    /\b(join ayyanu|offer teesukunna|vere company)\b/i,
  ],
  interested: [
    /\b(yes|yeah|yep|sure|interested|definitely|okay|ok|go ahead|tell me more|sounds good)\b/i,
    /\b(haan|han|ji|bilkul|theek|thik hai|batao|boliye|zaroor)\b/i,
    /\b(avunu|sare|sarey|cheppandi|ok andi|baagundi|interest undi)\b/i,
  ],
  no: [
    /\b(no|nope|nah|not really)\b/i,
    /\b(nahi|nahin|na)\b/i,
    /\b(kaadu|ledu|ledhu|vaddu)\b/i,
  ],
  question: [
    /\?\s*$/,
    /\b(what is|what'?s|which company|who is the client|tell me about|how much|how many|where is|when is|can you tell)\b/i,
    /\b(kya hai|kaun si company|kitna|kahan|kab|kaise)\b/i,
    /\b(enti|emiti|ekkada|eppudu|entha|ela)\b/i,
  ],
  repeat: [
    /\b(pardon|come again|repeat|say that again|didn'?t (hear|catch|get))\b/i,
    /\b(can'?t hear|cannot hear|can not hear|not audible|breaking up|cutting out|bad line)\b/i,
    /\b(dobara|phir se|sunai nahi|awaaz)\b/i,
    /\b(malli cheppandi|vinipinchatledu|sound raavatledu)\b/i,
  ],
  hold: [
    /\b(one minute|one second|hold on|wait|just a moment|give me a minute)\b/i,
    /\b(ek minute|ek second|ruko|thehro)\b/i,
    /\b(oka nimisham|apandi|aagandi)\b/i,
  ],
  goodbye: [
    /\b(bye|goodbye|that'?s all|i have to go|hanging up|end the call)\b/i,
    /\b(theek hai bye|rakhta hoon|band kar)\b/i,
    /\b(veltanu|petestunna|bye andi)\b/i,
  ],
  abusive: [
    /\b(idiot|stupid|bloody|shut up|nonsense fellow)\b/i,
    /\b(bakwas band|chup kar)\b/i,
  ],
};

/**
 * @param {string} text
 * @returns {{intent:string, confidence:number, all:string[]}}
 *
 * intent is one of:
 *   wrong_number · do_not_contact · abusive · angry · busy · hold ·
 *   recruiter · already_joined · not_interested · question · repeat ·
 *   goodbye · interested · negative · statement · silence
 */
export function detectIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'silence', confidence: 1, all: ['silence'] };

  const all = [];
  for (const [name, patterns] of Object.entries(P)) {
    if (has(t, ...patterns)) all.push(name);
  }

  // The order the conversation must respect, not the order they matched.
  const PRIORITY = [
    'wrongNumber', 'doNotContact', 'abusive', 'angry', 'hold', 'busy',
    'recruiter', 'alreadyJoined', 'repeat', 'notInterested', 'goodbye',
    'question', 'interested', 'no',
  ];

  const MAP = {
    wrongNumber: 'wrong_number', doNotContact: 'do_not_contact', abusive: 'abusive',
    angry: 'angry', hold: 'hold', busy: 'busy', recruiter: 'recruiter',
    alreadyJoined: 'already_joined', repeat: 'repeat', notInterested: 'not_interested',
    goodbye: 'goodbye', question: 'question', interested: 'interested', no: 'negative',
  };

  for (const key of PRIORITY) {
    if (!all.includes(key)) continue;

    // "Yes, but I'm busy" - the qualifier is the real message.
    if (key === 'interested' && (all.includes('busy') || all.includes('notInterested'))) continue;

    return {
      intent: MAP[key],
      confidence: all.length === 1 ? 0.9 : 0.7,
      all: all.map((x) => MAP[x]),
    };
  }

  // Something was said, and it was not one of the above: it is an answer
  // to whatever was asked, which the state handler will read.
  return { intent: 'statement', confidence: 0.5, all: [] };
}

/**
 * Why they said no. Recorded so a recruiter can tell "wrong role" from
 * "not looking at all", which are completely different follow-ups.
 */
export function objectionReason(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(salary|package|ctc|paisa|money|pay|jeetham|jeetam|hike)\b/.test(t)) return 'SALARY';
  if (/\b(location|relocat|shift|city|door|dooram|jagaa|jagah)\b/.test(t)) return 'LOCATION';
  if (/\b(work from home|wfh|remote|office|hybrid|onsite)\b/.test(t)) return 'WORK_MODE';
  if (/\b(notice|serving|90 days|60 days|resign)\b/.test(t)) return 'NOTICE_PERIOD';
  if (/\b(joined|offer|another company|vere company)\b/.test(t)) return 'ALREADY_JOINED';
  if (/\b(not looking|happy here|settled|dhoond nahi|chudatledu)\b/.test(t)) return 'NOT_LOOKING';
  if (/\b(role|profile|technology|stack|domain|match|suit|fit)\b/.test(t)) return 'ROLE_MISMATCH';
  return 'OTHER';
}

/* ------------------------------------------------------------------ *
 * pulling facts out of what was said
 * ------------------------------------------------------------------ */

/** "9 LPA", "nine lakhs", "12,00,000", "15 lakh" -> rupees per year. */
export function parseMoney(text) {
  const t = String(text || '').toLowerCase().replace(/[,\s₹]/g, '');
  const m = /(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/lpa|lakh|lac|l\b/.test(t)) return Math.round(n * 100000);
  if (/cr|crore/.test(t)) return Math.round(n * 10000000);
  if (n < 1000) return Math.round(n * 100000);          // "9" means 9 LPA
  return Math.round(n);
}

/** "30 days", "immediate", "2 months", "60 rojulu", "ek mahina". */
export function parseNotice(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(immediate|immediately|right away|abhi|turant|ippude|ventane)\b/.test(t)) {
    return { label: 'Immediate', days: 0 };
  }
  if (/\b(serving|serve kar|notice lo|notice mein)\b/.test(t)) {
    const d = /(\d+)\s*(day|din|roju)/.exec(t);
    return { label: d ? `Serving, ${d[1]} days left` : 'Serving notice', days: d ? Number(d[1]) : null };
  }
  const months = /(\d+)\s*(month|months|mahina|mahine|nela|nelalu)/.exec(t);
  if (months) return { label: `${months[1]} months`, days: Number(months[1]) * 30 };
  const days = /(\d+)\s*(day|days|din|roju|rojulu)/.exec(t);
  if (days) return { label: `${days[1]} days`, days: Number(days[1]) };
  const bare = /\b(15|30|45|60|90)\b/.exec(t);
  if (bare) return { label: `${bare[1]} days`, days: Number(bare[1]) };
  return null;
}

/** A yes/no answer in any of the three languages. */
export function parseYesNo(text) {
  const t = String(text || '').toLowerCase();
  const yes = /\b(yes|yeah|yep|sure|ok|okay|fine|comfortable|no problem|haan|han|ji|theek|thik|bilkul|avunu|sare|sarey|parledu|ok andi)\b/.test(t);
  const no = /\b(no|nope|not|can'?t|cannot|difficult|problem|nahi|nahin|mushkil|kaadu|ledu|ledhu|vaddu|kastam)\b/.test(t);
  if (yes && !no) return true;
  if (no && !yes) return false;
  if (no && yes) return /\bnot\b|\bnahi\b|\bledu\b/.test(t) ? false : true;
  return null;
}
