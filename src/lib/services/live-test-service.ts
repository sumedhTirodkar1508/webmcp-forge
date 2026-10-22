import "server-only";

import type { BuilderSession, LiveTestCommand } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { asJson } from "@/lib/json";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireOwnedSiteFor } from "@/lib/session";
import { generateToken, hashToken } from "@/lib/tokens";

/**
 * The live agent test relay.
 *
 * WebMCP Forge runs on a different origin from the portfolio, and a page cannot
 * reach another origin's `document.modelContext`. So a genuine tool call has to
 * be made *inside the target page*. This relay is how a question typed in Forge
 * ends up executing there and the real answer comes back — with no browser
 * extension, and without Forge ever pretending it executed anything itself.
 *
 * The session is deliberately narrow:
 *
 *   - it exists only while the owner has explicitly started a test;
 *   - it is bound to the builder session that started it, so another visitor
 *     working on the same site cannot steer, read or end it;
 *   - it is bound to one site and one exact origin;
 *   - it expires in minutes;
 *   - only its token hash is stored;
 *   - the ordinary installed runtime never polls Forge, only a page opened in
 *     test mode does.
 *
 * At-most-once execution is enforced by conditional status transitions rather
 * than by trusting the client: PENDING → DISPATCHED hands a command out exactly
 * once no matter how often the target polls, and DISPATCHED → COMPLETED accepts
 * exactly one result no matter how often it posts.
 */

/** Short enough that an abandoned tab cannot leave a channel open. */
export const LIVE_TEST_TTL_MS = 5 * 60 * 1000;

/** Bounds on what may cross the relay. */
export const MAX_RESULT_CHARS = 8000;
export const MAX_ERROR_CHARS = 300;
const MAX_COMMANDS_PER_SESSION = 25;

/**
 * Capabilities natural-language routing may dispatch to a connected browser.
 *
 * Read-only lookups plus the two view-changing tools, which are safe to run in
 * a browser the owner deliberately connected for testing: they move the page,
 * they do not contact anyone.
 *
 * `prepare_contact_message` is included because it is explicitly
 * non-submitting — it validates input and stages a draft in page memory,
 * returning a confirmationId.
 */
export const LIVE_TEST_ALLOWED_TOOLS = [
  "get_profile",
  "list_projects",
  "get_project",
  "search_projects",
  "get_skills",
  "get_experience",
  "get_education",
  "get_contact_info",
  "navigate_site",
  "focus_project",
  "prepare_contact_message",
] as const;

export type LiveTestTool = (typeof LIVE_TEST_ALLOWED_TOOLS)[number];

/**
 * Tools a typed sentence may NEVER dispatch.
 *
 * `send_contact_message` submits a real message through someone's form. A
 * language model deciding that from prose is not consent, so it stays behind
 * the existing explicit confirmationId + in-browser confirmation flow and is
 * never auto-dispatched — no matter what the model picks.
 */
export const LIVE_TEST_BLOCKED_TOOLS = ["send_contact_message"] as const;

export function isLiveTestTool(value: unknown): value is LiveTestTool {
  if (typeof value !== "string") return false;
  if ((LIVE_TEST_BLOCKED_TOOLS as readonly string[]).includes(value)) return false;
  return (LIVE_TEST_ALLOWED_TOOLS as readonly string[]).includes(value);
}

/** True when a tool submits something and must stay behind confirmation. */
export function isConsequentialTool(value: string): boolean {
  return (LIVE_TEST_BLOCKED_TOOLS as readonly string[]).includes(value);
}

/**
 * Whose live test this is: one browser session, working on one site.
 *
 * A site is shared by every visitor of its origin, so "the site" alone does not
 * identify a test. Everything that finds, drives or ends a test takes this, so
 * a caller cannot forget to scope by session.
 */
export interface LiveTestOwner {
  siteId: string;
  builderSessionId: string;
}

export interface LiveTestIssue {
  /** The raw token. Returned once, for the verification-style URL. */
  testUrl: string;
  sessionId: string;
  expiresAt: Date;
}

