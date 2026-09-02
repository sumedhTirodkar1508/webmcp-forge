import type { ListMapping, SiteMapping } from "@/lib/ai/mapping-schema";
import {
  CAPABILITY_CATALOGUE,
  type CapabilityDefinition,
  type CapabilityId,
} from "@/lib/capabilities/catalogue";
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { WebMcpTool, WebMcpTextResult } from "@/lib/webmcp/types";
import {
  extractList,
  extractSingle,
  findItem,
  routeMatches,
  searchItems,
  type ExtractedItem,
} from "@/runtime/dom-extract";

/**
 * The generic capability handlers, bound to one site's stored mapping.
 *
 * Two rules govern everything here:
 *
 *  1. **No network.** A tool invocation reads the live DOM and returns. It does
 *     not call Gemini, and it does not send the portfolio's content back to
 *     WebMCP Forge. Configuration is fetched once at page load; after that the
 *     runtime is entirely local.
 *  2. **Bounded results.** Agents get normalised text, URLs and structured
 *     fields — never raw HTML, never an unbounded list.
 */

/** Hard ceiling on items returned, regardless of what the agent asks for. */
const MAX_RESULT_ITEMS = 50;

export interface ToolContext {
  config: RuntimeConfig;
  doc: Document;
  /** Current absolute URL; re-read on every invocation so SPA navigation is
   *  reflected without re-registering tools. */
  currentUrl: () => string;
}

