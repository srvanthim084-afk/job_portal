/**
 * Which job board sent this, and how to read it.
 *
 * The intake understood Naukri and nothing else - the sender domains,
 * the subject patterns and the keywords were all Naukri's, so a Shine
 * response landing in the same mailbox scored too low to be looked at
 * and was filed as "not an application". A recruiter using both boards
 * saw half their candidates.
 *
 * Detection is by SENDER FIRST, because that is the fact that cannot be
 * faked by a candidate writing "Naukri" in their covering note. Subject
 * and body are the fallback for a forwarded message, where the original
 * sender is gone from the envelope.
 *
 * THE CAVEAT THAT USED TO BE HERE IS RESOLVED, and how it resolved is
 * worth keeping. It said the Shine shapes had never been tested because
 * no Shine message had been seen. That was wrong in the worst way: the
 * mailbox held seventeen of them, from recruiters@alerts.shine.com, and
 * every one had been filed as "No candidate name could be read from this
 * email". The detection here was never the problem - the sender matched
 * `.shine.com` all along - the problem was that a Shine response does
 * not label the candidate's name at all, so the labelled-block parser
 * this comment trusted had nothing to find. See `shine.js`, which reads
 * the real format, and the subject and body patterns below, which are
 * now the words Shine actually sends rather than the words its
 * documentation uses.
 *
 * Both boards are now `verified: true` against real mail.
 */

export const SOURCES = {
  naukri: {
    id: 'naukri',
    label: 'Naukri',
    verified: true,
    domains: ['naukri.com', 'infoedge.com', 'resdex.com'],
    subject: [
      'naukri', 'responses received', 'candidates applied',
      'application received', 'candidate applied', 'resume for',
    ],
    body: ['naukri', 'top candidates who applied', 'candidates applied to your job'],
  },
  shine: {
    id: 'shine',
    label: 'Shine',
    verified: true,
    // alerts.shine.com is the one that actually sends; it is matched by
    // the '.shine.com' suffix rule rather than listed twice.
    domains: ['shine.com', 'my.shine.com', 'shinemail.com', 'shinelearning.in'],
    subject: [
      // "Email Response-Hiring for Radiologist" is the real wording, and
      // it is the whole subject line - no board name in it anywhere,
      // which is why a forwarded one needs the body patterns below.
      'email response', 'email response-hiring for',
      'shine', 'new application', 'applied for', 'job application',
      'candidate response', 'applicant details',
    ],
    body: [
      'you have received an email response',
      'candidate profile is detailed below',
      'shine.com', 'shine job', 'applicant details', 'candidate details',
    ],
  },
};

const lc = (v) => String(v || '').toLowerCase();

/** The address inside "Name <a@b.c>". */
function addressOf(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return lc(m ? m[1] : from);
}

/**
 * Which board sent this message.
 *
 * @returns {{ id, label, verified, why }|null}
 */
export function detectSource(message) {
  const from = addressOf(message && message.from);
  const subject = lc(message && message.subject);
  const body = lc((message && (message.text || message.raw)) || '').slice(0, 20000);

  // The sender is the strongest signal and the hardest to fake.
  for (const key of Object.keys(SOURCES)) {
    const s = SOURCES[key];
    if (s.domains.some((d) => from.endsWith('@' + d) || from.endsWith('.' + d))) {
      return { ...s, why: `sent by ${from}` };
    }
  }

  /*
   * A forwarded message has the recruiter's own address on the envelope,
   * so the board only survives in the text. Two hits are required, not
   * one: a candidate who writes "I found this on Shine" in a covering
   * note is not a Shine response.
   */
  for (const key of Object.keys(SOURCES)) {
    const s = SOURCES[key];
    let hits = 0;
    if (s.subject.some((p) => subject.includes(p))) hits++;
    if (s.body.some((p) => body.includes(p))) hits++;
    if (s.domains.some((d) => body.includes(d))) hits++;
    if (hits >= 2) return { ...s, why: 'named in the subject and body' };
  }

  return null;
}

/**
 * The rules the existing classifier should use for this message.
 *
 * Merges the detected board's patterns into the defaults, so a Shine
 * email is scored against Shine's wording rather than Naukri's.
 */
export function rulesFor(source, defaults) {
  if (!source) return defaults;
  return {
    ...defaults,
    senderDomains: [...new Set([...(defaults.senderDomains || []), ...source.domains])],
    subjectPatterns: [...new Set([...(defaults.subjectPatterns || []), ...source.subject])],
    bodyKeywords: [...new Set([...(defaults.bodyKeywords || []), ...source.body])],
  };
}

/** Does this sync want this message? `all` wants everything. */
export function wantedBy(provider, source) {
  const want = lc(provider || 'all');
  if (!want || want === 'all') return true;
  return !!source && source.id === want;
}
