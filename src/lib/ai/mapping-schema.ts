import { z } from "zod";

/**
 * The site mapping: WebMCP Forge's persisted description of a portfolio's
 * *structure*.
 *
 * This is what makes the product work without re-scanning. We never store a
 * copy of the portfolio's content — only how to find it. At tool-invocation
 * time the installed runtime re-reads the live DOM through these selectors, so
 * a project added after the scan shows up immediately.
 *
 * It is also the trust boundary for anything Gemini produces. Everything here
 * is inert data: selectors, attribute names and route patterns. There is no
 * field into which a model could place executable code, and `assertSafeSelector`
 * rejects anything that is not a plain CSS selector.
 */

/** Route pattern a mapping applies to. `*` means "every page". */
const routeMatch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(\*|\/[A-Za-z0-9\-._~/*]*)$/, "Route must be `*` or a path");

/**
 * Rejects anything that is not a plain CSS selector.
 *
 * The characters excluded here — quotes are allowed inside attribute selectors,
 * but parentheses beyond the CSS functional pseudo-classes, semicolons, angle
 * brackets and backslashes are not — are the ones that would be needed to smuggle
 * script-like content through. Combined with the fact that selectors are only
 * ever passed to `querySelectorAll`, never to `eval`, `innerHTML` or a
 * `Function` constructor, a malicious selector can at worst match nothing.
 */
const SELECTOR_ALLOWED = /^[A-Za-z0-9\s\-_.#[\]="':>+~^$*|(),/@]+$/;
const SELECTOR_FORBIDDEN = /(javascript:|<|;|\\|\{|\}|expression\(|url\()/i;

export function isSafeSelector(value: string): boolean {
  if (value.length === 0 || value.length > 300) return false;
  if (SELECTOR_FORBIDDEN.test(value)) return false;
  return SELECTOR_ALLOWED.test(value);
}

const selector = z
  .string()
  .min(1)
  .max(300)
  .refine(isSafeSelector, "Not a plain CSS selector");

/** Attribute names are restricted to the shape HTML actually allows. */
const attributeName = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z][A-Za-z0-9\-_:]*$/, "Not a valid attribute name");

/** Where a single value is read from, relative to its item element. */
export const fieldMappingSchema = z
  .object({
    /** Empty string means "the item element itself". */
    selector: z.union([selector, z.literal("")]),
    source: z.enum(["text", "href", "src", "attr"]),
    attribute: attributeName.optional(),
  })
  .refine(
    (v) => v.source !== "attr" || Boolean(v.attribute),
    "source `attr` requires an attribute name",
  );

export type FieldMapping = z.infer<typeof fieldMappingSchema>;

/** A list of like items on a page — projects, skills, roles, degrees. */
export const listMappingSchema = z.object({
  /** Which pages this list appears on. */
  route: routeMatch,
  itemSelector: selector,
  containerSelector: selector.optional(),
  fields: z.record(z.string().max(40), fieldMappingSchema),
  /** What the scan saw, so verification can spot a mapping that has broken. */
  expectedCount: z.number().int().min(0).max(10_000).optional(),
  /** Deterministic count of nested leaf values (for grouped lists such as skills). */
  expectedNestedCount: z.number().int().min(0).max(100_000).optional(),
});

export type ListMapping = z.infer<typeof listMappingSchema>;

/** A handful of single values on a page — name, headline, bio. */
export const singleMappingSchema = z.object({
  route: routeMatch,
  fields: z.record(z.string().max(40), fieldMappingSchema),
});

export type SingleMapping = z.infer<typeof singleMappingSchema>;

export const navigationMappingSchema = z.object({
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        /** Same-origin path only. Enforced again at runtime before navigating. */
        path: z
          .string()
          .min(1)
          .max(500)
          // A leading `//` is a scheme-relative URL, not a same-origin path.
          .regex(/^\/(?!\/)/, "Path must be a same-origin path"),
      }),
    )
    .max(30),
});

export const contactMappingSchema = z.object({
  route: routeMatch,
  emails: z.array(z.email().max(200)).max(10).default([]),
  phones: z.array(z.string().max(40)).max(10).default([]),
  socials: z
    .array(
      z.object({
        platform: z.string().min(1).max(40),
        url: z.url().max(500),
      }),
    )
    .max(10)
    .default([]),
  /** Optional live selector, so edits to the page are picked up. */
  list: listMappingSchema.optional(),
});

/**
 * The complete mapping. Every section is optional: a portfolio with no
 * education section simply has no education mapping, and the corresponding
 * capability is recommended off.
 */
/**
 * A contact form the runtime may fill in on the visitor's behalf.
 *
 * Every selector here is produced by the deterministic scanner and verified
 * against the scanned document — the model never authors one. `support`
 * records why a form was accepted or refused, so the builder can explain
 * itself rather than silently offering (or withholding) the capability.
 *
 * This mapping describes only WHERE the fields are. No message content is
 * ever stored in it, or anywhere else in WebMCP Forge.
 */
export const contactFormMappingSchema = z.object({
  route: routeMatch,
  formSelector: selector,
  submitSelector: selector.optional(),
  fields: z.object({
    name: selector.optional(),
    email: selector.optional(),
    subject: selector.optional(),
    message: selector,
  }),
  support: z.enum(["SUPPORTED", "UNSUPPORTED", "UNCERTAIN"]),
  reasons: z.array(z.string().max(200)).max(10).default([]),
});

export type ContactFormMapping = z.infer<typeof contactFormMappingSchema>;

export const siteMappingSchema = z.object({
  version: z.literal(1),
  profile: singleMappingSchema.optional(),
  projects: listMappingSchema.optional(),
  /** Where a single project's own page lives, e.g. `/work/*`. */
  projectDetailRoute: routeMatch.optional(),
  projectDetail: singleMappingSchema.optional(),
  skills: listMappingSchema.optional(),
  experience: listMappingSchema.optional(),
  education: listMappingSchema.optional(),
  contact: contactMappingSchema.optional(),
  contactForm: contactFormMappingSchema.optional(),
  navigation: navigationMappingSchema.optional(),
});

export type SiteMapping = z.infer<typeof siteMappingSchema>;

/** Confidence and rationale the model reports alongside its choices. */
export const mappingConfidenceSchema = z.record(
  z.string().max(40),
  z.object({
    confidence: z.number().min(0).max(1),
    note: z.string().max(300).optional(),
  }),
);

export type MappingConfidence = z.infer<typeof mappingConfidenceSchema>;
