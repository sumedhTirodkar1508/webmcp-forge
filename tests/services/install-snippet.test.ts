import { describe, expect, it } from "vitest";

import { buildScriptTag, RUNTIME_PATH } from "@/lib/services/install-service";

/**
 * The installation snippet.
 *
 * It carries two attributes with different jobs: `data-wmf-site` names the
 * website permanently, and `data-wmf-config` pins the exact configuration
 * version to run. The pin is what makes an ownership model unnecessary — a
 * configuration only takes effect when someone with deployment access changes
 * that number.
 */

describe("buildScriptTag", () => {
  const ORIGIN = "https://forge.example";
  const SITE = "wmf_0123456789ABCDEFGHJKMNPQ";

  it("includes both the site id and the pinned config version", () => {
    const tag = buildScriptTag(ORIGIN, SITE, 4);

    expect(tag).toContain(`data-wmf-site="${SITE}"`);
    expect(tag).toContain('data-wmf-config="4"');
    expect(tag).toContain(`src="${ORIGIN}${RUNTIME_PATH}"`);
    expect(tag).toContain("defer");
  });

  it("pins the exact version it is given, never a placeholder", () => {
    for (const version of [1, 2, 17, 1234]) {
      expect(buildScriptTag(ORIGIN, SITE, version)).toContain(
        `data-wmf-config="${version}"`,
      );
    }
    // No "latest" concept may leak into the snippet.
    expect(buildScriptTag(ORIGIN, SITE, 1).toLowerCase()).not.toContain("latest");
  });

  it("is a single copyable script element", () => {
    const tag = buildScriptTag(ORIGIN, SITE, 2);
    expect(tag.startsWith("<script")).toBe(true);
    expect(tag.trimEnd().endsWith("</script>")).toBe(true);
    // Both attributes must survive a copy — they are copied together or the
    // installation is broken.
    expect(tag.match(/data-wmf-/g)).toHaveLength(2);
  });
});
