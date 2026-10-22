import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { runModelChain, type AiAttemptRecord } from "@/lib/ai/model-chain";
import { buildPromptInput, SEMANTIC_SYSTEM_PROMPT } from "@/lib/ai/prompt-input";
import {
  deriveHeuristicMapping,
  resolveMapping,
  type ResolvedMapping,
} from "@/lib/ai/resolve-mapping";
import { semanticResultSchema, type SemanticResult } from "@/lib/ai/semantic-schema";
import { getEnv, hasGeminiKey } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { ScanRepresentation } from "@/lib/scanner/types";
import { assessAmbiguity } from "@/lib/scanner/visual/ambiguity";
import {
  captureForAmbiguity,
  visualScanAvailable,
  type CapturedImage,
} from "@/lib/scanner/visual/page-renderer";

/**
 * Semantic interpretation of a deterministic scan.
 *
 * One Gemini request in the normal case. The model chooses among candidates the
 * scanner already found; `resolveMapping` then rebuilds the configuration from
 * our own data. If Gemini is unconfigured or every model fails, the scan still
 * succeeds with a heuristic mapping and an honest warning — a third-party
 * outage should not make the product unusable.
 *
 * Gemini is never called again after this. Once the mapping is stored, an
 * installed portfolio executes tools entirely from the live DOM.
 */

export interface SemanticOutcome extends ResolvedMapping {
  /** The model that produced the mapping, or null when AI was not used. */
  model: string | null;
  usedAi: boolean;
  fellBack: boolean;
  attempts: AiAttemptRecord[];
}

/** The JSON Schema handed to Gemini's structured-output mode. */
const RESPONSE_JSON_SCHEMA = z.toJSONSchema(semanticResultSchema, {
  io: "input",
  target: "draft-7",
});

function modelChain(): string[] {
  const env = getEnv();
  return [
    env.GEMINI_SEMANTIC_PRIMARY_MODEL,
    env.GEMINI_SEMANTIC_FALLBACK_1_MODEL,
    env.GEMINI_SEMANTIC_FALLBACK_2_MODEL,
  ].filter((model, index, all) => all.indexOf(model) === index);
}

/**
 * Extracts the model's JSON. Structured-output mode should make this trivial,
 * but a model occasionally wraps its answer in a code fence, and that is a
 * malformed-output case worth recovering from before spending a retry.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate) as unknown;
}

export async function interpretScan(
  representation: ScanRepresentation,
  options: {
    onAttempt?: (record: AiAttemptRecord) => Promise<void> | void;
    /**
     * Skip the model and use the structural reading. Set when the deployment's
     * overall AI budget is spent; the scan still succeeds, just less precisely.
     */
    skipAi?: boolean;
  } = {},
): Promise<SemanticOutcome> {
  const budgetStop = Boolean(options.skipAi) && hasGeminiKey();

  if (budgetStop || !hasGeminiKey()) {
    const heuristic = deriveHeuristicMapping(representation);
    return {
      ...heuristic,
      warnings: [
        budgetStop
          ? "Our AI helper has reached its daily limit, so the structure was detected automatically and may be less accurate. Scanning again later can improve the result."
          : "AI interpretation is not configured, so the structure was detected automatically and may be less accurate.",
        ...heuristic.warnings,
      ],
      model: null,
      usedAi: false,
      fellBack: false,
      attempts: [],
    };
  }

  const env = getEnv();
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const promptInput = buildPromptInput(representation);

  /*
   * Visual assistance is strictly opt-in and strictly conditional. A confident
   * scan renders nothing at all, and the normal path still makes exactly ONE
   * semantic request — the screenshots, when there are any, are attached to
   * that same call rather than adding another.
   */
  let images: CapturedImage[] = [];
  const visualWarnings: string[] = [];

  if (visualScanAvailable()) {
    const assessment = assessAmbiguity(representation);
    if (assessment.ambiguous) {
      const captured = await captureForAmbiguity(assessment.sections);
      images = captured.images;
      visualWarnings.push(...captured.warnings);
    }
  }

  const result = await runModelChain<SemanticResult>({
    models: modelChain(),
    timeoutMs: env.GEMINI_REQUEST_TIMEOUT_MS,
    // Backup flash models normally answer in a couple of seconds. Capping
    // each fallback prevents a primary timeout from turning into a minute-long
    // scan while retaining the deterministic heuristic as the final safety net.
    fallbackTimeoutMs: Math.min(5_000, env.GEMINI_REQUEST_TIMEOUT_MS),
    maxRetriesPerModel: env.GEMINI_MAX_RETRIES_PER_MODEL,
    // Bounds the whole chain, so a run of slow fallbacks cannot outlive the
    // request; on exhaustion the scan uses the heuristic mapping instead.
    budgetMs: env.SCAN_AI_BUDGET_MS,
    onAttempt: options.onAttempt,
    call: async (model, signal) => {
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { text: JSON.stringify(promptInput) },
              // Screenshots, when present, only ever accompany the compact
              // deterministic JSON. Raw page HTML is never sent.
              ...images.map((image) => ({
                inlineData: {
                  mimeType: image.mimeType,
                  data: Buffer.from(image.data).toString("base64"),
                },
              })),
            ],
          },
        ],
        config: {
          systemInstruction: SEMANTIC_SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_JSON_SCHEMA,
          temperature: 0,
          abortSignal: signal,
        },
      });

      const text = response.text;
      if (!text) throw new Error("empty response");
      return extractJson(text);
    },
    validate: (raw) => {
      // Structured-output mode is not a guarantee of semantic correctness, and
      // it is not a guarantee of schema compliance either. Validate regardless.
      const parsed = semanticResultSchema.safeParse(raw);
      return parsed.success
        ? { ok: true as const, value: parsed.data }
        : { ok: false as const, message: parsed.error.issues[0]?.message ?? "invalid shape" };
    },
  });

  if (!result.ok) {
    logger.warn("semantic_mapping_failed", {
      kind: result.failure.kind,
      code: result.failure.code,
      attempts: result.attempts.length,
    });
    const heuristic = deriveHeuristicMapping(representation);
    return {
      ...heuristic,
      warnings: [
        "AI interpretation was unavailable, so the structure was detected automatically and may be less accurate.",
        ...visualWarnings,
        ...heuristic.warnings,
      ],
      model: null,
      usedAi: false,
      fellBack: true,
      attempts: result.attempts,
    };
  }

  const resolved = resolveMapping(representation, result.value);

  return {
    ...resolved,
    warnings: result.fellBack
      ? [
          "The main AI model was unavailable, so a backup model interpreted your site.",
          ...visualWarnings,
          ...resolved.warnings,
        ]
      : [...visualWarnings, ...resolved.warnings],
    model: result.model,
    usedAi: true,
    fellBack: result.fellBack,
    attempts: result.attempts,
  };
}
