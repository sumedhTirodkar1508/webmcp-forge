import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { runModelChain, type AiAttemptRecord } from "@/lib/ai/model-chain";
import type { BuilderSession } from "@/generated/prisma/client";
import { getEnv, hasGeminiKey } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  awaitCommandResult,
  isLiveTestTool,
  LIVE_TEST_ALLOWED_TOOLS,
  queueCommand,
  type LiveTestTool,
} from "@/lib/services/live-test-service";
import { buildReadinessSnapshot, type ReadinessSnapshot } from "@/lib/services/readiness-service";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * "Ask your agent" — the single natural-language engine.
 *
 * Two honest modes, chosen by what the question actually needs:
 *
 *   MODE A (readiness) answers operational questions — "is WebMCP working?",
 *   "why are only three tools registered?" — strictly from the readiness
 *   snapshot, which is assembled from data Forge already observed.
 *
 *   MODE B (live) answers content questions — "does this person know
 *   Kubernetes?" — by executing a real read-only WebMCP tool inside the
 *   owner's own portfolio page through the live test relay, and interpreting
 *   the actual result.
 *
 * The rule that keeps it truthful: the assistant may never claim a tool ran.
 * If no live session is connected, it says which tool the question maps to and
 * that a live test is needed — it does not invent an answer, and it does not
 * substitute a server-side DOM read and call it WebMCP.
 *
 * Cost: one user submission consumes exactly one lifetime question, regardless
 * of how many model attempts, fallbacks or summarization calls it took.
 */

const MAX_QUESTION_CHARS = 300;

/**
 * Wall-clock budgets for the interactive path.
 *
 * Someone is watching a chat box. Each model step gets a bounded slice, so the
 * worst case — every fallback slow — still answers (or fails honestly) well
 * inside the request rather than hanging until the platform kills it.
 */
const ROUTE_BUDGET_MS = 20_000;
const SUMMARY_BUDGET_MS = 15_000;

/** Bound what a real tool result may contribute to a prompt. */
const MAX_TOOL_RESULT_CHARS = 6000;

const routingSchema = z.object({
  /** Whether this needs live portfolio content, or is about readiness. */
  needsLiveTool: z.boolean(),
  /** The read-only tool the question maps to, when it needs live content. */
  tool: z.enum(LIVE_TEST_ALLOWED_TOOLS).optional(),
  arguments: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .default({}),
  /** The readiness answer, when no live tool is required. */
  answer: z.string().max(1200).default(""),
});

const summarySchema = z.object({
  answer: z.string().max(1200),
});

export type AgentChatMode = "readiness" | "live" | "live_unavailable";

export interface AgentChatResult {
  mode: AgentChatMode;
  answer: string;
  /** The tool that ran, or would have run. */
  tool: LiveTestTool | null;
  arguments: Record<string, unknown>;
  /** True only when a real `document.modelContext.executeTool` call happened. */
  executed: boolean;
  /** Where execution happened, for the UI to state plainly. */
  executedOn: string | null;
  model: string;
  fellBack: boolean;
  questionsRemaining: number;
}

async function questionsUsed(siteId: string): Promise<number> {
  return prisma.aiUsageEvent.count({
    where: { siteId, purpose: "NL_DEMO", status: "SUCCESS", errorCode: null },
  });
}

function nlModels(): string[] {
  const env = getEnv();
  const models = [env.GEMINI_NL_DEMO_PRIMARY_MODEL, env.GEMINI_NL_DEMO_FALLBACK_MODEL];
  return models.filter((model, index) => models.indexOf(model) === index);
}

const SYSTEM_PROMPT = `You are the readiness assistant for WebMCP Forge, a tool that makes portfolio websites usable by AI agents.

You are given a SNAPSHOT of authoritative state about one portfolio, and a question.

Decide which kind of question it is.

OPERATIONAL questions are about the setup itself: whether WebMCP is working, how many tools registered, why some did not, whether mappings are healthy, whether the config is current, whether agents can send a contact message, how many skills were found. Answer these from the snapshot only, and set needsLiveTool to false.

LIVE questions ask about what the portfolio actually says, or ask you to DO something on the page. Neither can be answered from the snapshot — they need a real tool call in the live page. Set needsLiveTool to true and choose exactly one tool.

Tool selection for content questions:
- abilities, technologies or skills -> get_skills with {}
- naming or searching projects -> search_projects with { "query": "<the key term>" }
- listing projects -> list_projects with {}
- jobs, roles or employers -> get_experience with {}
- study, degrees or university -> get_education with {}
- who the person is -> get_profile with {}
- how to reach them -> get_contact_info with {}

Tool selection for ACTIONS on the page:
- "go to", "navigate to", "open the X section/page" -> navigate_site with { "destination": "<label>" } or { "path": "/<path>" }
- "focus", "scroll to", "highlight", "show me the X project" -> focus_project with { "title": "<project name>" }
- "draft", "compose", "write a message" -> prepare_contact_message with { "message": "<the message text>" }, plus "name"/"email"/"subject" when the person supplied them. This only STAGES a draft; it sends nothing.

Never choose send_contact_message. Actually submitting a message requires the person to confirm in their own browser, so it is not something a typed request can trigger. If asked to send, set needsLiveTool to false and explain that the draft must be confirmed in the browser tab where it was prepared.

Rules you must follow:
- Only ever choose a tool from the allowed list. Never invent a tool name.
- Only choose a tool that appears in "enabledTools". If the right tool is not enabled for this site, set needsLiveTool to false and say which capability would need enabling.
- NEVER claim you called, ran or executed a tool. You have not. When describing registered tools, say what verification observed, e.g. "Verification shows get_skills is registered and its mapping is healthy."
- Never state a number that is not in the snapshot.
- Be concise and plain. Two or three sentences is usually right. No markdown headings.
- If the snapshot shows something is broken or missing, say so directly rather than reassuring.`;

