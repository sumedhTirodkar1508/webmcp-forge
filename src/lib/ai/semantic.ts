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
  options: { onAttempt?: (record: AiAttemptRecord) => Promise<void> | void } = {},
): Promise<SemanticOutcome> {
  if (!hasGeminiKey()) {
    const heuristic = deriveHeuristicMapping(representation);
    return {
      ...heuristic,
      warnings: [
        "AI interpretation is not configured, so the structure was detected automatically and may be less accurate.",
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

  const result = await runModelChain<SemanticResult>({
    models: modelChain(),
    timeoutMs: env.GEMINI_REQUEST_TIMEOUT_MS,
    maxRetriesPerModel: env.GEMINI_MAX_RETRIES_PER_MODEL,
    onAttempt: options.onAttempt,
    call: async (model, signal) => {
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: JSON.stringify(promptInput) }],
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
          ...resolved.warnings,
        ]
      : resolved.warnings,
    model: result.model,
    usedAi: true,
    fellBack: result.fellBack,
    attempts: result.attempts,
  };
}
