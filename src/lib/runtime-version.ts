/**
 * Constants shared by the server and the installed browser runtime.
 *
 * Deliberately import-free. `runtime-config.ts` needs Zod to validate a payload
 * server-side, but the browser runtime only needs these two numbers — and it is
 * bundled into a script that loads on every visitor's page view, so pulling a
 * validation library along for a version string is not acceptable.
 */

export const RUNTIME_SCHEMA_VERSION = 1;

/** Bumped when the runtime's behaviour changes in a way verification should see. */
export const RUNTIME_VERSION = "1.0.0";
