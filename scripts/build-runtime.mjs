import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

/**
 * Bundles the installed browser runtime to `public/runtime/v1.js`.
 *
 * The runtime is authored as TypeScript so it can share the capability
 * catalogue and mapping types with the server and be unit-tested, but it ships
 * as a single plain-JavaScript file with no framework and no dependencies. It
 * is served as a static asset, so an installed portfolio costs us nothing at
 * runtime.
 *
 * The URL `/runtime/v1.js` is part of the public contract: a site owner pastes
 * that script tag once and never touches it again, so the filename must stay
 * stable across configuration changes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "public", "runtime", "v1.js");
const watch = process.argv.includes("--watch");

await mkdir(path.dirname(outfile), { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(root, "src", "runtime", "index.ts")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  // Broad enough for the browsers WebMCP is landing in, without transpiling
  // modern syntax the feature detection already guards.
  target: ["es2020"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  banner: {
    js: "/* WebMCP Forge runtime — https://github.com/sumedhTirodkar1508/webmcp-forge — MIT */",
  },
  define: { "process.env.NODE_ENV": '"production"' },
  // Resolve the `@/*` path alias the same way tsconfig.json does.
  alias: { "@": path.join(root, "src") },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching → ${path.relative(root, outfile)}`);
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const [, meta] = Object.entries(result.metafile.outputs)[0];
  console.log(
    `built ${path.relative(root, outfile)} (${(meta.bytes / 1024).toFixed(1)} kB minified)`,
  );
}
