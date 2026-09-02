import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "@/runtime/config-guard";
import { buildRuntimeConfig } from "./helpers";

describe("parseRuntimeConfig", () => {
  it("accepts the runtime-safe configuration emitted by the server", () => {
    const config = buildRuntimeConfig();
    expect(parseRuntimeConfig(config)).toEqual(config);
  });

  it("fails closed for unsafe selectors and route-shaped cross-origin navigation", () => {
    const unsafeSelector = buildRuntimeConfig({
      mapping: {
        ...buildRuntimeConfig().mapping,
        projects: {
          ...buildRuntimeConfig().mapping.projects!,
          itemSelector: "<script>alert(1)</script>",
        },
      },
    });
    expect(parseRuntimeConfig(unsafeSelector)).toBeNull();

    const schemeRelativeNavigation = buildRuntimeConfig({
      mapping: {
        ...buildRuntimeConfig().mapping,
        navigation: { items: [{ label: "Elsewhere", path: "//evil.example" }] },
      },
    });
    expect(parseRuntimeConfig(schemeRelativeNavigation)).toBeNull();
  });

  it("rejects malformed public fields before registering any browser tools", () => {
    expect(parseRuntimeConfig({ ...buildRuntimeConfig(), origin: "not a URL" })).toBeNull();
    expect(parseRuntimeConfig({ ...buildRuntimeConfig(), configVersion: 0 })).toBeNull();
    expect(
      parseRuntimeConfig({
        ...buildRuntimeConfig(),
        mapping: { version: 1, projects: { route: "/", itemSelector: ".card", fields: {} } },
      }),
    ).not.toBeNull();
  });
});
