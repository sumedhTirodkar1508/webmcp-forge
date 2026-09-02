import "server-only";

import { z } from "zod";

import { appOrigin } from "@/lib/env";
import { AppError, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Shared route-handler plumbing.
 *
 * Two jobs: turn any thrown value into a user-safe JSON error with the right
 * status, and refuse cross-site state changes. Nothing here ever puts an
 * exception message or stack trace into a response body.
 */

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export function jsonError(error: unknown): Response {
  const appError = toAppError(error);

  if (appError.code === "INTERNAL") {
    // Keep the real cause server-side.
    logger.error("unhandled_route_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json(appError.toJSON(), {
    status: appError.status,
    headers: { "cache-control": "no-store" },
  });
}

/** Body size guard, applied before parsing. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads and validates a JSON body.
 *
 * @throws {AppError} VALIDATION_FAILED with the offending field names — never
 * the submitted values, which may contain anything a user pasted.
 */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_FAILED", "That request was too large.");
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_FAILED", "That request was too large.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw || "{}");
  } catch {
    throw new AppError("VALIDATION_FAILED", "That request could not be understood.");
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "body"))];
    throw new AppError("VALIDATION_FAILED", "Some details were missing or invalid.", {
      fields,
    });
  }
  return result.data;
}

/**
 * Rejects cross-site state changes.
 *
 * The session cookie is `SameSite=Lax`, so a browser already withholds it from
 * cross-site POSTs. This is the second lock: an explicit check that the request
 * claims to come from us. Requests with no Origin at all (curl, server-to-server)
 * are allowed through — they carry no ambient cookie either, so they cannot be
 * the confused-deputy attack this defends against.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin === appOrigin()) return;

  throw new AppError("FORBIDDEN", "That request came from an unexpected origin.");
}