/** Opens a session and returns the URL the owner's portfolio should open. */
export async function startLiveTest(
  session: BuilderSession,
  siteId: string,
): Promise<LiveTestIssue> {
  const site = await requireOwnedSiteFor(session, siteId);

  const generated = await prisma.configVersion.count({ where: { siteId: site.id } });
  if (generated === 0) {
    throw new AppError(
      "NO_PUBLISHED_CONFIG",
      "Generate and install your snippet before starting a live agent test.",
    );
  }

  // One live session at a time per browser session and site: a stale channel is
  // a liability. Only this session's own earlier test is closed — starting a
  // test must never end another visitor's.
  await prisma.liveTestSession.updateMany({
    where: {
      siteId: site.id,
      createdBySessionId: session.id,
      status: { in: ["PENDING", "READY"] },
    },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + LIVE_TEST_TTL_MS);

  const created = await prisma.liveTestSession.create({
    data: {
      siteId: site.id,
      createdBySessionId: session.id,
      tokenHash: hashToken(token),
      expectedOrigin: site.origin,
      expiresAt,
    },
  });

  const testUrl = new URL(site.canonicalUrl);
  testUrl.searchParams.set("__wmf_live_test", token);

  return { testUrl: testUrl.toString(), sessionId: created.id, expiresAt };
}

interface ResolvedSession {
  id: string;
  siteId: string;
  expectedOrigin: string;
  publicId: string;
}

/**
 * Resolves a raw token from the target page.
 *
 * Validates the token, the site, the expiry and the browser-asserted Origin
 * together — a token alone is not enough to drive the relay.
 */
async function resolveSession(
  rawToken: string,
  publicId: string,
  requestOrigin: string | null,
): Promise<ResolvedSession> {
  const found = await prisma.liveTestSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { site: { select: { publicId: true } } },
  });

  if (!found || found.status === "CLOSED") {
    throw new AppError("NOT_FOUND", "That live test session is no longer active.");
  }
  if (found.expiresAt.getTime() <= Date.now()) {
    await prisma.liveTestSession.updateMany({
      where: { id: found.id, status: { in: ["PENDING", "READY"] } },
      data: { status: "EXPIRED", closedAt: new Date() },
    });
    throw new AppError("VERIFICATION_EXPIRED", "That live test session has expired.");
  }
  if (found.site.publicId !== publicId) {
    throw new AppError("VERIFICATION_SITE_MISMATCH", "That session belongs to a different site.");
  }
  if (!requestOrigin || requestOrigin !== found.expectedOrigin) {
    logger.warn("live_test_origin_mismatch", { sessionId: found.id });
    throw new AppError(
      "VERIFICATION_ORIGIN_MISMATCH",
      "That report did not come from the website we expected.",
    );
  }

  return {
    id: found.id,
    siteId: found.siteId,
    expectedOrigin: found.expectedOrigin,
    publicId: found.site.publicId,
  };
}

/** The target page announcing it is installed, in test mode, and ready. */
export async function markReady(
  rawToken: string,
  publicId: string,
  requestOrigin: string | null,
  details: { runtimeVersion: string; availableTools: string[] },
): Promise<{ expiresAt: Date }> {
  const resolved = await resolveSession(rawToken, publicId, requestOrigin);

  const updated = await prisma.liveTestSession.update({
    where: { id: resolved.id },
    data: {
      status: "READY",
      readyAt: new Date(),
      runtimeVersion: details.runtimeVersion.slice(0, 32),
      availableTools: asJson(details.availableTools.slice(0, 50).map((t) => t.slice(0, 64))),
    },
  });

  return { expiresAt: updated.expiresAt };
}

export interface DispatchedCommand {
  commandId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Hands the target its next command, at most once.
 *
 * The conditional `updateMany` is what makes repeated polling safe: only the
 * poll that actually flips PENDING → DISPATCHED gets the command, so two
 * concurrent polls cannot both receive it.
 */
export async function claimNextCommand(
  rawToken: string,
  publicId: string,
  requestOrigin: string | null,
): Promise<DispatchedCommand | null> {
  const resolved = await resolveSession(rawToken, publicId, requestOrigin);

  const next = await prisma.liveTestCommand.findFirst({
    where: { sessionId: resolved.id, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!next) return null;

  const claimed = await prisma.liveTestCommand.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "DISPATCHED", dispatchedAt: new Date() },
  });
  if (claimed.count !== 1) return null; // another poll won the race

  return {
    commandId: next.id,
    tool: next.tool,
    arguments: (next.arguments ?? {}) as Record<string, unknown>,
  };
}

/**
 * Records the real result of a browser tool call, at most once.
 *
 * A repeated POST finds the command already COMPLETED and is ignored rather
 * than overwriting — the first answer is the one that happened.
 */
