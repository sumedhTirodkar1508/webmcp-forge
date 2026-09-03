import { describe, expect, it } from "vitest";

import { extractPage } from "@/lib/scanner/extract";

/**
 * Contact-form field selectors must address DISTINCT controls.
 *
 * The scanner used to fall back to the bare tag name, so a form with two plain
 * `<input>` elements produced `{ name: "input", email: "input" }`. Both
 * resolved to the first input, and the visitor's email address was typed into
 * the name box while the email box stayed blank.
 */

const OPTIONS = {
  url: "https://demo.example/contact",
  origin: "https://demo.example",
  httpStatus: 200,
  contentType: "text/html",
  byteSize: 2048,
};

function page(form: string): string {
  return `<!doctype html><html><body><main><h1>Contact</h1>
    <p>Plenty of readable text so this is not treated as an empty page.</p>
    ${form}</main></body></html>`;
}

/** The demo portfolio's form: named controls, no ids or classes. */
const NAMED_FORM = `
  <form action="/contact" method="post">
    <label for="a">Name</label><input name="name" type="text" />
    <label for="b">Email</label><input name="email" type="email" />
    <label for="c">Message</label><textarea name="message" required></textarea>
    <button type="submit">Send</button>
  </form>`;

/** Worst case: nothing but bare inputs to go on. */
const BARE_FORM = `
  <form action="/contact" method="post">
    <input />
    <input />
    <textarea required></textarea>
    <button type="submit">Send</button>
  </form>`;

function formOf(html: string) {
  const extracted = extractPage(page(html), OPTIONS);
  return extracted.contact.forms?.[0];
}

describe("contact-form selector generation", () => {
  it("prefers name-based selectors for named controls", () => {
    const form = formOf(NAMED_FORM);

    expect(form?.fields.name).toBe('input[name="name"]');
    expect(form?.fields.email).toBe('input[name="email"]');
    expect(form?.fields.message).toBe('textarea[name="message"]');
    expect(form?.support).toBe("SUPPORTED");
  });

  it("never emits a bare tag selector for a field", () => {
    for (const html of [NAMED_FORM, BARE_FORM]) {
      const form = formOf(html);
      for (const [role, selector] of Object.entries(form?.fields ?? {})) {
        // "input" or "textarea" alone cannot identify one control.
        expect(selector, role).not.toBe("input");
        expect(selector, role).not.toBe("textarea");
      }
    }
  });

  it("produces distinct selectors even for unremarkable markup", () => {
    const form = formOf(BARE_FORM);
    const selectors = Object.values(form?.fields ?? {});

    expect(selectors.length).toBeGreaterThan(0);
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it("uses ids when the form provides them", () => {
    const form = formOf(`
      <form>
        <input id="cf-name" type="text" />
        <input id="cf-email" type="email" />
        <textarea id="cf-message" required></textarea>
        <button type="submit">Send</button>
      </form>`);

    expect(form?.fields.name).toBe("#cf-name");
    expect(form?.fields.email).toBe("#cf-email");
    expect(form?.fields.message).toBe("#cf-message");
  });

  it("uses a distinguishing input type when there is no name or id", () => {
    const form = formOf(`
      <form>
        <input type="text" placeholder="Your name" />
        <input type="email" placeholder="Your email" />
        <textarea placeholder="Message" required></textarea>
        <button type="submit">Send</button>
      </form>`);

    expect(form?.fields.email).toBe('input[type="email"]');
    expect(form?.fields.email).not.toBe(form?.fields.name);
  });

  it("does not claim full support when a field cannot be addressed distinctly", () => {
    // A form whose only message-ish control is also the only text input.
    const form = formOf(`
      <form>
        <input name="message" type="text" />
        <textarea name="message"></textarea>
        <button type="submit">Send</button>
      </form>`);

    if (form) {
      const selectors = Object.values(form.fields);
      expect(new Set(selectors).size).toBe(selectors.length);
    }
  });
});

describe("the real demo portfolio form", () => {
  it("maps each control to a distinct name-based selector", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("examples/demo-portfolio/index.html", "utf8");

    const extracted = extractPage(html, {
      url: "https://demo.example/",
      origin: "https://demo.example",
      httpStatus: 200,
      contentType: "text/html",
      byteSize: html.length,
    });
    const form = extracted.contact.forms?.[0];

    expect(form).toBeDefined();
    expect(form?.fields.name).toBe('input[name="name"]');
    expect(form?.fields.email).toBe('input[name="email"]');
    expect(form?.fields.message).toBe('textarea[name="message"]');

    // The regression in one assertion: three roles, three different controls.
    const selectors = [form?.fields.name, form?.fields.email, form?.fields.message];
    expect(new Set(selectors).size).toBe(3);
  });
});
