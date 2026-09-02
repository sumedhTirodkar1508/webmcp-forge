import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { classifyAiError } from "@/lib/ai/classify-error";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_IDS,
  type CapabilityId,
} from "@/lib/capabilities/catalogue";
import type { BuilderSession } from "@/generated/prisma/client";
import { getEnv, hasGeminiKey } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { loadCurrentSettings, describeCapabilities } from "@/lib/services/config-service";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * The natural-language demo.
 *
 * It answers one question: given a plain-English request, which of this site's
 * enabled tools would an agent reach for, and with what arguments?
 *
 * It deliberately stops there. WebMCP Forge runs on a different origin from the
 * portfolio, and a page cannot invoke `document.modelContext.executeTool` on
 * another origin's document. Producing a plausible-looking result here would
 * mean fabricating a tool call that never happened, so this returns the routing
 * decision and says plainly that the actual invocation belongs to a real agent
 * on the portfolio page. Honest and still useful.
 *
 * Cost control: a hard, server-side cap per site, counted from `ai_usage_events`.
 * A browser-side counter would be one devtools edit away from unlimited.
 */

const routingSchema = z.object({
  tool: z.enum(CAPABILITY_IDS),
  arguments: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])),
  reasoning: z.string().max(400),
});

export interface DemoRouting {
  tool: CapabilityId;
  toolLabel: string;
  arguments: Record<string, string | number | boolean>;
  reasoning: string;
  questionsRemaining: number;
}

async function questionsUsed(siteId: string): Promise<number> {
  return prisma.aiUsageEvent.count({
    where: { siteId, purpose: "NL_DEMO", status: "SUCCESS" },
  });
}

export async function routeDemoQuestion(
  session: BuilderSession,
  siteId: string,
  question: string,
): Promise<DemoRouting> {
  const site = await requireOwnedSiteFor(session, siteId);
  const env = getEnv();

  if (!hasGeminiKey()) {
    throw new AppError("AI_UNAVAILABLE", "The demo is not available on this deployment.");
  }

  const trimmed = question.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "Ask a question first.");
  if (trimmed.length > 300) {
    throw new AppError("VALIDATION_FAILED", "That question is too long.");
  }

  // Checked before spending anything.
  const used = await questionsUsed(site.id);
  if (used >= env.GEMINI_NL_DEMO_MAX_QUESTIONS) {
    throw new AppError(
      "DEMO_LIMIT_REACHED",
      `The demo is limited to ${env.GEMINI_NL_DEMO_MAX_QUESTIONS} questions per site.`,
    );
  }

  const current = await loadCurrentSettings(site);
  if (!current) throw new AppError("CONFLICT", "Scan your site before trying the demo.");

  const enabled = describeCapabilities(current.mapping, current.settings).filter(
    (capability) => capability.enabled,
  );
  if (enabled.length === 0) {
    throw new AppError("CONFLICT", "Turn on at least one capability before trying the demo.");
  }

  const catalogue = enabled.map((capability) => ({
    name: capability.id,
    description: CAPABILITY_CATALOGUE[capability.id].agentDescription,
    inputSchema: CAPABILITY_CATALOGUE[capability.id].inputSchema,
  }));

  // Deliberately the cheap model: this is tool selection, not reasoning about
  // content, and the flagship model would be waste.
  const model = env.GEMINI_NL_DEMO_MODEL;
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const startedAt = Date.now();

  const record = async (
    status: Parameters<typeof prisma.aiUsageEvent.create>[0]["data"]["status"],
    errorCode?: string,
  ) => {
    await prisma.aiUsageEvent.create({
      data: {
        siteId: site.id,
        purpose: "NL_DEMO",
        model,
        attempt: 1,
        status,
        errorCode: errorCode ?? null,
        latencyMs: Date.now() - startedAt,
      },
    });
  };

  try {
    const response = await client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
                availableTools: catalogue,
                question: trimmed,
              }),
            },
          ],
        },
      ],
      config: {
        systemInstruction:
          'You choose which single tool an AI agent would call to answer a visitor\'s question about a portfolio website. Pick exactly one tool from "availableTools" and give the arguments it would be called with, matching that tool\'s inputSchema. Keep "reasoning" to one short sentence. Never invent a tool name.',
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(routingSchema, { io: "input", target: "draft-7" }),
        temperature: 0,
      },
    });

    const text = response.text;
    if (!text) throw new Error("empty response");

    const parsed = routingSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      await record("SCHEMA_INVALID", "schema_invalid");
      throw new AppError("AI_INVALID_OUTPUT", "The demo could not interpret that question.");
    }

    // The model may only pick a tool that is actually enabled here.
    if (!enabled.some((capability) => capability.id === parsed.data.tool)) {
      await record("SCHEMA_INVALID", "tool_not_enabled");
      throw new AppError(
        "AI_INVALID_OUTPUT",
        "The demo suggested a tool that is not enabled on this site.",
      );
    }

    await record("SUCCESS");

    return {
      tool: parsed.data.tool,
      toolLabel: CAPABILITY_CATALOGUE[parsed.data.tool].label,
      arguments: parsed.data.arguments,
      reasoning: parsed.data.reasoning,
      questionsRemaining: Math.max(
        0,
        env.GEMINI_NL_DEMO_MAX_QUESTIONS - (await questionsUsed(site.id)),
      ),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    const failure = classifyAiError(error);
    await record(
      failure.kind === "TIMEOUT"
        ? "TIMEOUT"
        : failure.kind === "AUTH"
          ? "AUTH_ERROR"
          : failure.kind === "RATE_LIMITED"
            ? "RATE_LIMITED"
            : failure.kind === "QUOTA_EXHAUSTED"
              ? "QUOTA_EXHAUSTED"
              : "UNKNOWN_ERROR",
      failure.code,
    );

    throw new AppError("AI_UNAVAILABLE", "The demo is temporarily unavailable. Try again shortly.");
  }
}
