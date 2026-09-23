/**
 * Configuration — every secret comes from the environment (requirement 21).
 * Nothing here has a hardcoded credential, and the server refuses to start
 * in production if a required secret is missing or left at its placeholder.
 */
import 'dotenv/config';

const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

export const config = {
  env,
  isProd,
  port: int(process.env.PORT, 8080),

  databaseUrl: process.env.DATABASE_URL || '',
  dbPoolMax: int(process.env.DB_POOL_MAX, 10),
  // optional privilege drop per connection — see db.js
  dbRole: process.env.DB_ROLE || '',
  dbSsl: bool(process.env.DB_SSL, false),

  // session cookie
  authSecret: process.env.AUTH_SECRET || '',
  sessionCookie: process.env.SESSION_COOKIE || 'tl_session',
  sessionDays: int(process.env.SESSION_DAYS, 7),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),

  // where the browser loads the app from — used for CORS + CSRF origin checks
  publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:8080',
  extraOrigins: (process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

  // file storage
  storageDriver: process.env.STORAGE_DRIVER || 'local',   // 'local' | 'supabase'
  storageLocalDir: process.env.STORAGE_LOCAL_DIR || './var/uploads',
  storageUrl: process.env.STORAGE_URL || '',
  storageKey: process.env.STORAGE_KEY || '',              // service key — server only
  storageBucket: process.env.STORAGE_BUCKET || 'resumes',
  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),

  // Outbound providers. All optional: an unconfigured channel reports
  // 'not_configured' rather than pretending to have delivered anything.
  emailApiKey: process.env.EMAIL_API_KEY || '',

  // SMTP. Most company mailboxes are SMTP, not an HTTP API - a host, a
  // port, a mailbox and its password. When a host is set, SMTP is used and
  // EMAIL_API_KEY is ignored.
  smtpHost: process.env.EMAIL_SMTP_HOST || '',
  smtpPort: int(process.env.EMAIL_SMTP_PORT, 465),
  // Port 465 is implicit TLS; 587 is STARTTLS, which nodemailer negotiates
  // when `secure` is false.
  smtpSecure: process.env.EMAIL_SMTP_SECURE
    ? process.env.EMAIL_SMTP_SECURE === 'true'
    : int(process.env.EMAIL_SMTP_PORT, 465) === 465,
  smtpUser: process.env.EMAIL_SMTP_USER || '',
  smtpPass: process.env.EMAIL_SMTP_PASS || '',
  emailApiUrl: process.env.EMAIL_API_URL || 'https://api.resend.com/emails',
  emailFrom: process.env.EMAIL_FROM || '',
  // What the recipient sees in their inbox instead of a bare address.
  // "TeamLink Job Portal <jobs@...>" is read as a company; the address on
  // its own is read as a robot, and treated accordingly.
  emailFromName: process.env.EMAIL_FROM_NAME || '',

  /* ---- EmailJS -------------------------------------------------- *
   *
   * EmailJS is designed to be called from a browser, which is why its
   * "public key" is public. Calling it from the server instead buys three
   * things the browser path cannot: one configuration for everybody
   * rather than per-browser localStorage, a delivery row for every send
   * alongside every other channel, and the same message templates the
   * rest of the system uses.
   *
   * The service id, template id and public key are all client-safe by
   * EmailJS's own design, so they are also served to the screens that
   * still send from the browser. The PRIVATE key is not, and is only ever
   * read here.
   * ---------------------------------------------------------------- */
  emailjs: {
    serviceId:  process.env.EMAILJS_SERVICE_ID || '',
    templateId: process.env.EMAILJS_TEMPLATE_ID || '',
    publicKey:  process.env.EMAILJS_PUBLIC_KEY || '',
    // Needed only when the EmailJS account has API calls in strict mode.
    privateKey: process.env.EMAILJS_PRIVATE_KEY || '',
    apiUrl: process.env.EMAILJS_API_URL || 'https://api.emailjs.com/api/v1.0/email/send',
  },

  // IVR. An automated call placed to the candidate at each stage,
  // alongside the written channels. IVR_FROM is the number the call
  // appears to come from. 'ivr' is the channel name notification_deliveries
  // already allows (0006), and what the prototype called it.
  /* ---- the AI calling agent ------------------------------------- *
   *
   * A conversation on the phone, not the one-way IVR announcement above.
   * Every value is read from the environment: nothing here has a default
   * that would place a real call, and no key is ever sent to the browser.
   *
   * With no provider configured the agent runs on the `local` driver -
   * the real conversation engine, the real database writes and the real
   * ATS updates, with HTTP standing in for the carrier's audio. Adding
   * credentials is the only change needed to make the calls real.
   * ---------------------------------------------------------------- */
  telephony: {
    provider: process.env.TELEPHONY_PROVIDER || 'local',   // local | twilio | exotel
    accountSid: process.env.TELEPHONY_ACCOUNT_SID || '',
    authToken:  process.env.TELEPHONY_AUTH_TOKEN || '',
    fromNumber: process.env.TELEPHONY_FROM_NUMBER || '',
    ringTimeout: int(process.env.TELEPHONY_RING_TIMEOUT, 30),
    // Twilio signs a webhook over the PUBLIC url. Behind a proxy the
    // request's own host is the internal one, and the signature will not
    // match unless the public base is stated here.
    publicWebhookBase: process.env.TELEPHONY_PUBLIC_BASE || '',
    webhookSecret: process.env.TELEPHONY_WEBHOOK_SECRET || '',
    exotelSid:   process.env.EXOTEL_SID || '',
    exotelKey:   process.env.EXOTEL_API_KEY || '',
    exotelToken: process.env.EXOTEL_API_TOKEN || '',
    // How many calls one campaign may have in flight at once.
    concurrency: int(process.env.AI_CALL_CONCURRENCY, 3),
  },
  stt: {
    apiUrl: process.env.STT_API_URL || '',
    apiKey: process.env.STT_API_KEY || '',
  },
  tts: {
    apiUrl: process.env.TTS_API_URL || '',
    apiKey: process.env.TTS_API_KEY || '',
    voice:  process.env.TTS_VOICE || '',
  },

  ivrApiKey: process.env.IVR_API_KEY || '',
  ivrApiUrl: process.env.IVR_API_URL || '',
  ivrFrom: process.env.IVR_FROM || '',
  ivrLanguage: process.env.IVR_LANGUAGE || 'en-IN',

  smsApiKey: process.env.SMS_API_KEY || '',
  smsApiUrl: process.env.SMS_API_URL || '',
  smsSenderId: process.env.SMS_SENDER_ID || '',

  whatsappApiKey: process.env.WHATSAPP_API_KEY || '',
  whatsappApiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0',
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',

  // Naukri employer API access is granted per account; there is no open
  // endpoint to default to, so this stays blank until you have one.
  naukriApiUrl: process.env.NAUKRI_API_URL || '',
  naukriApiKey: process.env.NAUKRI_API_KEY || '',
  naukriEmployerId: process.env.NAUKRI_EMPLOYER_ID || '',

  aiApiKey: process.env.AI_API_KEY || '',

  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 300),
  loginRateLimitMax: int(process.env.LOGIN_RATE_LIMIT_MAX, 10),

  trustProxy: bool(process.env.TRUST_PROXY, false),
};

