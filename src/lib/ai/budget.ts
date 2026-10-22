import "server-only";

import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

/**
 * The deployment-wide AI spend ceiling.
 *
 * The other limits are narrower than the thing they protect: scans are limited
 * per anonymous browser session (cleared by deleting a cookie) and questions
 * per site (a new site resets it). Neither bounds the total, so a determined
 * visitor can spend arbitrarily on the owner's API key. This counts every model
 * request — each attempt in `ai_usage_events`, successful or not, since a
 * failed request is still billed work — across all visitors over a rolling
 * 24 hours.
 *
 * It is a soft cap by design: the count and the request are not one atomic
 * step, so a burst can overshoot by roughly the number of requests in flight.
 * That is fine for a spend ceiling and avoids a global lock on every request.
 */

export const AI_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AiBudget {
  /** The configured ceiling; 0 means the cap is off. */
  limit: number;
  used: number;
  exhausted: boolean;
}

/** Pure, so the rule is testable without a database. */
export function evaluateAiBudget(limit: number, used: number): AiBudget {
  return { limit, used, exhausted: limit > 0 && used >= limit };
}

export async function getAiBudget(now: Date = new Date()): Promise<AiBudget> {
  const limit = getEnv().AI_GLOBAL_DAILY_LIMIT;
  // Off: skip the query entirely.
  if (limit === 0) return evaluateAiBudget(0, 0);

  const used = await prisma.aiUsageEvent.count({
    where: {
      createdAt: { gte: new Date(now.getTime() - AI_BUDGET_WINDOW_MS) },
      // A held question slot is not a model request.
      status: { not: "RESERVED" },
    },
  });
  return evaluateAiBudget(limit, used);
}
