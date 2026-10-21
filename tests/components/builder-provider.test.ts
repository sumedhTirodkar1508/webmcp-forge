// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderProvider, useBuilder } from "@/components/builder/builder-provider";
import { EMPTY_BUILDER_STATE, type BuilderState } from "@/lib/services/types";

vi.mock("@/lib/webmcp/client", () => ({
  checkWebMcpAvailability: () => ({ available: false, reason: "not_a_browser" }),
  registerTools: vi.fn(),
}));

const site = (siteId: string): BuilderState => ({ ...EMPTY_BUILDER_STATE, siteId });
let context: ReturnType<typeof useBuilder>;
let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
function Probe() {
  const value = useBuilder();
  useEffect(() => { context = value; }, [value]);
  return null;
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const props = { initialState: site("A"), children: createElement(Probe) };
  await act(async () => { root.render(createElement(BuilderProvider, props)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("real builder provider state isolation", () => {
  it("does not select a different site when an explicit background refresh returns", async () => {
    fetchMock.mockResolvedValueOnce(json(site("B")));
    await act(async () => { await context.actions.refreshState("B"); });
    expect(context.state.siteId).toBe("A");
  });
  it("supports a target-to-scan chain before React commits", async () => {
    fetchMock.mockResolvedValueOnce(json(site("B"))).mockResolvedValueOnce(json({ ...site("B"), title: "Scanned" }));
    await act(async () => {
      await context.actions.setTargetUrl("https://b.example");
      await context.actions.scan();
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).siteId).toBe("B");
    expect(context.state.title).toBe("Scanned");
  });
  it("ignores a refresh started before the target changes", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    let pending!: Promise<BuilderState>;
    await act(async () => { pending = context.actions.refreshState(); });
    fetchMock.mockResolvedValueOnce(json(site("B")));
    await act(async () => { await context.actions.setTargetUrl("https://b.example"); });
    await act(async () => { finish(json(site("A"))); await pending; });
    expect(context.state.siteId).toBe("B");
  });
});

describe("live-test recovery", () => {
  it("keeps waiting and exposes a fallback URL until the portfolio connects", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    fetchMock.mockResolvedValueOnce(json({ testUrl: "https://a.example/test", expiresAt }));
    await act(async () => { await context.startLiveTest(); });
    fetchMock.mockResolvedValueOnce(json({ connected: false, expiresAt: null, availableTools: [] }));
    await act(async () => { await context.refreshLiveTest(); });
    expect(context.liveTest).toMatchObject({ starting: true, testUrl: "https://a.example/test", expiresAt });
    fetchMock.mockResolvedValueOnce(json({ connected: true, expiresAt, availableTools: ["get_profile"] }));
    await act(async () => { await context.refreshLiveTest(); });
    expect(context.liveTest).toMatchObject({ starting: false, connected: true, testUrl: null });
  });
  it("does not open a late startup response after the user cancels", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    let starting!: Promise<void>;
    await act(async () => { starting = context.startLiveTest(); });
    fetchMock.mockResolvedValueOnce(json({ connected: false }));
    await act(async () => { await context.stopLiveTest(); });
    await act(async () => {
      finish(json({ testUrl: "https://a.example/test", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      await starting;
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(context.liveTest.starting).toBe(false);
  });
  it("surfaces stop failures instead of pretending the session ended", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => { await context.stopLiveTest(); });
    expect(context.error).toBe("Connection lost");
    expect(context.errorSection).toBe("ask");
  });
});
