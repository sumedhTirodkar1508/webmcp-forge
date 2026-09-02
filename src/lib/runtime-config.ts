import { z } from "zod";

import { CAPABILITY_IDS } from "@/lib/capabilities/catalogue";
import { siteMappingSchema } from "@/lib/ai/mapping-schema";
import { RUNTIME_SCHEMA_VERSION } from "@/lib/runtime-version";

export { RUNTIME_SCHEMA_VERSION, RUNTIME_VERSION } from "@/lib/runtime-version";

/**
 * The public runtime configuration payload.
 *
 * This is the *entire* contract between WebMCP Forge and an installed portfolio,
 * and it is deliberately small. It contains structure — which capabilities are
 * on, and how to find each kind of content in the live DOM — and nothing else.
 *
 * What it must never contain, because the endpoint serving it is public and
 * unauthenticated: draft configurations, internal database ids, the anonymous
 * session token or its hash, verification secrets, scan history, AI usage, or
 * anything about the owner. `serializeRuntimeConfig` on the server is the only
 * thing that builds one, and it builds it field by field rather than spreading
 * a database row.
 *
 * Shared by the server serializer and the browser runtime, so it must stay free
 * of `server-only` and of Node built-ins.
 */


export const runtimeConfigSchema = z.object({
  schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
  /** The public `wmf_…` id from the installation snippet. Not a secret. */
  siteId: z.string().min(1).max(64),
  /** Monotonic version of the published configuration. */
  configVersion: z.number().int().min(1),
  /** The origin this configuration was built for. The runtime refuses to run
   *  on a different origin, which stops a copied snippet from silently
   *  "working" somewhere it was never verified. */
  origin: z.url(),
  /** Which generic capabilities the owner turned on. */
  enabledCapabilities: z.array(z.enum(CAPABILITY_IDS)).max(CAPABILITY_IDS.length),
  mapping: siteMappingSchema,
  generatedAt: z.iso.datetime(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
