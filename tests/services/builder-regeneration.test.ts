import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Site } from "@/generated/prisma/client";
import { buildStateForSite } from "@/lib/services/builder-service";

const mocks = vi.hoisted(() => ({ latest: vi.fn(), capabilities: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  configVersion: { findFirst: mocks.latest },
  aiUsageEvent: { count: async () => 0 },
} }));
vi.mock("@/lib/env", () => ({ appOrigin: () => "https://forge.example", getEnv: () => ({ GEMINI_NL_DEMO_MAX_QUESTIONS: 10 }) }));
vi.mock("@/lib/services/scan-service", () => ({ getLatestScan: async () => null }));
vi.mock("@/lib/services/verification-service", () => ({ getVerificationState: async () => null }));
vi.mock("@/lib/services/config-service", () => ({
  loadCurrentSettings: async () => ({ mapping: { version: 1 }, settings: {} }),
  describeCapabilities: mocks.capabilities,
}));

const site = { id: "site", publicId: "wmf_site", canonicalUrl: "https://site.example/", origin: "https://site.example", platform: "CUSTOM" } as Site;
const generatedAt = new Date("2026-01-01T00:00:00Z");
beforeEach(() => {
  mocks.latest.mockResolvedValue({ version: 1, createdAt: generatedAt, publishedAt: generatedAt, runtimeConfig: {
    schemaVersion: 1, siteId: "wmf_site", configVersion: 1, origin: site.origin,
    enabledCapabilities: ["get_profile"], mapping: { version: 1 }, generatedAt: generatedAt.toISOString(),
  } });
});
describe("snippet regeneration after editing capabilities", () => {
  it("offers regeneration when a generated capability is disabled", async () => {
    mocks.capabilities.mockReturnValue([{ id: "get_profile", enabled: false }]);
    expect((await buildStateForSite(site)).installation?.needsRegeneration).toBe(true);
  });
  it("offers regeneration when a new capability is enabled", async () => {
    mocks.capabilities.mockReturnValue([{ id: "get_profile", enabled: true }, { id: "get_skills", enabled: true }]);
    expect((await buildStateForSite(site)).installation?.needsRegeneration).toBe(true);
  });
  it("does not request regeneration when settings match the generated snippet", async () => {
    mocks.capabilities.mockReturnValue([{ id: "get_profile", enabled: true }, { id: "get_skills", enabled: false }]);
    expect((await buildStateForSite(site)).installation?.needsRegeneration).toBe(false);
  });
});
