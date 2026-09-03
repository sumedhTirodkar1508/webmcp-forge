// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContactFormMapping } from "@/lib/ai/mapping-schema";
import { resetDrafts } from "@/runtime/contact-form";
import { buildTools, type ToolContext } from "@/runtime/tools";

import { buildRuntimeConfig, buildSiteMapping, createDocument } from "./helpers";

/**
 * The contact-message capability.
 *
 * Two properties matter more than anything else here and are asserted
 * repeatedly below:
 *
 *   1. `prepare_contact_message` submits NOTHING. It stages a draft in page
 *      memory and says so.
 *   2. `send_contact_message` submits at most once, and only after the person
 *      at the browser approves. An agent cannot approve on their behalf.
 */

const FORM_HTML = `
  <main>
    <form id="contact" action="/thanks" method="post">
      <label for="cf-name">Name</label>
      <input id="cf-name" name="name" type="text" />
      <label for="cf-email">Email</label>
      <input id="cf-email" name="email" type="email" />
      <label for="cf-subject">Subject</label>
      <input id="cf-subject" name="subject" type="text" />
      <label for="cf-message">Message</label>
      <textarea id="cf-message" name="message" required></textarea>
      <button id="cf-submit" type="submit">Send</button>
    </form>
  </main>`;

const formMapping: ContactFormMapping = {
  route: "*",
  formSelector: "#contact",
  submitSelector: "#cf-submit",
  fields: {
    name: "#cf-name",
    email: "#cf-email",
    subject: "#cf-subject",
    message: "#cf-message",
  },
  support: "SUPPORTED",
  reasons: [],
};

interface Harness {
  ctx: ToolContext;
  doc: Document;
  confirmSpy: ReturnType<typeof vi.fn>;
  submitSpy: ReturnType<typeof vi.fn>;
  call: (name: string, input?: Record<string, unknown>) => Promise<Result>;
}

