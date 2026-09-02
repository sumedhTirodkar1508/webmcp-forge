import type { ListMapping, SiteMapping } from "@/lib/ai/mapping-schema";
import { CAPABILITY_IDS } from "@/lib/capabilities/catalogue";
import type { RuntimeConfig } from "@/lib/runtime-config";
import { RUNTIME_SCHEMA_VERSION } from "@/lib/runtime-version";

/**
 * Shared fixture builders for the runtime test suite.
 *
 * Not a `.test.ts` file on purpose — vitest only treats `tests/**\/*.test.ts`
 * as a suite, so this module exists purely to be imported.
 *
 * The DOM helpers below rely on the *global* `document` (supplied by vitest's
 * `happy-dom` environment on any test file that opts in via the
 * `// @vitest-environment happy-dom` pragma). They are only referenced inside
 * function bodies, so importing this module from a plain-`node`-environment
 * test file (config-guard.test.ts) is safe as long as those functions are
 * never called there.
 */

/** The origin every fixture portfolio is "installed" on. */
export const PORTFOLIO_ORIGIN = "https://jordanrivera.dev";

/** Markup for a single project card, shared by `portfolioHtml` and `appendProjectCard`
 *  so a card built long after the page loads looks identical to one that was
 *  there from the start. */
function projectCardMarkup(index: number): string {
  return `<article class="project-card" id="project-${index}" data-id="proj-${index}">
    <img src="/img/project-${index}.png" alt="" />
    <h3 class="project-title">Project ${index}</h3>
    <p class="project-desc">Description of project ${index}.</p>
    <a class="project-link" href="/work/project-${index}">View project</a>
    <span class="project-tags">tag-${index}, sample</span>
  </article>`;
}

export interface PortfolioHtmlOptions {
  /** How many `.project-card` elements to render inside `.project-grid`. */
  projectCount?: number;
  skills?: string[];
}

/**
 * A fake portfolio page: nav, profile header, a `.project-card` grid, a
 * skills `<ul>`, and a contact section. `projectCount` makes it trivial for a
 * test to render "the same page" with a different number of cards.
 */
export function portfolioHtml(options: PortfolioHtmlOptions = {}): string {
  const { projectCount = 3, skills = ["TypeScript", "React", "Node.js"] } = options;

  const cards = Array.from({ length: projectCount }, (_, i) => projectCardMarkup(i + 1)).join(
    "\n",
  );
  const skillItems = skills.map((skill) => `<li>${skill}</li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Jordan Rivera — Portfolio</title></head>
<body>
  <nav class="site-nav">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/work">Work</a>
    <a href="/contact">Contact</a>
  </nav>
  <header>
    <h1 class="profile-name">Jordan Rivera</h1>
    <p class="profile-headline">Product designer &amp; builder</p>
  </header>
  <main>
    <section class="project-grid">
      ${cards}
    </section>
    <section class="skills">
      <ul class="skills-list">
        ${skillItems}
      </ul>
    </section>
    <section class="contact">
      <a class="contact-email" href="mailto:jordan@example.com">jordan@example.com</a>
      <a class="contact-github" href="https://github.com/jordan">GitHub</a>
    </section>
  </main>
</body>
</html>`;
}

/** Builds a `Document` from an HTML string via happy-dom. */
export function createDocument(html: string): Document {
  const doc = document.implementation.createHTMLDocument("");
  doc.documentElement.innerHTML = html;
  return doc;
}

/**
 * Appends one more project card directly to a *live* document — no re-render,
 * no rebuilt config — the way a portfolio owner's CMS would add a new project
 * after the page (and the WebMCP tools registered against it) already exist.
 */
export function appendProjectCard(
  doc: Document,
  index: number,
  containerSelector = ".project-grid",
): Element {
  const root = doc.querySelector(containerSelector) ?? doc.body;
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = projectCardMarkup(index);
  const article = wrapper.firstElementChild;
  if (!article) throw new Error("failed to build project card markup");
  root.appendChild(article);
  return article;
}

export function buildProjectsMapping(overrides: Partial<ListMapping> = {}): ListMapping {
  return {
    route: "*",
    itemSelector: ".project-card",
    fields: {
      title: { selector: ".project-title", source: "text" },
      description: { selector: ".project-desc", source: "text" },
      link: { selector: ".project-link", source: "href" },
      image: { selector: "img", source: "src" },
      tags: { selector: ".project-tags", source: "text" },
    },
    ...overrides,
  };
}

export function buildSkillsMapping(overrides: Partial<ListMapping> = {}): ListMapping {
  return {
    route: "*",
    itemSelector: ".skills-list li",
    fields: {
      title: { selector: "", source: "text" },
    },
    ...overrides,
  };
}

/** A valid `SiteMapping` matching the structure of `portfolioHtml()`. */
export function buildSiteMapping(overrides: Partial<SiteMapping> = {}): SiteMapping {
  return {
    version: 1,
    profile: {
      route: "*",
      fields: {
        name: { selector: ".profile-name", source: "text" },
        headline: { selector: ".profile-headline", source: "text" },
      },
    },
    projects: buildProjectsMapping(),
    skills: buildSkillsMapping(),
    contact: {
      route: "*",
      emails: ["jordan@example.com"],
      phones: [],
      socials: [{ platform: "github", url: "https://github.com/jordan" }],
    },
    navigation: {
      items: [
        { label: "Home", path: "/" },
        { label: "About", path: "/about" },
        { label: "Work", path: "/work" },
        { label: "Contact", path: "/contact" },
      ],
    },
    ...overrides,
  };
}

/** A valid `RuntimeConfig` payload for the fake portfolio, every capability enabled. */
export function buildRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    siteId: "wmf_test_site",
    configVersion: 1,
    origin: PORTFOLIO_ORIGIN,
    enabledCapabilities: [...CAPABILITY_IDS],
    mapping: buildSiteMapping(),
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
