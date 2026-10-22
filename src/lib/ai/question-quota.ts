import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/**
 * The per-site limit on natural-language demo questions — the one definition.
 *
 * What counts as "one question" was written out four times and had drifted:
 * the builder counted every successful row (so a live answer, which records a
 * route attempt AND a summary attempt, counted twice), and Insights counted
 * only within the latest 25 rows. Every caller now uses this.
 *
 * One question = one successful routing attempt: status SUCCESS, no errorCode.
 * Summary attempts carry errorCode "summarize", and failed attempts never have
 * status SUCCESS, so neither is counted.
 */
export function questionRowsWhere(siteId: string): Prisma.AiUsageEventWhereInput {
  return { siteId, purpose: "NL_DEMO", status: "SUCCESS", errorCode: null };
}

export async function countQuestionsUsed(siteId: string): Promise<number> {
  return prisma.aiUsageEvent.count({ where: questionRowsWhere(siteId) });
}

export async function questionsRemaining(siteId: string): Promise<number> {
  return Math.max(0, getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS - (await countQuestionsUsed(siteId)));
}

/**
 * How long a reservation holds a slot if its request dies without releasing
 * it. Comfortably longer than the slowest question: routing, a live tool call
 * and a summary each have their own budget.
 */
export const RESERVATION_TTL_MS = 2 * 60 * 1000;

export interface QuestionReservation {
  /** Frees the slot. Safe to call more than once; never throws. */
  release: () => Promise<void>;
}

/**
 * Holds one question slot for this site, or refuses if none are left.
 *
 * Counting finished questions and then calling the model let several questions
 * sent together all pass the check before any was recorded. Here the check and
 * the hold happen together under a transaction-scoped advisory lock keyed on
 * the site, and in-flight reservations count against the limit. The model call
 * itself happens after, outside the lock.
 *
 * A finished question is then counted by its own successful routing row; the
 * reservation is released whatever the outcome, so a failed question costs
 * nothing.
 */
export async function reserveQuestion(siteId: string): Promise<QuestionReservation> {
  const limit = getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS;
  const staleBefore = new Date(Date.now() - RESERVATION_TTL_MS);

  const reservationId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nl-quota:${siteId}`}, 0))`;

    // Reservations from requests that died never released; clear them here.
    await tx.aiUsageEvent.deleteMany({
      where: { siteId, purpose: "NL_DEMO", status: "RESERVED", createdAt: { lt: staleBefore } },
    });

    const [used, inFlight] = await Promise.all([
      tx.aiUsageEvent.count({ where: questionRowsWhere(siteId) }),
      tx.aiUsageEvent.count({ where: { siteId, purpose: "NL_DEMO", status: "RESERVED" } }),
    ]);

    if (used + inFlight >= limit) {
      throw new AppError(
        "DEMO_LIMIT_REACHED",
        inFlight > 0 && used < limit
          ? "Another question for this portfolio is still being answered. Try again in a moment."
          : `The assistant is limited to ${limit} questions for this portfolio.`,
      );
    }

    const row = await tx.aiUsageEvent.create({
      data: { siteId, purpose: "NL_DEMO", status: "RESERVED", model: "reservation" },
      select: { id: true },
    });
    return row.id;
  });

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await prisma.aiUsageEvent.deleteMany({ where: { id: reservationId } }).catch(() => {
        // Left behind, it simply expires after RESERVATION_TTL_MS.
      });
    },
  };
}
