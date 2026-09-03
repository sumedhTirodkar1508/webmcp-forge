import type { ContactFormMapping } from "@/lib/ai/mapping-schema";

import { safeQuery, safeQueryAll } from "@/runtime/dom-extract";

/**
 * Staging and submission of a contact message.
 *
 * Privacy is the governing constraint. A drafted message lives ONLY in this
 * module's in-memory map, inside the visitor's own tab. It is never written to
 * the WebMCP Forge database, never logged on a server, never sent to Gemini,
 * and never included in analytics. Closing the tab discards it.
 *
 * Safety is the other constraint. Submission goes through the site's OWN form
 * using ordinary browser events and `requestSubmit()`, so the site's existing
 * validation, CSRF tokens and handlers all still apply. We never call a
 * discovered backend directly, never proxy through Forge, and never send mail.
 */

/** How long a staged draft stays usable. */
const DRAFT_TTL_MS = 7 * 60 * 1000;

/** Never keep more than a handful of drafts alive in a page. */
const MAX_PENDING = 5;

export interface ContactDraft {
  name?: string;
  email?: string;
  subject?: string;
  message: string;
}

interface PendingDraft {
  draft: ContactDraft;
  expiresAt: number;
  consumed: boolean;
}

const pending = new Map<string, PendingDraft>();

function now(): number {
  return Date.now();
}

/** Drops expired entries so a long-lived page cannot accumulate drafts. */
function prune(): void {
  const cutoff = now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= cutoff || entry.consumed) pending.delete(id);
  }
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function stageDraft(draft: ContactDraft): { confirmationId: string; expiresAt: number } {
  prune();
  const confirmationId = randomId();
  const expiresAt = now() + DRAFT_TTL_MS;
  pending.set(confirmationId, { draft, expiresAt, consumed: false });
  return { confirmationId, expiresAt };
}

export type DraftLookup =
  | { ok: true; draft: ContactDraft }
  | { ok: false; reason: "unknown" | "expired" | "consumed" };

/**
 * Claims a staged draft, marking it consumed.
 *
 * Consumption happens here, BEFORE any submission is attempted, so a
 * confirmationId can drive at most one submission even if the caller retries
 * or the page races two invocations.
 */
export function claimDraft(confirmationId: string): DraftLookup {
  const entry = pending.get(confirmationId);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.consumed) return { ok: false, reason: "consumed" };
  if (entry.expiresAt <= now()) {
    pending.delete(confirmationId);
    return { ok: false, reason: "expired" };
  }
  entry.consumed = true;
  return { ok: true, draft: entry.draft };
}

/** Test seam: clears staged drafts between cases. */
export function resetDrafts(): void {
  pending.clear();
}


type Fillable = HTMLInputElement | HTMLTextAreaElement;

/**
 * Hints for recovering a field whose stored selector is too broad.
 *
 * Ordered most to least specific. Used only when a mapping resolves two roles
 * to the same control — which is what happened when the scanner emitted a bare
 * `"input"` for both name and email, so the visitor's email was typed into the
 * name box.
 */
const FIELD_HINTS: Record<string, readonly string[]> = {
  email: [
    'input[type="email"]',
    'input[name="email"]',
    '[autocomplete="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
  ],
  name: [
    'input[name="name"]',
    '[autocomplete="name"]',
    'input[name*="name" i]',
    'input[id*="name" i]',
    'input[type="text"]',
  ],
  subject: [
    'input[name="subject"]',
    'input[name*="subject" i]',
    'input[id*="subject" i]',
  ],
  message: ["textarea", 'textarea[name="message"]', '[name*="message" i]'],
};

/**
 * Resolves each mapped role to its OWN control.
 *
 * Two safeguards, because a published configuration cannot be edited
 * retroactively: a selector must resolve to a fillable control, and no two
 * roles may claim the same element. When a collision happens the role is
 * re-resolved from `FIELD_HINTS` against the live form; if nothing distinct is
 * found it is skipped rather than typed into the wrong box.
 */
