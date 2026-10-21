// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerifySection } from "@/components/builder/verify-section";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";

const mocks = vi.hoisted(() => ({ useBuilder: vi.fn(), start: vi.fn(), refresh: vi.fn() }));
vi.mock("@/components/builder/builder-provider", () => ({ useBuilder: mocks.useBuilder }));
vi.mock("@/components/builder/repair-panel", () => ({ RepairPanel: () => null }));
vi.mock("@/components/builder/section-error", () => ({ SectionError: () => null }));
let root: Root;
let container: HTMLDivElement;
const state = { ...EMPTY_BUILDER_STATE, siteId: "A", installation: {} };
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "open").mockReturnValue(null);
  mocks.start.mockReset().mockResolvedValue({ verifyUrl: "https://a.example/verify" });
  mocks.refresh.mockReset().mockResolvedValue(state);
  mocks.useBuilder.mockReturnValue({ state, actions: { getState: () => state, startVerification: mocks.start, refreshState: mocks.refresh } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(VerifySection)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("verification polling lifecycle", () => {
  it("does not revive a cancelled poll when a new check starts", async () => {
    await act(async () => button("Check installation").click());
    await act(async () => button("Cancel").click());
    await act(async () => button("Check installation").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("stops polling after the panel unmounts", async () => {
    await act(async () => button("Check installation").click());
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("does not open a verification tab after the panel unmounts during startup", async () => {
    let finish!: (value: { verifyUrl: string }) => void;
    mocks.start.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => button("Check installation").click());
    await act(async () => root.render(null));
    await act(async () => finish({ verifyUrl: "https://a.example/verify" }));
    expect(window.open).not.toHaveBeenCalled();
  });
});
