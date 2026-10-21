import "server-only";

import { z } from "zod";

/**
 * Server-only environment contract.
 *
 * Nothing in here may ever be imported from a Client Component: the
 * `server-only` import above turns that mistake into a build error.
 *
 * Canonical variable names are documented in `.env.example`. A small alias map
 * keeps older `.env.local` files (written before the names were finalised)
 * working; the canonical name always wins when both are present.
 */

const ALIASES: Record<string, string> = {
  APP_BASE_URL: "NEXT_PUBLIC_APP_URL",
  GEMINI_SEMANTIC_PRIMARY_MODEL: "GEMINI_PRIMARY_MODEL",
  GEMINI_SEMANTIC_FALLBACK_1_MODEL: "GEMINI_FALLBACK_MODEL_1",
  GEMINI_SEMANTIC_FALLBACK_2_MODEL: "GEMINI_FALLBACK_MODEL_2",
  GEMINI_NL_DEMO_MODEL: "GEMINI_PREVIEW_MODEL",
  // The natural-language chain is deliberately separate from the scan chain:
  // it is interactive, so it uses two cheap models with a shorter budget.
  GEMINI_NL_DEMO_PRIMARY_MODEL: "GEMINI_NL_DEMO_MODEL",
  GEMINI_NL_DEMO_FALLBACK_MODEL: "GEMINI_FALLBACK_MODEL_2",
  GEMINI_NL_DEMO_MAX_QUESTIONS: "NATURAL_LANGUAGE_DEMO_LIMIT",
};

function read(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct !== "") return direct;
  const alias = ALIASES[name];
  if (!alias) return undefined;
  const aliased = process.env[alias];
  return aliased === "" ? undefined : aliased;
}

const intFrom = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1).optional(),

  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_SEMANTIC_PRIMARY_MODEL: z.string().min(1).default("gemini-3.7-flash"),
  GEMINI_SEMANTIC_FALLBACK_1_MODEL: z
    .string()
    .min(1)
    .default("gemini-3.5-flash-lite"),
  GEMINI_SEMANTIC_FALLBACK_2_MODEL: z
    .string()
    .min(1)
    .default("gemini-3.1-flash-lite"),
  GEMINI_NL_DEMO_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_NL_DEMO_PRIMARY_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_NL_DEMO_FALLBACK_MODEL: z.string().min(1).default("gemini-3.1-flash-lite"),
  /** Interactive budget. Deliberately far below the scan timeout — nobody
   *  should wait 40 seconds for an answer in a chat box. */
  GEMINI_NL_DEMO_TIMEOUT_MS: intFrom(9_000, 1_000, 30_000),
  GEMINI_NL_DEMO_MAX_QUESTIONS: intFrom(3, 0, 100),
  GEMINI_MAX_RETRIES_PER_MODEL: intFrom(1, 0, 3),
  GEMINI_REQUEST_TIMEOUT_MS: intFrom(20_000, 1_000, 120_000),

  APP_BASE_URL: z.url().default("http://localhost:3000"),

  /**
   * A portfolio first-time visitors can try without one of their own. Set it
   * to an empty string to hide the "Try the demo" button.
   */
  DEMO_PORTFOLIO_URL: z
    .union([z.url(), z.literal("")])
    .default("https://webmcp-forge-demo-portfolio.vercel.app/"),

  SCAN_MAX_PAGES: intFrom(10, 1, 50),
  SCAN_REQUEST_TIMEOUT_MS: intFrom(10_000, 1_000, 60_000),
  SCAN_MAX_HTML_BYTES: intFrom(2_000_000, 10_000, 20_000_000),
  SCAN_MAX_REDIRECTS: intFrom(3, 0, 10),
  /**
   * Wall-clock budget for crawling, before interpretation starts. Keeps a slow
   * site from outliving the request; the scan proceeds with what it gathered.
   */
  SCAN_TIME_BUDGET_MS: intFrom(25_000, 3_000, 120_000),
  /** Wall-clock budget for the AI interpretation step, across all fallbacks. */
  SCAN_AI_BUDGET_MS: intFrom(30_000, 3_000, 120_000),
  SCAN_MAX_PER_SESSION_PER_HOUR: intFrom(10, 1, 1000),

  VERIFICATION_CHALLENGE_TTL_SECONDS: intFrom(300, 30, 3600),

  /**
   * Experimental visual scan assistance.
   *
   * Off by default and intended to stay off until browser rendering can be
   * contained as strictly as the fetch path already is — see
   * `src/lib/scanner/visual/page-renderer.ts`.
   */
  VISUAL_SCAN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1")
    .pipe(z.boolean()),
  VISUAL_SCAN_MAX_IMAGES: intFrom(3, 0, 3),
  VISUAL_SCAN_MAX_IMAGE_BYTES: intFrom(600_000, 10_000, 600_000),
  VISUAL_SCAN_MAX_TOTAL_IMAGE_BYTES: intFrom(1_500_000, 10_000, 1_800_000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Parses and caches the environment. Throws a message that names the offending
 * variables but never echoes their values.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) raw[key] = read(key);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)")),
    ];
    throw new Error(
      `Invalid environment configuration. Check these variables in .env.local: ${names.join(", ")}`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Clears the parsed-environment cache.
 *
 * Only for tests, which need to exercise behaviour under different flag values
 * within one process. Production reads the environment once on purpose.
 */
export function resetEnvCache(): void {
  cached = undefined;
}

/** True when Gemini is configured. Semantic mapping degrades without it. */
export function hasGeminiKey(): boolean {
  return Boolean(read("GEMINI_API_KEY"));
}

/** The origin (scheme + host + port) this deployment is served from. */
export function appOrigin(): string {
  return new URL(getEnv().APP_BASE_URL).origin;
}
