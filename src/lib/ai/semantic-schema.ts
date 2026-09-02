import { z } from "zod";

/**
 * What Gemini is allowed to return.
 *
 * The model never emits a selector. It emits *references* into the candidate
 * set the deterministic scanner already produced: a page URL, a repeated-group
 * id (`g1`, `g2`, …), and for each semantic role the name of one of that
 * group's discovered fields. Everything that ends up in the runtime
 * configuration is then resolved from our own scan data.
 *
 * That is the whole point: interpretation is the model's job, and constructing
 * anything the browser will execute against is not. The worst a compromised or
 * confused model can do here is point at the wrong list.
 */

/** `g1`, `g2`, … — an id assigned by deterministic extraction. */
const groupId = z
  .string()
  .min(1)
  .max(12)
  .regex(/^g\d{1,3}$/, "Must reference a scanned group id such as `g1`");

const pageUrl = z.string().min(1).max(2000);

/** A field name that must exist on the referenced group. Verified after parse. */
const fieldRef = z.string().min(1).max(40);

const listSelection = <T extends z.ZodRawShape>(roles: T) =>
  z.object({
    pageUrl,
    groupId,
    fields: z.object(roles),
    confidence: z.number().min(0).max(1).default(0.5),
  });

export const semanticResultSchema = z.object({
  /** Which platform the model believes built the site. Advisory only — the
   *  deterministic fingerprint wins when the two disagree. */
  platformGuess: z
    .enum(["FRAMER", "WIX", "WEBFLOW", "SQUARESPACE", "NEXTJS", "CUSTOM", "UNKNOWN"])
    .default("UNKNOWN"),

  profile: z
    .object({
      pageUrl,
      /** Index into the `headings` array we sent for that page. */
      nameHeadingIndex: z.number().int().min(0).max(200).optional(),
      headlineHeadingIndex: z.number().int().min(0).max(200).optional(),
      /** Index into the `sections` array we sent for that page. */
      bioSectionIndex: z.number().int().min(0).max(50).optional(),
      confidence: z.number().min(0).max(1).default(0.5),
    })
    .optional(),

  projects: listSelection({
    title: fieldRef.optional(),
    description: fieldRef.optional(),
    link: fieldRef.optional(),
    image: fieldRef.optional(),
    tags: fieldRef.optional(),
    date: fieldRef.optional(),
  }).optional(),

  /** Route pattern where a single project's own page lives, e.g. `/work/*`. */
  projectDetailRoute: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9\-._~/*]*$/, "Must be a same-origin path pattern")
    .optional(),

  skills: listSelection({
    name: fieldRef.optional(),
    category: fieldRef.optional(),
    items: fieldRef.optional(),
  }).optional(),

  experience: listSelection({
    role: fieldRef.optional(),
    organization: fieldRef.optional(),
    dates: fieldRef.optional(),
    summary: fieldRef.optional(),
  }).optional(),

  education: listSelection({
    institution: fieldRef.optional(),
    degree: fieldRef.optional(),
    dates: fieldRef.optional(),
    summary: fieldRef.optional(),
  }).optional(),

  contact: z
    .object({
      pageUrl,
      confidence: z.number().min(0).max(1).default(0.5),
    })
    .optional(),

  /** Nav entries the model considers the site's primary navigation. Each must
   *  match a path we actually saw; unmatched entries are dropped. */
  navigation: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        path: z.string().min(1).max(500),
      }),
    )
    .max(30)
    .default([]),

  /** Short, user-presentable notes, e.g. "no education section found". */
  warnings: z.array(z.string().max(300)).max(10).default([]),
});

export type SemanticResult = z.infer<typeof semanticResultSchema>;
