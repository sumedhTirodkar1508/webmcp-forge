/**
 * Minimal structured logger.
 *
 * Deliberately dumb: it exists so that diagnostic output is consistent and
 * greppable, and so there is one obvious place to check that we are not logging
 * secrets. Never pass API keys, connection strings, raw session tokens or raw
 * verification challenges through it.
 */

type Level = "debug" | "info" | "warn" | "error";

const REDACTED_KEY = /(key|token|secret|password|authorization|challenge)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