export function resolveFields(
  form: HTMLFormElement,
  selectors: Partial<Record<string, string | undefined>>,
  order: readonly string[],
): { resolved: Map<string, Fillable>; unresolved: string[] } {
  const resolved = new Map<string, Fillable>();
  const claimed = new Set<Element>();
  const unresolved: string[] = [];

  /** The first unclaimed fillable control matching any hint for this role. */
  const fromHints = (role: string): Fillable | null => {
    for (const hint of FIELD_HINTS[role] ?? []) {
      for (const candidate of safeQueryAll(form, hint)) {
        if (isFillable(candidate) && !claimed.has(candidate)) return candidate;
      }
    }
    return null;
  };

  for (const role of order) {
    const selector = selectors[role];
    if (!selector) continue;

    const matches = safeQueryAll(form, selector).filter(isFillable);

    // A selector matching several controls says nothing about WHICH one this
    // role means — `"input"` matches both the name and email boxes. Taking its
    // first match is how the email address ended up in the name field, so an
    // ambiguous selector is re-resolved from the live form instead of trusted.
    const ambiguous = matches.length > 1;
    const direct = ambiguous ? null : matches[0];

    let chosen: Fillable | null =
      direct && !claimed.has(direct) ? direct : null;

    if (!chosen) chosen = fromHints(role);

    // Last resort for an ambiguous selector with no hint match: any unclaimed
    // control it does match is still better than leaving the field blank.
    if (!chosen && ambiguous) {
      chosen = matches.find((candidate) => !claimed.has(candidate)) ?? null;
    }

    if (chosen) {
      claimed.add(chosen);
      resolved.set(role, chosen);
    } else {
      unresolved.push(role);
    }
  }

  return { resolved, unresolved };
}

export function findContactForm(
  doc: Document,
  mapping: ContactFormMapping,
): HTMLFormElement | null {
  const element = safeQuery(doc, mapping.formSelector);
  return element instanceof HTMLFormElement ? element : null;
}

function isFillable(element: Element | null): element is Fillable {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/**
 * Sets a field the way a person typing would.
 *
 * Frameworks such as React track the input's value through a property setter
 * on the prototype and ignore a plain `element.value = x`. Going through the
 * native setter and then dispatching `input` and `change` makes the site's own
 * state management observe the edit, which is what keeps its validation and
 * submit-button enabling working.
 */
function setFieldValue(element: Fillable, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (setter) setter.call(element, value);
  else element.value = value;

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export interface SubmitOutcome {
  ok: boolean;
  reason?: "form_missing" | "field_missing" | "invalid";
  detail?: string;
}

/**
 * Fills the mapped fields and submits through the site's own form.
 *
 * `requestSubmit()` is used rather than `submit()` precisely because it runs
 * the form's constraint validation and fires the site's `submit` handlers —
 * `submit()` would bypass both.
 */
export function fillAndSubmit(
  doc: Document,
  mapping: ContactFormMapping,
  draft: ContactDraft,
): SubmitOutcome {
  const form = findContactForm(doc, mapping);
  if (!form) return { ok: false, reason: "form_missing" };

  // Message first: it is the required field, and resolving it first means a
  // broad selector shared with another role cannot steal the textarea.
  const { resolved } = resolveFields(
    form,
    {
      message: mapping.fields.message,
      email: mapping.fields.email,
      name: mapping.fields.name,
      subject: mapping.fields.subject,
    },
    ["message", "email", "name", "subject"],
  );

  const messageField = resolved.get("message");
  if (!messageField) return { ok: false, reason: "field_missing" };

  setFieldValue(messageField, draft.message);

  for (const key of ["name", "email", "subject"] as const) {
    const value = draft[key];
    const field = resolved.get(key);
    // A role we could not address distinctly is left blank rather than typed
    // into a control belonging to another field.
    if (value && field) setFieldValue(field, value);
  }

  // Respect the site's own validation rather than forcing a submission it
  // would have rejected.
  if (typeof form.checkValidity === "function" && !form.checkValidity()) {
    if (typeof form.reportValidity === "function") form.reportValidity();
    return { ok: false, reason: "invalid" };
  }

  const submitButton = mapping.submitSelector ? safeQuery(form, mapping.submitSelector) : null;

  if (typeof form.requestSubmit === "function") {
    if (submitButton instanceof HTMLButtonElement || submitButton instanceof HTMLInputElement) {
      form.requestSubmit(submitButton);
    } else {
      form.requestSubmit();
    }
  } else if (submitButton instanceof HTMLElement) {
    // Very old browsers: click the real button so the site's handlers still run.
    submitButton.click();
  } else {
    return { ok: false, reason: "field_missing", detail: "no way to submit this form" };
  }

  return { ok: true };
}