export async function completeCommand(
  rawToken: string,
  publicId: string,
  requestOrigin: string | null,
  input: { commandId: string; result?: string; errorCode?: string },
): Promise<{ accepted: boolean }> {
  const resolved = await resolveSession(rawToken, publicId, requestOrigin);

  const command = await prisma.liveTestCommand.findUnique({
    where: { id: input.commandId },
    select: { id: true, sessionId: true, status: true },
  });

  if (!command || command.sessionId !== resolved.id) {
    throw new AppError("NOT_FOUND", "Unknown command.");
  }

  const updated = await prisma.liveTestCommand.updateMany({
    where: { id: command.id, status: "DISPATCHED" },
    data: {
      status: input.errorCode ? "FAILED" : "COMPLETED",
      completedAt: new Date(),
      result: input.result ? input.result.slice(0, MAX_RESULT_CHARS) : null,
      errorCode: input.errorCode ? input.errorCode.slice(0, MAX_ERROR_CHARS) : null,
    },
  });

  // Not an error: a duplicate delivery is exactly what this guards against.
  return { accepted: updated.count === 1 };
}

/** Queues a tool call for the connected target. */
export async function queueCommand(
  owner: LiveTestOwner,
  tool: LiveTestTool,
  args: Record<string, unknown>,
): Promise<{ commandId: string } | null> {
  // Defence in depth: the caller validates too, but nothing consequential may
  // reach the queue through any path.
  if (!isLiveTestTool(tool)) {
    throw new AppError("FORBIDDEN", `${tool} cannot be dispatched automatically.`);
  }

  // Only a test this very session started. Another visitor's connected tab on
  // the same site is not ours to command.
  const session = await prisma.liveTestSession.findFirst({
    where: {
      siteId: owner.siteId,
      createdBySessionId: owner.builderSessionId,
      status: "READY",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, availableTools: true },
  });
  if (!session) return null;

  // A tool the target never registered — because the capability is disabled in
  // its pinned config — must not be dispatched. `get_education` being off in
  // v2 is exactly this case.
  const advertised = Array.isArray(session.availableTools)
    ? (session.availableTools as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  if (advertised.length > 0 && !advertised.includes(tool)) return null;

  const queued = await prisma.liveTestCommand.count({ where: { sessionId: session.id } });
  if (queued >= MAX_COMMANDS_PER_SESSION) {
    throw new AppError("RATE_LIMITED", "This live test session has run enough commands.");
  }

  const created = await prisma.liveTestCommand.create({
    data: { sessionId: session.id, tool, arguments: asJson(args) },
  });

  return { commandId: created.id };
}

/** Polls for a command's outcome, from the Forge side. */
export async function readCommand(commandId: string): Promise<LiveTestCommand | null> {
  return prisma.liveTestCommand.findUnique({ where: { id: commandId } });
}

/**
 * Waits for the target to answer, or gives up.
 *
 * Deliberately a bounded poll rather than anything long-lived: if the tab was
 * closed or the runtime is not installed, the honest outcome is a timeout.
 */
export async function awaitCommandResult(
  commandId: string,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ status: "completed"; result: string } | { status: "failed" | "timeout"; errorCode?: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const command = await readCommand(commandId);
    if (command?.status === "COMPLETED") {
      return { status: "completed", result: command.result ?? "" };
    }
    if (command?.status === "FAILED") {
      return { status: "failed", errorCode: command.errorCode ?? "tool_failed" };
    }
    if (Date.now() >= deadline) return { status: "timeout" };
    await sleep(intervalMs);
  }
}

/** Ends a session early, e.g. when the owner closes the panel. */
export async function closeLiveTest(session: BuilderSession, siteId: string): Promise<void> {
  const site = await requireOwnedSiteFor(session, siteId);
  // Only this session's own tests. Ending someone else's would be a way to
  // disrupt another visitor on a shared site.
  await prisma.liveTestSession.updateMany({
    where: {
      siteId: site.id,
      createdBySessionId: session.id,
      status: { in: ["PENDING", "READY"] },
    },
    data: { status: "CLOSED", closedAt: new Date() },
  });
}

/** Whether a live target started by this session is currently connected. */
export async function getLiveTestState(
  owner: LiveTestOwner,
): Promise<{ connected: boolean; expiresAt: string | null; availableTools: string[] }> {
  const session = await prisma.liveTestSession.findFirst({
    where: {
      siteId: owner.siteId,
      createdBySessionId: owner.builderSessionId,
      status: "READY",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { expiresAt: true, availableTools: true },
  });

  return {
    connected: Boolean(session),
    expiresAt: session?.expiresAt.toISOString() ?? null,
    availableTools: Array.isArray(session?.availableTools)
      ? (session.availableTools as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  };
}
