# WebMCP Forge

**Turn an existing portfolio website into one that AI agents can actually use — without writing any code.**

WebMCP Forge scans a portfolio, works out where its content lives, and generates a single `<script>` tag. Once that tag is installed, the site exposes real [WebMCP](https://webmachinelearning.github.io/webmcp/) tools — `list_projects`, `get_profile`, `search_projects` and friends — that a WebMCP-capable browser agent can discover and call.

And WebMCP Forge is itself agent-operable: the builder registers its *own* WebMCP tools, so an agent can scan a site, adjust what agents are allowed to do, and generate the installation — while the interface updates in front of you.

> **Use WebMCP to build WebMCP.**

MIT licensed. Built with Next.js 16, TypeScript, Prisma 7, Postgres and the Google Gemini API.

---

## The problem

An AI agent visiting a portfolio site today has to do what a screen-scraper does: guess at the DOM, hope the class names mean something, and re-guess after every redesign. It works badly and breaks constantly.

WebMCP fixes this at the standards level — a site can *declare* what it offers, and the browser hands those declarations to the agent. But the API is JavaScript, aimed at developers.

Portfolio owners are mostly not developers. They are designers on Framer, Wix and Webflow who cannot add `document.modelContext.registerTool(...)` to their site, and shouldn't have to.

WebMCP Forge closes that gap. The person using it never sees `document.modelContext`, a JSON Schema, a CSS selector, a route pattern, or a model id.

## Who it's for

Designers and other non-technical portfolio owners on **Framer**, **Wix**, **Webflow**, **Squarespace**, or a custom-built site.

## The workflow

```
paste your URL → scan → review what was found → choose what agents may do
              → generate one script tag → install it → check installation → agent-ready
```

Five steps. No account, no signup.

---

## How it works

```
                     ┌──────────────────────────────────────────┐
   BUILDER           │  WebMCP Forge (Next.js, Vercel)          │
   (this app)        │                                          │
                     │  ┌────────────┐   ┌──────────────────┐   │
   browser ─────────▶│  │  services  │──▶│ Postgres (Prisma)│   │
   (or a WebMCP      │  └─────┬──────┘   └──────────────────┘   │
    agent, via the   │        │                                 │
    builder's own    │        ├──▶ scanner  fetch + Cheerio     │
    registered       │        │            (SSRF-guarded)       │
    tools)           │        └──▶ Gemini   semantic mapping    │
                     │                      (setup only)        │
                     └───────────────┬──────────────────────────┘
                                     │  published config (public, read-only)
                                     ▼
                     ┌──────────────────────────────────────────┐
   PORTFOLIO         │  the owner's actual website              │
                     │  <script src=".../runtime/v1.js">        │
                     │        │                                 │
                     │        ├─▶ reads the LIVE DOM            │
                     │        └─▶ document.modelContext          │
                     │              .registerTool(...)          │
                     └──────────────────────────────────────────┘
                                     ▲
                                     │  no Gemini. no callback. no network.
                              a WebMCP agent
```

### 1. Scan — trusted server, deterministic first

The scanner is plain server-side `fetch` + [Cheerio](https://cheerio.js.org/). It crawls up to `SCAN_MAX_PAGES` (default 10) same-origin pages, prioritising the ones that matter — home, work index, about, a couple of representative project pages, contact — and caps how many pages any one route shape may consume, so forty project pages cannot eat the whole budget.

It then extracts, deterministically: title, meta, Open Graph, JSON-LD, navigation, headings, sections, contact signals, platform fingerprints, and — the important part — **repeated DOM structures**. A grid of project cards, a list of skills, a timeline of roles all look the same structurally, and the scanner emits each as a *candidate group* with a verified CSS selector and discovered fields.

There is deliberately **no headless browser in production**. See [Limitations](#limitations).

### 2. Interpret — Gemini chooses, it never authors

One Gemini request per scan, normally.

The model receives a compact JSON view of the scan — never raw HTML — and answers with *references*: a page URL, a candidate group id (`g1`, `g2`), and which of that group's discovered field names plays which role.

**The model never emits a selector.** Every selector in a published configuration was produced and verified by our own Cheerio extraction against the real document. There is no field anywhere in the pipeline into which a model could place executable code, and selectors are only ever passed to `querySelectorAll` — never to `innerHTML`, `eval`, or a `Function` constructor. The worst a confused or adversarial model can do is point at the wrong list.

Everything the model returns is validated with Zod even though structured-output mode is used — schema compliance is not semantic correctness, and it is not a guarantee of schema compliance either.

If Gemini is unconfigured or every model fails, the scan still succeeds using a heuristic mapping, and says so.

### 3. Configure — structure, not content

WebMCP Forge does **not** copy a portfolio's content into its database. It stores *how to find* the content: item selectors, field selectors, route patterns, and the counts observed at scan time (for diagnostics).

Configurations are **immutable and versioned**. Publishing points the site at one version; changing a toggle and publishing again creates a new row. Only the published version is ever served publicly.

### 4. Install — one script, forever

```html
<script
  defer
  src="https://your-forge-domain/runtime/v1.js"
  data-wmf-site="wmf_XXXXXXXXXXXXXXXXXXXXXXXX">
</script>
```

Installed once. Changing capabilities later never requires touching the website again — everything variable lives behind the configuration endpoint the runtime fetches.

The runtime is framework-free browser JavaScript, ~21 kB minified. No React, no injected UI, no dependencies. Authored in TypeScript so it can share types and be unit-tested, bundled with esbuild.

### 5. Execute — live DOM, zero AI

This is the design decision the whole product rests on:

> **Gemini runs during setup. It never runs when an agent invokes a tool.**

A tool call reads the page's DOM *at invocation time* through the stored mappings. Nothing is fetched, nothing is sent back to WebMCP Forge, and no model is consulted.

The practical consequence:

```
Monday:  portfolio has 7 elements matching .project-card
         list_projects() → 7 projects

Tuesday: the owner adds an eighth project using the same markup
         list_projects() → 8 projects
```

No re-scan. No new configuration. No API call. That behaviour is covered by an explicit test.

---

## Actual WebMCP

Tools are registered against the real browser API, as specified in the [W3C WebMCP draft](https://webmachinelearning.github.io/webmcp/):

```js
await document.modelContext.registerTool(
  {
    name: "list_projects",
    title: "Browse my projects",
    description: "...",
    inputSchema: { /* JSON Schema */ },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input, { signal }) => ({ content: [{ type: "text", text }] }),
  },
  { signal },
);
```

Nothing is polyfilled or simulated. Every experimental type and the single unavoidable cast live in one compatibility module, `src/lib/webmcp/`; nothing else in the codebase touches `document.modelContext`. If the browser doesn't implement it, feature detection reports that plainly and the builder shows an unavailable state — it never claims a false success.

WebMCP is `[SecureContext]`, so it requires HTTPS. `http://localhost` counts as secure, which is why local development works.

### The capability catalogue

Ten fixed, generic capabilities. Tool names are **never** site-specific — no `get_sqratch`, no `get_nike_project`. The same runtime works unmodified on every portfolio.

| Tool | What the owner sees | Read-only |
|---|---|---|
| `get_profile` | Learn about me | ✅ |
| `list_projects` | Browse my projects | ✅ |
| `get_project` | Inspect a project | ✅ |
| `search_projects` | Search projects | ✅ |
| `get_skills` | Show my skills | ✅ |
| `get_experience` | Read my experience | ✅ |
| `get_education` | Read my education | ✅ |
| `get_contact_info` | Share contact information | ✅ |
| `navigate_site` | Navigate my portfolio | ❌ |
| `focus_project` | Focus a project | ❌ |

`navigate_site` and `focus_project` change what the visitor is looking at. They mutate no database state, but marking them `readOnlyHint: true` would be a lie to the agent, so they aren't.

Every capability sets `untrustedContentHint: true` — everything returned came out of a third-party page's DOM.

**No destructive actions.** The MVP does not submit contact forms, send email, make purchases, delete anything, or mutate an account. That is a deliberate boundary, not an oversight.

### Use WebMCP to build WebMCP

The builder page registers its own tools: `set_target_url`, `scan_site`, `get_scan_summary`, `get_capabilities`, `set_capability_enabled`, `generate_installation`, `get_installation_instructions`, `get_verification_status`.

An agent can hold this conversation:

> "Scan my portfolio." · "What did you find?" · "Turn off contact information." · "Generate the integration."

…and the interface visibly updates as it goes.

The architectural rule that makes this real: **there is no separate implementation for agents.** A tool handler calls the same action a button calls, which hits the same API route, which calls the same service. The UI updates because it is the same state — not because anything is animated to look busy.

---

## Verification is real

"Check Installation" does not read a database flag. It requires the runtime on the actual portfolio to report back:

1. The builder mints a cryptographically random, single-use challenge. **Only its SHA-256 hash is stored.**
2. The portfolio opens in a new tab with the raw challenge in a URL parameter.
3. The installed runtime sees verification mode, gathers diagnostics, and POSTs them to a narrow cross-origin endpoint.
4. The endpoint checks the hash, the expiry, the public site id, and the **browser-asserted `Origin` header** — which the browser sets and page script cannot forge, so it proves the report came from a page genuinely served by that site.
5. The challenge is consumed with an atomic conditional update. A replay finds it already consumed. A concurrent replay updates zero rows and loses.
6. A *failed* check does not burn the challenge — otherwise anyone could deny an owner their verification by firing junk at the endpoint.

The result is an honest checklist:

```
Agent runtime installed        ✓  version 1.0.0
Configuration loaded           ✓  version 3
Live content mappings          ✓
WebMCP available               ⚠  this browser doesn't support document.modelContext yet
7 tools registered             ✓
8 projects found on the page   ✓
```

If the browser has no WebMCP, that's a **warning, not a fake pass** — the installation is correct, the browser simply doesn't implement the API yet. If nothing reports back before the timeout, that's a real failure with real troubleshooting steps.

### Change detection

On-demand only. No cron jobs, no monitoring service, no email. Comparing the last two verification runs is enough:

- `7 → 8 projects` — content grew, mappings healthy.
- `.project-card` matched 7, now matches 0 — mapping broken, offer a re-scan.

---

## Security

Security here is implementation, not documentation. The boundaries below have tests.

### SSRF

The scanner fetches arbitrary user-supplied URLs from a trusted server, which is exactly how a server becomes an attacker's proxy. Defences stack:

- **Scheme** — `http:` and `https:` only.
- **Credentials** — URLs with a username or password are refused.
- **Hostnames** — `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, and cloud-metadata hosts are blocked.
- **IP ranges** — every IPv4 private/reserved block (`10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, CGNAT, multicast, reserved…) and IPv6 equivalent (`::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`…). IPv4-mapped IPv6 is unwrapped and re-checked, so `::ffff:127.0.0.1` is blocked. Unparseable addresses fail closed.
- **Ports** — 80, 443 and ordinary high ports only; privileged ports and a deny-list of well-known service ports (Postgres, Redis, MongoDB, Elasticsearch, memcached…) are refused.
- **DNS rebinding** — this is the interesting one. Requests go through an `undici` `Agent` whose `connect.lookup` is ours. Every resolved address is validated **at the moment the socket is opened**, and the lookup fails outright if any address is unsafe. Because that is the same resolution the connection then uses, there is no time-of-check/time-of-use window — unlike validating with a separate `dns.lookup` and hoping `fetch` re-resolves to the same answer.
- **Redirects** — followed manually, with every hop re-run through the full check. A public host cannot bounce the scanner to a private one.
- **Bounds** — request timeout, redirect limit, content-type check, and a streaming byte cap that abandons the response rather than buffering it.

Nothing fetched is ever executed. It is only parsed as text.

### Anonymous ownership

No signup. The first operation that needs an owner mints a 256-bit random bearer token, hands the **raw token to the browser in an HttpOnly cookie**, and stores **only its SHA-256 digest**.

- The browser can never read it from JavaScript. It is never in `localStorage`.
- A database dump yields nothing replayable.
- `SameSite=Lax`, `Secure` in production, sliding 30-day expiry.
- Every private operation re-checks ownership server-side. A site id from the browser is never trusted.
- "Not found" and "not yours" return **identical** responses, so a stranger cannot probe which site ids exist.

An unsalted digest is right here: unlike a password, the token is 256 bits of uniform randomness, so there is no dictionary to run.

### Public / private boundary

```
private:  browser → route handler → session ownership check → Postgres
public:   portfolio → published config only (never a draft)
verify:   portfolio runtime → one-time challenge → narrow CORS
```

The browser never queries the database directly. The public payload is built **field by field** — spreading a row into a public response is precisely how private data leaks — and a test asserts its keys against an allow-list, so a newly added field cannot leak by being forgotten.

### Other

- **CORS** — narrowly scoped. Each public response echoes the *one* origin that site was published for, never `*`, with `Vary: Origin`. Credentials are never allowed.
- **CSRF** — `SameSite=Lax` plus an explicit `Origin` check on every mutating route.
- **Cost abuse** — anonymous endpoints that spend Gemini quota are capped per session per hour, and the natural-language demo's limit is enforced against a database ledger, not a browser counter.
- **Untrusted content** — everything extracted from a third-party page is treated as data and flagged `untrustedContentHint`.
- **Errors** — a stable code taxonomy; unexpected failures collapse to `INTERNAL`. No stack trace ever reaches a user.
- **Logging** — structured, with key-based redaction of anything matching key/token/secret/password/challenge.

---

## Why Supabase but not Supabase

Supabase is used **purely as hosted Postgres**. Deliberately not used:

- ❌ Supabase Auth — ownership is our own anonymous session model
- ❌ the Supabase Data API — no PostgREST
- ❌ browser-side `supabase-js` — the browser never touches the database
- ❌ RLS as the security boundary — authorisation is explicit server-side checks

So none of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is required. All database access is trusted server code, and **no database credential ever reaches the browser**.

---

## Gemini model chain

Configured entirely through environment variables — no model id is hardcoded.

```
primary     GEMINI_SEMANTIC_PRIMARY_MODEL       gemini-3.7-flash
fallback 1  GEMINI_SEMANTIC_FALLBACK_1_MODEL    gemini-3.5-flash-lite
fallback 2  GEMINI_SEMANTIC_FALLBACK_2_MODEL    gemini-3.1-flash-lite
demo        GEMINI_NL_DEMO_MODEL                gemini-3.5-flash-lite
```

| Failure | Response |
|---|---|
| timeout / network / 5xx | retry the same model once, with exponential backoff + full jitter |
| short-term 429 | retry the same model once, honouring `Retry-After` (including Google's `"34s"` duration form), clamped |
| quota exhausted | move to the next model immediately — no retry, no sleep |
| malformed or schema-invalid output | one corrective retry on that model, then move on |
| 400 / 401 / 403 | **stop the whole chain** — a bad key or malformed request fails identically everywhere, so burning the fallbacks wastes quota for nothing |

Bounded by construction: at most 2 attempts per model normally, never more than 3, never more than `3 × models.length` overall. There is a test asserting exactly that.

Every attempt is recorded in `ai_usage_events` with model, attempt number, status, a coarse error classification, and latency. Provider error bodies are never stored.

---

## Local development

**Requirements:** Node 24 (`.node-version`), pnpm 10, a Postgres database, and optionally a Gemini API key.

```bash
pnpm install
cp .env.example .env.local     # then fill in real values
pnpm db:migrate                # applies prisma/migrations
pnpm dev                       # http://localhost:3000
```

`pnpm dev` does not bundle the browser runtime. Run it once, or watch it:

```bash
pnpm build:runtime             # → public/runtime/v1.js
pnpm build:runtime:watch
```

### Environment variables

Every variable is server-only. None is `NEXT_PUBLIC_`. See `.env.example` for the full annotated list.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | runtime connection (pooled) |
| `DIRECT_URL` | migrations (session mode) |
| `GEMINI_API_KEY` | optional; without it, scans use the heuristic mapping |
| `GEMINI_SEMANTIC_*_MODEL` | the model chain |
| `GEMINI_NL_DEMO_MODEL`, `GEMINI_NL_DEMO_MAX_QUESTIONS` | the demo and its hard cap |
| `APP_BASE_URL` | the origin the installation snippet points at |
| `SCAN_MAX_PAGES`, `SCAN_REQUEST_TIMEOUT_MS`, `SCAN_MAX_HTML_BYTES`, `SCAN_MAX_REDIRECTS` | scanner bounds |
| `SCAN_MAX_PER_SESSION_PER_HOUR` | anti-abuse |
| `VERIFICATION_CHALLENGE_TTL_SECONDS` | challenge lifetime |

Older variable names (`NEXT_PUBLIC_APP_URL`, `GEMINI_PRIMARY_MODEL`, …) are still accepted as documented aliases; the canonical name always wins.

### Commands

```bash
pnpm dev                 # dev server
pnpm build               # bundle the runtime, generate Prisma, build Next
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint
pnpm test                # vitest
pnpm test:coverage

pnpm db:migrate          # create + apply a migration (development)
pnpm db:migrate:deploy   # apply migrations (production / CI)
pnpm db:status
pnpm db:generate
pnpm db:studio
```

Migrations are version-controlled under `prisma/migrations`. `prisma db push` is **not** the migration strategy, and application DDL is never pasted into the Supabase SQL editor.

### Tests

Unit suites run anywhere. The integration suites — anonymous ownership, verification replay, the public/private boundary — run against the real database and **skip cleanly** when `DATABASE_URL` is absent, so a checkout without secrets still passes.

They use a real database on purpose: the thing under test is that a query scoped to one session cannot reach another session's row, and a stubbed Prisma would only prove the stub agrees with itself.

---

## Deploying

Vercel, with these environment variables set in the project:

```
DATABASE_URL
DIRECT_URL
GEMINI_API_KEY
GEMINI_SEMANTIC_PRIMARY_MODEL
GEMINI_SEMANTIC_FALLBACK_1_MODEL
GEMINI_SEMANTIC_FALLBACK_2_MODEL
GEMINI_NL_DEMO_MODEL
GEMINI_NL_DEMO_MAX_QUESTIONS
APP_BASE_URL          ← the deployed https:// origin, not localhost
SCAN_MAX_PAGES
VERIFICATION_CHALLENGE_TTL_SECONDS
```

Apply migrations against the production database:

```bash
DIRECT_URL="postgresql://…" pnpm db:migrate:deploy
```

`pnpm build` bundles the runtime and generates the Prisma client, so no extra build step is needed.

---

## Limitations

**Client-rendered sites.** The scanner reads the HTML a server returns. A site that renders everything in JavaScript will scan poorly, and WebMCP Forge says so rather than quietly failing:

> *This site appears to render significant content in the browser. WebMCP Forge could only inspect the HTML your server returned.*

A headless browser would paper over this at the cost of a heavyweight production dependency and a much larger attack surface. That trade wasn't worth making for the MVP.

**DNS rebinding.** The scanner validates addresses in the `undici` lookup used for the actual connection, rather than trusting a separate preflight lookup. This covers the scanner's DNS-resolution boundary; as with any outbound-fetch service, its network policy should be reviewed again if the HTTP client or deployment network changes.

**WebMCP browser support.** WebMCP is a draft. Where the browser lacks `document.modelContext`, everything else — installation, configuration, verification — still works, and availability is reported honestly as unavailable.

**Cross-origin tool testing.** A page cannot invoke `document.modelContext.executeTool` on another origin's document. So the builder cannot genuinely execute a tool on your portfolio, and it does not pretend to:

- The runtime exposes `window.__webmcpForge.invokeViaWebMcp(name, input)`, which goes through the browser's real WebMCP machinery on the portfolio page. **That is genuine agent-path invocation.**
- It also exposes `invokeHandlerDirectly(name, input)`, which calls the handler directly. **That is a diagnostic, not WebMCP**, and is named so it cannot be mistaken for one.
- The natural-language demo returns *which tool an agent would call and with what arguments*. It does not fabricate a result.

**Anonymous sessions.** Clearing cookies loses access to a site's configuration. Accounts are roadmap.

---

## Roadmap

Auth.js sign-in with Google/GitHub · claiming anonymous sites into an account · a persistent multi-site dashboard · continuous monitoring · AI-assisted mapping repair · usage analytics · a Chrome extension for testing · native Framer/Webflow/Wix integrations · a visual selector editor.

Explicitly **not** planned for the MVP: billing, teams, destructive agent actions, automatic modification of anyone's website code, or a general-purpose crawler.

---

## Project layout

```
prisma/                     schema + version-controlled migrations
scripts/build-runtime.mjs   esbuild bundle → public/runtime/v1.js
src/app/                    App Router pages and route handlers
  api/builder/*             private, session-owned
  api/public/*              public: config + verification callback
src/components/builder/     the five-step UI
src/lib/
  ai/                       prompt input, model chain, mapping resolution
  capabilities/             the fixed generic catalogue
  scanner/                  URL safety, fetching, crawling, extraction
  services/                 the shared layer the UI and WebMCP tools both call
  webmcp/                   the only place that touches document.modelContext
src/runtime/                the installed browser runtime (TypeScript → esbuild)
tests/                      unit + database-backed integration suites
```

## License

MIT © 2026 Sumedh Tirodkar. See [LICENSE](./LICENSE).