interface Result {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function harness(options: {
  html?: string;
  mapping?: ContactFormMapping | undefined;
  approve?: boolean;
} = {}): Harness {
  const doc = createDocument(options.html ?? FORM_HTML);
  const mappingValue = "mapping" in options ? options.mapping : formMapping;

  const config = buildRuntimeConfig({
    mapping: buildSiteMapping(mappingValue ? { contactForm: mappingValue } : {}),
    enabledCapabilities: ["prepare_contact_message", "send_contact_message"],
  });

  const confirmSpy = vi.fn(() => options.approve ?? true);

  // happy-dom does not implement requestSubmit, and we want to observe it
  // rather than actually navigate.
  const submitSpy = vi.fn();
  const form = doc.querySelector("form");
  if (form) {
    Object.defineProperty(form, "requestSubmit", { value: submitSpy, configurable: true });
  }

  const ctx: ToolContext = {
    config,
    doc,
    currentUrl: () => "https://portfolio.test/contact",
    confirm: confirmSpy,
  };

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = buildTools(ctx).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} was not registered`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Result;
  };

  return { ctx, doc, confirmSpy, submitSpy, call };
}

beforeEach(() => {
  resetDrafts();
});

describe("prepare_contact_message", () => {
  it("stages a draft without submitting anything", async () => {
    const { call, submitSpy, confirmSpy } = harness();

    const result = await call("prepare_contact_message", {
      name: "Ada",
      email: "ada@example.com",
      message: "I would like to talk about a role.",
    });

    expect(result.structuredContent).toMatchObject({ prepared: true, sent: false });
    expect(result.content[0]?.text).toContain("Nothing has been sent.");
    expect(typeof result.structuredContent?.confirmationId).toBe("string");

    // The load-bearing assertion: nothing was submitted and nobody was asked.
    expect(submitSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const { call } = harness();
    const result = await call("prepare_contact_message", { message: "   " });
    expect(result.structuredContent).toMatchObject({ prepared: false });
  });

  it("refuses an invalid email address", async () => {
    const { call } = harness();
    const result = await call("prepare_contact_message", {
      email: "not-an-email",
      message: "hello",
    });
    expect(result.structuredContent).toMatchObject({ prepared: false });
  });

  it("reports honestly when the mapped form has been removed", async () => {
    const { call } = harness({ html: "<main><p>No form here any more.</p></main>" });
    const result = await call("prepare_contact_message", { message: "hello" });
    expect(result.structuredContent).toMatchObject({ prepared: false });
    expect(result.content[0]?.text).toContain("no longer on this page");
  });
});

describe("send_contact_message", () => {
  async function prepared(h: Harness): Promise<string> {
    const result = await h.call("prepare_contact_message", {
      name: "Ada",
      email: "ada@example.com",
      subject: "Hello",
      message: "I would like to talk about a role.",
    });
    return result.structuredContent?.confirmationId as string;
  }

  it("submits exactly once after the person approves", async () => {
    const h = harness({ approve: true });
    const confirmationId = await prepared(h);

    const result = await h.call("send_contact_message", { confirmationId, confirmed: true });

    expect(h.confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.confirmSpy.mock.calls[0]?.[0]).toContain("existing contact form");
    expect(h.submitSpy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ sent: true });
    // Never claim delivery — we only handed it to the site's own form.
    expect(result.content[0]?.text).toBe(
      "The portfolio's existing form submission was initiated.",
    );
    expect(result.content[0]?.text.toLowerCase()).not.toContain("email");
  });

  it("fills the mapped fields from the staged draft", async () => {
    const h = harness({ approve: true });
    const confirmationId = await prepared(h);
    await h.call("send_contact_message", { confirmationId, confirmed: true });

    expect(h.doc.querySelector<HTMLTextAreaElement>("#cf-message")?.value).toBe(
      "I would like to talk about a role.",
    );
    expect(h.doc.querySelector<HTMLInputElement>("#cf-name")?.value).toBe("Ada");
    expect(h.doc.querySelector<HTMLInputElement>("#cf-email")?.value).toBe("ada@example.com");
  });

  it("submits nothing when the person declines", async () => {
    const h = harness({ approve: false });
    const confirmationId = await prepared(h);

    const result = await h.call("send_contact_message", { confirmationId, confirmed: true });

    expect(h.confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.submitSpy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ sent: false, reason: "declined" });
  });

  it("refuses without a prepare step", async () => {
    const h = harness();
    const result = await h.call("send_contact_message", {
      confirmationId: "0".repeat(32),
      confirmed: true,
    });
    expect(result.structuredContent).toMatchObject({ sent: false, reason: "unknown" });
    expect(h.submitSpy).not.toHaveBeenCalled();
  });

  it("refuses when confirmed is not true", async () => {
    const h = harness();
    const confirmationId = await prepared(h);

    for (const confirmed of [false, "true", 1, undefined]) {
      const result = await h.call("send_contact_message", { confirmationId, confirmed });
      expect(result.structuredContent).toMatchObject({ sent: false });
    }
    expect(h.confirmSpy).not.toHaveBeenCalled();
    expect(h.submitSpy).not.toHaveBeenCalled();
  });

  it("refuses a confirmationId that has already been used", async () => {
    const h = harness({ approve: true });
    const confirmationId = await prepared(h);

    await h.call("send_contact_message", { confirmationId, confirmed: true });
    const second = await h.call("send_contact_message", { confirmationId, confirmed: true });

    // At most once, even for a deliberate replay.
    expect(h.submitSpy).toHaveBeenCalledTimes(1);
    expect(second.structuredContent).toMatchObject({ sent: false, reason: "consumed" });
  });

  it("does not resubmit when two sends race the same confirmationId", async () => {
    const h = harness({ approve: true });
    const confirmationId = await prepared(h);

    await Promise.all([
      h.call("send_contact_message", { confirmationId, confirmed: true }),
      h.call("send_contact_message", { confirmationId, confirmed: true }),
    ]);

    expect(h.submitSpy).toHaveBeenCalledTimes(1);
  });

  it("respects the site's own form validation", async () => {
    // A required field the mapping knows nothing about must still block
    // submission — we never bypass the site's constraints.
    const html = FORM_HTML.replace(
      '<input id="cf-subject" name="subject" type="text" />',
      '<input id="cf-extra" name="extra" type="text" required />',
    );
    const h = harness({ html, approve: true });
    const confirmationId = await prepared(h);

    const result = await h.call("send_contact_message", { confirmationId, confirmed: true });

    expect(h.submitSpy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ sent: false, reason: "invalid" });
  });

  it("reports honestly when the form disappeared after preparing", async () => {
    const h = harness({ approve: true });
    const confirmationId = await prepared(h);
    h.doc.querySelector("#contact")?.remove();

    const result = await h.call("send_contact_message", { confirmationId, confirmed: true });

    expect(h.submitSpy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ sent: false, reason: "form_missing" });
  });
});

describe("capability availability", () => {
  it("registers neither tool when no contact form was detected", () => {
    const { ctx } = harness({ mapping: undefined });
    const names = buildTools(ctx).map((tool) => tool.name);
    expect(names).not.toContain("prepare_contact_message");
    expect(names).not.toContain("send_contact_message");
  });

  it("registers neither tool for a CAPTCHA-protected form", () => {
    // An UNSUPPORTED form would produce tools that can only ever fail.
    const { ctx } = harness({
      mapping: { ...formMapping, support: "UNSUPPORTED", reasons: ["CAPTCHA detected"] },
    });
    const names = buildTools(ctx).map((tool) => tool.name);
    expect(names).not.toContain("prepare_contact_message");
    expect(names).not.toContain("send_contact_message");
  });
});

describe("privacy", () => {
  /**
   * The message must never leave the visitor's tab except through the site's
   * own form. It is not persisted in WebMCP Forge, not logged server-side, and
   * never sent to Gemini — so during the entire prepare/send cycle there must
   * be no network activity of our own at all.
   */
  it("makes no network request of its own while preparing or sending", async () => {
    const h = harness({ approve: true });
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const prepare = await h.call("prepare_contact_message", {
        name: "Ada",
        email: "ada@example.com",
        message: "Strictly confidential message body.",
      });
      const confirmationId = prepare.structuredContent?.confirmationId as string;
      await h.call("send_contact_message", { confirmationId, confirmed: true });
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the message out of every value it reports back", async () => {
    const h = harness({ approve: true });
    const secret = "Strictly confidential message body.";

    const prepare = await h.call("prepare_contact_message", { message: secret });
    const confirmationId = prepare.structuredContent?.confirmationId as string;
    const send = await h.call("send_contact_message", { confirmationId, confirmed: true });

    // The preview intentionally echoes the draft back to the visitor who wrote
    // it, but the SEND result — the thing most likely to be relayed onward —
    // must not carry the content.
    expect(JSON.stringify(send)).not.toContain(secret);
  });
});

describe("field distinctness when filling", () => {
  /**
   * The demo portfolio's deployed config v2 contains exactly this mapping,
   * where the scanner emitted a bare tag name for two different roles:
   *
   *     { name: "input", email: "input", message: "textarea" }
   *
   * Both roles resolved to the first input, so the email address was typed
   * into the name box and the email box stayed blank. The runtime now
   * re-resolves a colliding role against the live form, which repairs an
   * already-published configuration without regenerating it.
   */
  const BROAD_MAPPING: ContactFormMapping = {
    route: "*",
    formSelector: "#contact",
    submitSelector: "#cf-submit",
    fields: { name: "input", email: "input", message: "textarea" },
    support: "SUPPORTED",
    reasons: [],
  };

  const NAMED_FORM_HTML = `
    <main>
      <form id="contact" action="/thanks" method="post">
        <label for="cf-name">Name</label>
        <input id="cf-name" name="name" type="text" />
        <label for="cf-email">Email</label>
        <input id="cf-email" name="email" type="email" />
        <label for="cf-message">Message</label>
        <textarea id="cf-message" name="message" required></textarea>
        <button id="cf-submit" type="submit">Send</button>
      </form>
    </main>`;

  it("puts each value in its own field despite a broad stored mapping", async () => {
    const h = harness({ html: NAMED_FORM_HTML, mapping: BROAD_MAPPING, approve: true });

    const prepare = await h.call("prepare_contact_message", {
      name: "Test User",
      email: "test@example.com",
      message: "Hello from WebMCP Forge.",
    });
    const confirmationId = prepare.structuredContent?.confirmationId as string;
    await h.call("send_contact_message", { confirmationId, confirmed: true });

    // The exact regression: name must not receive the email address.
    expect(h.doc.querySelector<HTMLInputElement>("#cf-name")?.value).toBe("Test User");
    expect(h.doc.querySelector<HTMLInputElement>("#cf-email")?.value).toBe("test@example.com");
    expect(h.doc.querySelector<HTMLTextAreaElement>("#cf-message")?.value).toBe(
      "Hello from WebMCP Forge.",
    );
    expect(h.submitSpy).toHaveBeenCalledTimes(1);
  });

  it("fills correctly with precise selectors too", async () => {
    const precise: ContactFormMapping = {
      ...BROAD_MAPPING,
      fields: {
        name: 'input[name="name"]',
        email: 'input[name="email"]',
        message: 'textarea[name="message"]',
      },
    };
    const h = harness({ html: NAMED_FORM_HTML, mapping: precise, approve: true });

    const prepare = await h.call("prepare_contact_message", {
      name: "Test User",
      email: "test@example.com",
      message: "Hello from WebMCP Forge.",
    });
    await h.call("send_contact_message", {
      confirmationId: prepare.structuredContent?.confirmationId as string,
      confirmed: true,
    });

    expect(h.doc.querySelector<HTMLInputElement>("#cf-name")?.value).toBe("Test User");
    expect(h.doc.querySelector<HTMLInputElement>("#cf-email")?.value).toBe("test@example.com");
  });

  it("still submits nothing during prepare, even with a broad mapping", async () => {
    const h = harness({ html: NAMED_FORM_HTML, mapping: BROAD_MAPPING });

    const result = await h.call("prepare_contact_message", {
      name: "Test User",
      email: "test@example.com",
      message: "Hello from WebMCP Forge.",
    });

    expect(result.content[0]?.text).toContain("Nothing has been sent.");
    expect(h.submitSpy).not.toHaveBeenCalled();
    expect(h.confirmSpy).not.toHaveBeenCalled();
    // Nothing is typed into the page until the person approves.
    expect(h.doc.querySelector<HTMLInputElement>("#cf-name")?.value).toBe("");
    expect(h.doc.querySelector<HTMLTextAreaElement>("#cf-message")?.value).toBe("");
  });

  it("leaves a field blank rather than writing it into another field's control", async () => {
    // Only ONE input exists, so name and email cannot both be addressed.
    const h = harness({
      html: `
        <main>
          <form id="contact"><input id="only" type="text" />
            <textarea id="cf-message" required></textarea>
            <button id="cf-submit" type="submit">Send</button>
          </form>
        </main>`,
      mapping: BROAD_MAPPING,
      approve: true,
    });

    const prepare = await h.call("prepare_contact_message", {
      name: "Test User",
      email: "test@example.com",
      message: "Hello from WebMCP Forge.",
    });
    await h.call("send_contact_message", {
      confirmationId: prepare.structuredContent?.confirmationId as string,
      confirmed: true,
    });

    const only = h.doc.querySelector<HTMLInputElement>("#only")?.value;
    // Whichever role won, it must not hold the other role's value.
    expect(only === "test@example.com" || only === "Test User").toBe(true);
    expect(h.doc.querySelector<HTMLTextAreaElement>("#cf-message")?.value).toBe(
      "Hello from WebMCP Forge.",
    );
  });

  it("preserves cancel, single submit and replay protection", async () => {
    const declined = harness({ html: NAMED_FORM_HTML, mapping: BROAD_MAPPING, approve: false });
    const prepared = await declined.call("prepare_contact_message", {
      message: "Hello from WebMCP Forge.",
    });
    const id = prepared.structuredContent?.confirmationId as string;

    const cancelled = await declined.call("send_contact_message", {
      confirmationId: id,
      confirmed: true,
    });
    expect(cancelled.structuredContent).toMatchObject({ sent: false, reason: "declined" });
    expect(declined.submitSpy).not.toHaveBeenCalled();

    const approved = harness({ html: NAMED_FORM_HTML, mapping: BROAD_MAPPING, approve: true });
    const p2 = await approved.call("prepare_contact_message", {
      message: "Hello from WebMCP Forge.",
    });
    const id2 = p2.structuredContent?.confirmationId as string;

    await approved.call("send_contact_message", { confirmationId: id2, confirmed: true });
    const replay = await approved.call("send_contact_message", {
      confirmationId: id2,
      confirmed: true,
    });

    expect(approved.submitSpy).toHaveBeenCalledTimes(1);
    expect(replay.structuredContent).toMatchObject({ sent: false, reason: "consumed" });
  });
});
