// Environment validation. Reads process.env lazily so tests can change it.
// Returns problems instead of throwing: a missing optional setting must not
// take the public site down, but it is reported in logs and /api/health.

export function checkEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = Boolean(env.VERCEL) || env.NODE_ENV === 'production';

  const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || '';
  if (!dbUrl) (prod ? errors : warnings).push('DATABASE_URL is not set: leads are kept in memory only');
  else if (!/^postgres(ql)?:\/\//i.test(dbUrl)) errors.push('DATABASE_URL must start with postgres:// or postgresql://');

  if (!env.ADMIN_PASSWORD) (prod ? errors : warnings).push('ADMIN_PASSWORD is not set: the admin panel cannot be opened');
  else if (prod && env.ADMIN_PASSWORD.length < 12) warnings.push('ADMIN_PASSWORD is shorter than 12 characters');

  if (!env.ADMIN_SECRET) (prod ? errors : warnings).push('ADMIN_SECRET is not set: session cookies and IP hashes use a weak fallback');
  else if (prod && env.ADMIN_SECRET.length < 32) warnings.push('ADMIN_SECRET is shorter than 32 characters');

  if (env.BITRIX_WEBHOOK_URL && !/^https:\/\/.+\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(env.BITRIX_WEBHOOK_URL)) {
    warnings.push('BITRIX_WEBHOOK_URL does not look like https://portal/rest/<user>/<token>/');
  }
  if (env.BITRIX_ASSIGNED_BY_ID && !/^\d+$/.test(env.BITRIX_ASSIGNED_BY_ID)) {
    warnings.push('BITRIX_ASSIGNED_BY_ID must be a number');
  }
  return { ok: errors.length === 0, errors, warnings };
}

let reported = false;
/** Logs the findings once per process. */
export function reportEnvOnce(log) {
  if (reported) return;
  reported = true;
  const r = checkEnv();
  for (const e of r.errors) log.error('env', { problem: e });
  for (const w of r.warnings) log.warn('env', { problem: w });
}