const SUMMARY_PROMPT = `You are given a visitor's question about a portfolio and the ACTUAL result of a WebMCP tool that was just executed in that portfolio's own page.

Answer the question using only that result. Be direct and concise — usually one or two sentences.

If the result clearly contains the thing asked about, say yes and cite where it appears (for example the category it is listed under). If it clearly does not, say no plainly. Do not speculate beyond the result, and do not invent detail that is not there.`;

/**
 * The tools a question may actually reach on this site.
 *
 * Intersects three things: what may be dispatched at all, what the owner has
 * enabled, and — when a live target is connected — what that target actually
 * registered. A capability disabled in the pinned configuration is absent from
 * the browser's registry, so it must be absent here too.
 */
function dispatchableTools(snapshot: ReadinessSnapshot): LiveTestTool[] {
  const enabled = new Set(snapshot.capabilities.enabled);
  const live = snapshot.liveTest.connected ? new Set(snapshot.liveTest.availableTools) : null;

  return LIVE_TEST_ALLOWED_TOOLS.filter(
    (tool) => enabled.has(tool) && (live === null || live.has(tool)),
  );
}

/** Trims a snapshot value set that a model does not need to see in full. */
function promptSnapshot(snapshot: ReadinessSnapshot) {
  return {
    site: snapshot.site,
    scan: snapshot.scan,
    capabilities: snapshot.capabilities,
    contactForm: snapshot.contactForm,
    configuration: snapshot.configuration,
    verification: snapshot.verification,
    liveTestConnected: snapshot.liveTest.connected,
  };
}