function textResult(text: string, structured?: unknown): WebMcpTextResult {
  return {
    content: [{ type: "text", text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function notAvailable(what: string): WebMcpTextResult {
  return {
    content: [
      {
        type: "text",
        text: `This site does not publish ${what}, or that part of the page has changed since it was configured.`,
      },
    ],
    structuredContent: { available: false },
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

/** Reads a list mapping if — and only if — it applies to the current route. */
function readList(
  ctx: ToolContext,
  mapping: ListMapping | undefined,
): { items: ExtractedItem[]; matchCount: number; applies: boolean } {
  if (!mapping) return { items: [], matchCount: 0, applies: false };

  const pathname = new URL(ctx.currentUrl()).pathname;
  if (!routeMatches(mapping.route, pathname)) {
    return { items: [], matchCount: 0, applies: false };
  }

  const result = extractList(ctx.doc, mapping, ctx.currentUrl());
  return { items: result.items, matchCount: result.matchCount, applies: true };
}

function projectSummary(item: ExtractedItem) {
  return {
    index: item.index,
    id: item.id,
    title: item.fields.title ?? "",
    description: item.fields.description ?? "",
    url: item.fields.link ?? "",
    image: item.fields.image ?? "",
    tags: item.fields.tags ?? "",
  };
}

function describeProjects(items: ExtractedItem[]): string {
  if (items.length === 0) return "No projects are visible on this page right now.";
  return items
    .map((item, i) => {
      const summary = projectSummary(item);
      const parts = [`${i + 1}. ${summary.title || "(untitled)"}`];
      if (summary.description) parts.push(summary.description);
      if (summary.url) parts.push(summary.url);
      return parts.join(" — ");
    })
    .join("\n");
}

/**
 * Scrolls an element into view and gives it a brief, non-destructive outline.
 *
 * Deliberately does not modify the page's own styles or markup beyond a
 * temporary inline outline that is removed afterwards — an installed script has
 * no business permanently altering someone's site.
 */
function highlight(element: Element): void {
  if (!(element instanceof HTMLElement)) return;

  element.scrollIntoView({ behavior: "smooth", block: "center" });

  const previousOutline = element.style.outline;
  const previousOffset = element.style.outlineOffset;
  element.style.outline = "3px solid rgba(56, 132, 255, 0.9)";
  element.style.outlineOffset = "4px";

  window.setTimeout(() => {
    element.style.outline = previousOutline;
    element.style.outlineOffset = previousOffset;
  }, 2400);
}

type Handler = (input: Record<string, unknown>) => Promise<WebMcpTextResult>;

function buildHandler(id: CapabilityId, ctx: ToolContext): Handler {
  const mapping: SiteMapping = ctx.config.mapping;

  switch (id) {
    case "get_profile":
      return async () => {
        if (!mapping.profile) return notAvailable("profile information");
        const pathname = new URL(ctx.currentUrl()).pathname;
        if (!routeMatches(mapping.profile.route, pathname)) {
          return textResult(
            "Profile information lives on a different page of this site.",
            { available: false, route: mapping.profile.route },
          );
        }
        const profile = extractSingle(ctx.doc, mapping.profile, ctx.currentUrl());
        if (Object.keys(profile).length === 0) return notAvailable("profile information");
        const lines = Object.entries(profile).map(([role, value]) => `${role}: ${value}`);
        return textResult(lines.join("\n"), profile);
      };

    case "list_projects":
      return async (input) => {
        const { items, applies } = readList(ctx, mapping.projects);
        if (!applies) {
          return textResult(
            "Projects are listed on a different page of this site. Use navigate_site first.",
            { available: false, route: mapping.projects?.route },
          );
        }
        const limit = clampInt(input.limit, 1, MAX_RESULT_ITEMS, 20);
        const offset = clampInt(input.offset, 0, 10_000, 0);
        const page = items.slice(offset, offset + limit);
        return textResult(describeProjects(page), {
          total: items.length,
          offset,
          limit,
          projects: page.map(projectSummary),
        });
      };

    case "get_project":
      return async (input) => {
        const { items, applies } = readList(ctx, mapping.projects);
        if (!applies) return notAvailable("a project list on this page");
        const match = findItem(items, {
          id: asString(input.id, 200),
          title: asString(input.title, 200),
          index:
            typeof input.index === "number" ? clampInt(input.index, 0, 10_000, 0) : undefined,
        });
        if (!match) {
          return textResult("No project matched that identifier.", {
            found: false,
            available: items.length,
          });
        }
        const summary = projectSummary(match);
        const lines = Object.entries(summary)
          .filter(([, value]) => value !== "" && value !== undefined)
          .map(([role, value]) => `${role}: ${String(value)}`);
        return textResult(lines.join("\n"), summary);
      };

    case "search_projects":
      return async (input) => {
        const query = asString(input.query, 200);
        if (!query) return textResult("Provide a search query.", { results: [] });
        const { items, applies } = readList(ctx, mapping.projects);
        if (!applies) return notAvailable("a project list on this page");
        const limit = clampInt(input.limit, 1, MAX_RESULT_ITEMS, 10);
        const matches = searchItems(items, query, limit);
        return textResult(
          matches.length === 0
            ? `No projects matched "${query}".`
            : describeProjects(matches),
          { query, total: matches.length, projects: matches.map(projectSummary) },
        );
      };

    case "get_skills":
    case "get_experience":
    case "get_education":
      return async () => {
        const listMapping =
          id === "get_skills"
            ? mapping.skills
            : id === "get_experience"
              ? mapping.experience
              : mapping.education;
        const label =
          id === "get_skills" ? "skills" : id === "get_experience" ? "experience" : "education";

        const { items, applies } = readList(ctx, listMapping);
        if (!applies) return notAvailable(label);
        if (items.length === 0) return notAvailable(label);

        const entries = items.slice(0, MAX_RESULT_ITEMS).map((item) => item.fields);
        const text = entries
          .map((fields) =>
            Object.values(fields)
              .filter(Boolean)
              .join(" — "),
          )
          .join("\n");
        return textResult(text, { [label]: entries, total: entries.length });
      };

    case "get_contact_info":
      return async () => {
        const contact = mapping.contact;
        if (!contact) return notAvailable("contact information");

        const live = contact.list ? readList(ctx, contact.list) : null;
        const payload = {
          emails: contact.emails,
          phones: contact.phones,
          socials: contact.socials,
          ...(live?.applies
            ? { additional: live.items.map((item) => item.fields) }
            : {}),
        };

        const lines: string[] = [];
        if (contact.emails.length) lines.push(`Email: ${contact.emails.join(", ")}`);
        if (contact.phones.length) lines.push(`Phone: ${contact.phones.join(", ")}`);
        for (const social of contact.socials) lines.push(`${social.platform}: ${social.url}`);
        if (lines.length === 0) return notAvailable("contact information");

        return textResult(lines.join("\n"), payload);
      };

    case "navigate_site":
      return async (input) => {
        const destination = asString(input.destination, 200);
        const rawPath = asString(input.path, 500);
        const items = mapping.navigation?.items ?? [];

        let target: string | undefined;

        if (rawPath) {
          // Same-origin only. Resolving against the configured origin and then
          // re-checking means `//evil.com` and `https://evil.com` both fail.
          try {
            const resolved = new URL(rawPath, ctx.config.origin);
            if (resolved.origin !== ctx.config.origin) {
              return textResult("That destination is not part of this site.", {
                navigated: false,
              });
            }
            target = resolved.toString();
          } catch {
            return textResult("That destination could not be understood.", {
              navigated: false,
            });
          }
        } else if (destination) {
          const wanted = destination.toLowerCase();
          const entry =
            items.find((item) => item.label.toLowerCase() === wanted) ??
            items.find((item) => item.label.toLowerCase().includes(wanted));
          if (entry) target = new URL(entry.path, ctx.config.origin).toString();
        }

        if (!target) {
          return textResult(
            items.length
              ? `Unknown destination. Available: ${items.map((i) => i.label).join(", ")}.`
              : "This site has no configured navigation.",
            { navigated: false, available: items.map((i) => i.label) },
          );
        }

        if (isSameDocumentFragmentNavigation(ctx.currentUrl(), target)) {
          const hash = new URL(target).hash;
          if (window.location.hash !== hash) {
            window.location.hash = hash;
          } else {
            const id = decodeURIComponent(hash.slice(1));
            document.getElementById(id)?.scrollIntoView({ block: "start" });
          }
        } else {
          window.location.assign(target);
        }
        return textResult(`Navigating to ${target}.`, { navigated: true, url: target });
      };

    case "focus_project":
      return async (input) => {
        const projects = mapping.projects;
        if (!projects) return notAvailable("a project list on this page");

        const pathname = new URL(ctx.currentUrl()).pathname;
        if (!routeMatches(projects.route, pathname)) {
          return notAvailable("a project list on this page");
        }

        const elements = Array.from(
          ctx.doc.querySelectorAll(projects.itemSelector),
        );
        const { items } = readList(ctx, projects);
        const match = findItem(items, {
          id: asString(input.id, 200),
          title: asString(input.title, 200),
          index:
            typeof input.index === "number" ? clampInt(input.index, 0, 10_000, 0) : undefined,
        });

        const element = match ? elements[match.index] : undefined;
        if (!match || !element) {
          return textResult("No project matched that identifier.", { focused: false });
        }

        highlight(element);
        return textResult(`Focused "${match.fields.title ?? `project ${match.index}`}".`, {
          focused: true,
          index: match.index,
          title: match.fields.title ?? "",
        });
      };

    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled capability: ${String(exhaustive)}`);
    }
  }
}

/**
 * Whether a capability has the mapping it needs. A capability the owner enabled
 * but whose data is missing is not registered at all — an agent should not see
 * a tool that can only ever answer "not available".
 */
export function capabilityIsSatisfied(id: CapabilityId, mapping: SiteMapping): boolean {
  switch (id) {
    case "get_profile":
      return Boolean(mapping.profile);
    case "list_projects":
    case "get_project":
    case "search_projects":
    case "focus_project":
      return Boolean(mapping.projects);
    case "get_skills":
      return Boolean(mapping.skills);
    case "get_experience":
      return Boolean(mapping.experience);
    case "get_education":
      return Boolean(mapping.education);
    case "get_contact_info":
      return Boolean(mapping.contact);
    case "navigate_site":
      return Boolean(mapping.navigation?.items.length);
    default:
      return false;
  }
}

/** Builds the WebMCP tool descriptors this page should register. */
export function buildTools(ctx: ToolContext): WebMcpTool[] {
  const tools: WebMcpTool[] = [];

  for (const id of ctx.config.enabledCapabilities) {
    if (!capabilityIsSatisfied(id, ctx.config.mapping)) continue;

    const definition: CapabilityDefinition = CAPABILITY_CATALOGUE[id];
    const handler = buildHandler(id, ctx);

    tools.push({
      name: definition.id,
      title: definition.label,
      description: definition.agentDescription,
      inputSchema: definition.inputSchema as unknown as Record<string, unknown>,
      annotations: definition.annotations,
      execute: async (input) => handler(input ?? {}),
    });
  }

  return tools;
}

/** Live diagnostics for installation verification. Counts only, never content. */
export function collectLiveCounts(ctx: ToolContext): Record<string, number> {
  const counts: Record<string, number> = {};
  const mapping = ctx.config.mapping;
  const pathname = new URL(ctx.currentUrl()).pathname;

  const record = (key: string, listMapping: ListMapping | undefined) => {
    if (!listMapping) return;
    if (!routeMatches(listMapping.route, pathname)) return;
    counts[key] = extractList(ctx.doc, listMapping, ctx.currentUrl()).matchCount;
  };

  record("projects", mapping.projects);
  record("skills", mapping.skills);
  record("experience", mapping.experience);
  record("education", mapping.education);

  return counts;
}
export function isSameDocumentFragmentNavigation(
  currentUrl: string,
  targetUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      Boolean(target.hash) &&
      current.origin === target.origin &&
      current.pathname === target.pathname &&
      current.search === target.search
    );
  } catch {
    return false;
  }
}
