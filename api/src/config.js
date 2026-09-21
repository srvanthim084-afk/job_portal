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
  emailApiUrl: process.env.EMAIL_API_URL || 'https://api.resend.com/emails',
  emailFrom: process.env.EMAIL_FROM || '',

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