export async function askAgent(
  session: BuilderSession,
  siteId: string,
  question: string,
): Promise<AgentChatResult> {
  const site = await requireOwnedSiteFor(session, siteId);
  const env = getEnv();

  if (!hasGeminiKey()) {
    throw new AppError("AI_UNAVAILABLE", "The assistant is not configured on this deployment.");
  }

  const trimmed = question.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "Ask a question first.");
  if (trimmed.length > MAX_QUESTION_CHARS) {
    throw new AppError("VALIDATION_FAILED", "That question is too long.");
  }

  // Checked before anything is spent with the provider.
  const used = await questionsUsed(site.id);
  if (used >= env.GEMINI_NL_DEMO_MAX_QUESTIONS) {
    throw new AppError(
      "DEMO_LIMIT_REACHED",
      `The assistant is limited to ${env.GEMINI_NL_DEMO_MAX_QUESTIONS} questions for this portfolio.`,
    );
  }

  const snapshot = await buildReadinessSnapshot(site);
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  /**
   * Persists one model attempt. A `summarize` tag marks attempts belonging to
   * the same submission so they are not counted as another question.
   */
  const recordAttempt =
    (tag: "route" | "summarize") =>
    async (attempt: AiAttemptRecord) => {
      await prisma.aiUsageEvent.create({
        data: {
          siteId: site.id,
          purpose: "NL_DEMO",
          model: attempt.model,
          attempt: attempt.attempt,
          status: attempt.status,
          errorCode: tag === "summarize" ? "summarize" : (attempt.errorCode ?? null),
          latencyMs: attempt.latencyMs,
        },
      });
    };

  const routed = await runModelChain<z.infer<typeof routingSchema>>({
    models: nlModels(),
    timeoutMs: env.GEMINI_NL_DEMO_TIMEOUT_MS,
    maxRetriesPerModel: 1,
    onAttempt: recordAttempt("route"),
    budgetMs: ROUTE_BUDGET_MS,
    call: async (model, signal) => {
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  snapshot: promptSnapshot(snapshot),
                  allowedTools: LIVE_TEST_ALLOWED_TOOLS,
                  // What this site actually offers right now. A capability the
                  // owner disabled must not be reachable through prose.
                  enabledTools: dispatchableTools(snapshot),
                  question: trimmed,
                }),
              },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(routingSchema, { io: "input", target: "draft-7" }),
          temperature: 0,
          abortSignal: signal,
        },
      });
      const text = response.text;
      if (!text) throw new Error("empty response");
      return JSON.parse(text) as unknown;
    },
    validate: (raw) => {
      const parsed = routingSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false as const, message: parsed.error.issues[0]?.message ?? "invalid shape" };
      }
      if (parsed.data.needsLiveTool) {
        const tool = parsed.data.tool;
        if (!isLiveTestTool(tool)) {
          // Includes send_contact_message, which may never be auto-dispatched.
          // Treated as a schema failure so the chain retries once rather than
          // trusting the choice.
          return { ok: false as const, message: "tool is not dispatchable" };
        }
        if (!dispatchableTools(snapshot).includes(tool)) {
          return { ok: false as const, message: "tool is not enabled for this site" };
        }
      }
      if (!parsed.data.needsLiveTool && parsed.data.answer.trim().length === 0) {
        return { ok: false as const, message: "no answer produced" };
      }
      return { ok: true as const, value: parsed.data };
    },
  });

  if (!routed.ok) {
    throw new AppError(
      routed.failure.kind === "SCHEMA_INVALID" ? "AI_INVALID_OUTPUT" : "AI_UNAVAILABLE",
      routed.failure.kind === "SCHEMA_INVALID"
        ? "The assistant could not interpret that question."
        : "The assistant is temporarily unavailable. Try again shortly.",
    );
  }

  const remaining = async () =>
    Math.max(0, env.GEMINI_NL_DEMO_MAX_QUESTIONS - (await questionsUsed(site.id)));

  // --- Mode A: readiness -------------------------------------------------
  if (!routed.value.needsLiveTool || !routed.value.tool) {
    return {
      mode: "readiness",
      answer: routed.value.answer,
      tool: null,
      arguments: {},
      executed: false,
      executedOn: null,
      model: routed.model,
      fellBack: routed.fellBack,
      questionsRemaining: await remaining(),
    };
  }

  const tool = routed.value.tool;
  const args = routed.value.arguments;

  // --- Mode B: needs a real tool call ------------------------------------
  const queued = await queueCommand(site.id, tool, args);

  if (!queued) {
    // No connected target. Say exactly that rather than answering anyway.
    return {
      mode: "live_unavailable",
      answer: `That question maps to ${tool}, but no live WebMCP test session is connected. Start Live Agent Test to execute the actual browser tool on your portfolio.`,
      tool,
      arguments: args,
      executed: false,
      executedOn: null,
      model: routed.model,
      fellBack: routed.fellBack,
      questionsRemaining: await remaining(),
    };
  }

  const outcome = await awaitCommandResult(queued.commandId);

  if (outcome.status !== "completed") {
    return {
      mode: "live_unavailable",
      answer:
        outcome.status === "timeout"
          ? `Live execution was not completed: the portfolio tab did not respond in time. It may have been closed, or the runtime may not be loaded. The question maps to ${tool}.`
          : `Live execution was not completed: ${tool} reported a failure on the page.`,
      tool,
      arguments: args,
      executed: false,
      executedOn: null,
      model: routed.model,
      fellBack: routed.fellBack,
      questionsRemaining: await remaining(),
    };
  }

  // The tool genuinely ran in the portfolio's own document. Interpret only
  // that result — the page's HTML is never sent to the model.
  const summarised = await runModelChain<z.infer<typeof summarySchema>>({
    models: nlModels(),
    timeoutMs: env.GEMINI_NL_DEMO_TIMEOUT_MS,
    maxRetriesPerModel: 1,
    onAttempt: recordAttempt("summarize"),
    budgetMs: SUMMARY_BUDGET_MS,
    call: async (model, signal) => {
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  question: trimmed,
                  tool,
                  toolResult: outcome.result.slice(0, MAX_TOOL_RESULT_CHARS),
                }),
              },
            ],
          },
        ],
        config: {
          systemInstruction: SUMMARY_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(summarySchema, { io: "input", target: "draft-7" }),
          temperature: 0,
          abortSignal: signal,
        },
      });
      const text = response.text;
      if (!text) throw new Error("empty response");
      return JSON.parse(text) as unknown;
    },
    validate: (raw) => {
      const parsed = summarySchema.safeParse(raw);
      return parsed.success
        ? { ok: true as const, value: parsed.data }
        : { ok: false as const, message: "invalid shape" };
    },
  });

  return {
    mode: "live",
    // If summarization fails, the real tool output is still a true answer.
    answer: summarised.ok
      ? summarised.value.answer
      : `${tool} ran on your portfolio and returned:\n\n${outcome.result.slice(0, 1200)}`,
    tool,
    arguments: args,
    executed: true,
    executedOn: site.origin,
    model: summarised.ok ? summarised.model : routed.model,
    fellBack: routed.fellBack || (summarised.ok && summarised.fellBack),
    questionsRemaining: await remaining(),
  };
}
