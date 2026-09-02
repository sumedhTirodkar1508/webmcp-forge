# Deploy WebMCP Forge

## Forge application

Deploy the repository to Vercel as a Next.js application. Set these production
environment variables before deploying:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Postgres transaction-pooler connection, normally port 6543 |
| `DIRECT_URL` | Direct Postgres connection, normally port 5432 |
| `GEMINI_API_KEY` | Gemini API key used during scan setup |
| `GEMINI_SEMANTIC_PRIMARY_MODEL` | Preferred semantic-mapping Gemini model |
| `GEMINI_SEMANTIC_FALLBACK_1_MODEL`, `GEMINI_SEMANTIC_FALLBACK_2_MODEL` | Ordered semantic-mapping fallbacks |
| `GEMINI_NL_DEMO_MODEL` | Model used by the optional natural-language demo |
| `GEMINI_NL_DEMO_MAX_QUESTIONS` | Server-enforced demo-question limit |
| `GEMINI_MAX_RETRIES_PER_MODEL`, `GEMINI_REQUEST_TIMEOUT_MS` | Bounded retry and per-model timeout controls |
| `APP_BASE_URL` | Canonical deployed Forge origin, for example `https://forge.example.com` |
| `SCAN_MAX_PAGES` | Bounded same-origin page budget (default `10`) |
| `SCAN_REQUEST_TIMEOUT_MS` | Scanner request timeout in milliseconds |
| `VERIFICATION_CHALLENGE_TTL_SECONDS` | Installation-check challenge lifetime |

Do not set browser-exposed database or Gemini values. Supabase Auth credentials
are not used by this application. Keep all production values in Vercel's
encrypted environment settings; `.env.example` contains placeholders only.

Before the first production release, run migrations against the direct database
connection:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:deploy
```

The build runs Prisma generation and creates the public runtime bundle. A
successful deploy should serve `/runtime/v1.js` and the application routes from
the same Forge origin.

## Demo portfolio

`examples/demo-portfolio` is intentionally a separate static site. Create a
second Vercel project with that directory as its Root Directory. Its
`vercel.json` is self-contained; it has no dependencies and no Forge script.
After it is deployed, paste its public URL into Forge for the contest demo.

## Ownership and verification notes

Anonymous ownership uses an HttpOnly browser cookie. A localhost owner session
does not transfer to the production Forge origin, so create or claim the demo
site again after moving from local development to production. Installation
verification requires the published portfolio's HTTPS origin and a fresh,
single-use challenge opened from the builder.
