// Structured logging: one JSON object per line on stdout/stderr, which both
// Vercel and Docker collect as-is. Never pass secrets, phone numbers or
// message text here; use ids and hashed addresses.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

/** Strips the Bitrix webhook token (and anything shaped like it) from text. */
export function redact(text) {
  return String(text).replace(/\/rest\/\d+\/[A-Za-z0-9]+/g, '/rest/***');
}

function write(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  if (line.err instanceof Error) {
    line.err = redact(line.err.message);
  } else if (line.err != null) {
    line.err = redact(line.err);
  }
  const out = JSON.stringify(line);
  (level === 'error' || level === 'warn' ? console.error : console.log)(out);
}

export const log = {
  debug: (msg, f = {}) => write('debug', msg, f),
  info: (msg, f = {}) => write('info', msg, f),
  warn: (msg, f = {}) => write('warn', msg, f),
  error: (msg, f = {}) => write('error', msg, f)
};
