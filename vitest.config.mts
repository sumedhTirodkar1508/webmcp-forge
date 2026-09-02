import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite resolves the `@/*` alias from tsconfig.json natively.
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws when it is loaded outside a React Server
      // Component. It exists to catch an import from client code at build
      // time, and the App Router build still enforces that — but under Vitest
      // there is no server/client graph, so it is stubbed out.
      "server-only": new URL("./tests/setup/server-only-stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // Integration suites share one database; running them in parallel would
    // have them delete each other's fixtures.
    fileParallelism: false,
    // The runtime bundle is browser code; those suites opt into a DOM per file
    // with `// @vitest-environment happy-dom`.
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/runtime/**"],
    },
  },
});
