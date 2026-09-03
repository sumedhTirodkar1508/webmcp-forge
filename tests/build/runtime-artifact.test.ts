import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The runtime bundle must actually be produced by a production build.
 *
 * `/runtime/v1.js` is a public contract: every installed portfolio loads it by
 * that exact URL. `public/runtime` is gitignored, so if the build does not
 * generate it there is no committed copy to fall back on — the deployment
 * simply 404s for every site already installed, which is what happened in
 * production when the `prebuild` lifecycle hook did not run.
 */

const OUTFILE = "public/runtime/v1.js";

describe("runtime bundle production", () => {
  it("is produced by the bundler and is non-empty", () => {
    // Runs the same script the build does; it is fast (~15ms).
    execFileSync("node", ["scripts/build-runtime.mjs"], { stdio: "pipe" });

    expect(existsSync(OUTFILE)).toBe(true);
    expect(statSync(OUTFILE).size).toBeGreaterThan(1000);
  });

  it("contains the runtime, not an empty or partial file", () => {
    const source = readFileSync(OUTFILE, "utf8");

    expect(source).toContain("data-wmf-site");
    expect(source).toContain("wmfConfig");
    // No server-only code may be bundled into a public browser asset.
    expect(source).not.toContain("PrismaClient");
    expect(source).not.toContain("DATABASE_URL");
  });

  it("is built by `pnpm build` explicitly, not via a lifecycle hook", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    // A `prebuild` hook is not honoured by every package manager, nor by a
    // framework preset that invokes `next build` directly — which is exactly
    // how the artifact went missing in production.
    expect(pkg.scripts.prebuild).toBeUndefined();
    expect(pkg.scripts.build).toContain("build:runtime");

    // It must run BEFORE next build, which copies `public/` into the output.
    const build = pkg.scripts.build;
    expect(build.indexOf("build:runtime")).toBeLessThan(build.indexOf("next build"));
  });

  it("keeps the public URL contract stable", () => {
    const script = readFileSync("scripts/build-runtime.mjs", "utf8");
    // Installed sites hard-code this path; it cannot move.
    expect(script).toContain('"public", "runtime", "v1.js"');
  });

  it("fails the build rather than emitting nothing", () => {
    const script = readFileSync("scripts/build-runtime.mjs", "utf8");
    // A silent no-op build is what produced a 404 deployment.
    expect(script).toContain("runtime bundle was not written");
  });
});
