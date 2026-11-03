# Backend standard

Runtime: Vercel functions in `api/` (Node 22, ESM), or `docker/serve.mjs` which loads the same files. Shared code lives in `lib/`.

## Layers
- `api/*.js` — one endpoint per file, wrapped in `route([methods], handler)`. Handler order: origin/auth, parse, validate, work, respond.
- `lib/http.js` — `route`, `fail`, `readJson`, `clean`. Every endpoint uses these, nothing parses bodies by hand.
- `lib/store.js` — the only code that touches Postgres (plain `pg`, parameterised queries only) plus session/IP helpers. In-memory fallback when no `DATABASE_URL` (dev only).
- `lib/bitrix.js` — CRM push, best effort; a CRM failure never fails the visitor.
- `lib/env.js`, `lib/log.js` — env validation, structured logging.

## Responses
Success: `200 { ok: true, ... }`. Failure: `{ ok: false, error: "snake_case_code" }`.
400 invalid input, 401 not signed in, 403 foreign origin, 405 wrong method (with `Allow`), 413 body over limit, 429 throttled, 500 unexpected, 503 dependency down or admin not configured.
Spam (honeypot, too-fast fill, links in message, duplicate) gets a quiet `200 { ok: true }` so bots learn nothing. Every response carries `X-Request-Id`, `Cache-Control: no-store`.

## Validation
All input is untrusted: size-capped (`readJson`), control characters stripped and length-capped (`clean`), phone 9-15 digits, email format, `lang` whitelisted, consent required. Unknown fields are ignored.

## Abuse protection
- Same-origin check (exact hostname) on every state-changing call. No CORS headers are sent: the API is not for other sites.
- Leads: honeypot, minimum fill time, link filter, 10-minute duplicate, 5 per hour per hashed IP (stored in the DB so it spans serverless instances).
- Login: 8 failures per 15 min per IP and 60 globally, constant-time password compare, HMAC session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` on Vercel, 12 h). Changing `ADMIN_PASSWORD` signs everyone out.
- IPs are stored only as salted HMAC hashes. Behind Docker without a proxy `X-Forwarded-For` is client-controlled, so put a trusted proxy in front.

## Admin
`/admin` (admin.html) is a static shell with `noindex`; it contains no data. All data comes from `/api/leads`, which returns 401 without a valid cookie. Admin output is HTML-escaped; CSV cells are protected against formula injection.

## Config
All through env vars (see `.env.example`); nothing secret is committed. `lib/env.js` checks them at first request and logs problems; `/api/health` reports `config: ok|invalid`. In production `DATABASE_URL`, `ADMIN_PASSWORD`, `ADMIN_SECRET` (32+ chars) are required.

## Logging
`log.info|warn|error(msg, fields)` writes one JSON line. Never log phone numbers, message text, cookies or webhook URLs; use lead id, request id (`rid`) and hashed IP. `LOG_LEVEL` filters.

## Health
`GET /api/health` -> `{ ok, db: up|memory|down, crm, config, time }`; 503 only when the database is unreachable.

## Database
Parameterised queries, `statement_timeout` 10 s, pool of 2 per instance, indexes for every filter (`created_at`, `ip_hash`). Schema is created idempotently on first use after a lock-free catalog check. For real migrations use a direct (non-pooled) connection string.

## Tests
`npm test` (no DB needed) covers validation, origin checks, spam gates, rate limits, auth and health. CI runs it with `npm run check:seo`.