/** Placeholders from .env.example must never survive into production. */
const PLACEHOLDERS = ['', 'changeme', 'change-me', 'replace-me', 'your-secret-here', 'xxx'];

/**
 * Is this browser Origin allowed to make a state-changing request?
 *
 * ONE definition, used by both the CORS layer and the CSRF guard. They
 * enforce different things - who may read a response, and who may write -
 * but they must agree on who is trusted, and two copies of a rule like that
 * drift. They already had: relaxing CORS alone left writes failing with
 * CSRF_FAILED, which reads as a broken app rather than a blocked origin.
 *
 * In production this is exactly PUBLIC_ORIGIN plus EXTRA_ORIGINS - nothing
 * else, whatever it claims to be.
 *
 * Outside production any loopback origin is also accepted, so the standalone
 * export works from whatever static server a developer already has running
 * (:5183, :5500, :8000) against the API on its own port. A loopback origin
 * is a page already running on this machine; it is not a stranger's site.
 */
export const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function originAllowed(origin) {
  if (!origin) return true;                       // same-origin sends no Origin
  if (origin === config.publicOrigin) return true;
  if (config.extraOrigins.includes(origin)) return true;
  return !config.isProd && LOOPBACK_ORIGIN.test(origin);
}

export function assertConfig() {
  const problems = [];

  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (PLACEHOLDERS.includes(config.authSecret.toLowerCase()))
    problems.push('AUTH_SECRET is missing or still a placeholder');
  else if (config.authSecret.length < 32)
    problems.push('AUTH_SECRET must be at least 32 characters');

  if (config.storageDriver === 'supabase') {
    if (!config.storageUrl) problems.push('STORAGE_URL is required when STORAGE_DRIVER=supabase');
    if (!config.storageKey) problems.push('STORAGE_KEY is required when STORAGE_DRIVER=supabase');
  }

  if (config.isProd) {
    if (config.publicOrigin.startsWith('http://') && !config.publicOrigin.includes('localhost'))
      problems.push('PUBLIC_ORIGIN must be https in production (session cookies are Secure)');
    if (config.bcryptRounds < 10)
      problems.push('BCRYPT_ROUNDS must be at least 10');
  }

  if (problems.length) {
    throw new Error('Configuration errors:\n  - ' + problems.join('\n  - '));
  }
}
