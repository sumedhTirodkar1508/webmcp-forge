import { describe, expect, it } from "vitest";

import { deriveProgress, isInstalled } from "@/components/builder/progress";
import { EMPTY_BUILDER_STATE, type BuilderState } from "@/lib/services/types";

/**
 * Setup progress.
 *
 * The key correction: "Install" used to show a checkmark as soon as a
 * configuration was GENERATED. Generating installs nothing — the step is only
 * done once the snippet is observed on the site or a verification succeeds.
 */

const scanned: BuilderState = {
  ...EMPTY_BUILDER_STATE,
  siteId: "s",
  discovery: {
    platform: "CUSTOM",
    platformConfidence: 1,
    pagesScanned: 1,
    routePatterns: ["/"],
    found: {},
    missing: [],
    warnings: [],
    lowInformation: false,
    usedAi: true,
    aiModel: "m",
    aiFellBack: false,
    scannedAt: "2026-01-01T00:00:00.000Z",
    installedSnippet: null,
  },
};

const generated: BuilderState = {
  ...scanned,
  installation: {
    publicId: "wmf_X",
    scriptTag: "<script></script>",
    runtimeUrl: "https://forge.example/runtime/v1.js",
    platform: "CUSTOM",
    latestGeneratedVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    installedVersion: null,
  },
};

const states = (s: BuilderState) =>
  Object.fromEntries(deriveProgress(s).map((step) => [step.key, step.state]));

describe("deriveProgress", () => {
  it("starts with Scan as the current step", () => {
    expect(states(EMPTY_BUILDER_STATE)).toEqual({
      scan: "current",
      choose: "upcoming",
      install: "upcoming",
      verify: "upcoming",
      test: "upcoming",
    });
  });

  it("moves to Choose once a scan exists", () => {
    expect(states(scanned)).toMatchObject({ scan: "done", choose: "current" });
  });

  it("does NOT mark Install done merely because a config was generated", () => {
    const s = states(generated);
    expect(s.choose).toBe("done");
    expect(s.install).toBe("current");
    expect(isInstalled(generated)).toBe(false);
  });

  it("marks Install done when the snippet is detected on the site", () => {
    const detected: BuilderState = {
      ...generated,
      installation: { ...generated.installation!, installedVersion: 1 },
    };
    expect(states(detected)).toMatchObject({ install: "done", verify: "current" });
  });

  it("marks Install and Verify done after a successful verification", () => {
    const verified: BuilderState = {
      ...generated,
      verification: {
        status: "success",
        checkedAt: "2026-01-01T00:00:00.000Z",
        runtimeVersion: "1.0.0",
        configVersion: 1,
        webmcpAvailable: true,
        toolsRegistered: 3,
        diagnostics: [],
        liveCounts: {},
        changes: [],
      },
    };
    expect(states(verified)).toMatchObject({
      install: "done",
      verify: "done",
      test: "current",
    });
  });

  it("does not treat a FAILED verification as verified or installed", () => {
    const failed: BuilderState = {
      ...generated,
      verification: {
        status: "failed",
        checkedAt: "2026-01-01T00:00:00.000Z",
        runtimeVersion: null,
        configVersion: null,
        webmcpAvailable: false,
        toolsRegistered: 0,
        diagnostics: [],
        liveCounts: {},
        changes: [],
      },
    };
    expect(states(failed)).toMatchObject({ install: "current", verify: "upcoming" });
  });

  it("only ever has one current step", () => {
    for (const s of [EMPTY_BUILDER_STATE, scanned, generated]) {
      expect(deriveProgress(s).filter((step) => step.state === "current")).toHaveLength(1);
    }
  });
});
