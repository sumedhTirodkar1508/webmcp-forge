/**
 * The deterministic scan representation.
 *
 * This is the compact, normalised view of a portfolio that everything
 * downstream consumes. Two rules shape it:
 *
 *  1. It must stay small enough to hand to Gemini in one request — we never
 *     ship raw HTML documents to the model.
 *  2. It carries *structure* (selectors, route shapes, counts) alongside only
 *     enough sample text for a model to reason about meaning. The structure is
 *     what gets persisted; the samples are not the product.
 *
 * Importable from browser runtime code: types only, no imports.
 */

export type PlatformId =
  | "FRAMER"
  | "WIX"
  | "WEBFLOW"
  | "SQUARESPACE"
  | "NEXTJS"
  | "CUSTOM"
  | "UNKNOWN";

export type PageTypeId =
  | "HOME"
  | "ABOUT"
  | "WORK_INDEX"
  | "PROJECT_DETAIL"
  | "EXPERIENCE"
  | "EDUCATION"
  | "CONTACT"
  | "BLOG"
  | "OTHER";

export interface Heading {
  level: number;
  text: string;
  /** Scanner-owned selector for this exact heading when one is available. */
  selector?: string;
}

export interface NavLink {
  label: string;
  href: string;
  /** Same-origin crawl identity (query/hash removed). */
  pathname?: string;
  /** Same-origin navigation target, including query and fragment. */
  path?: string;
}

/** A field discovered inside every item of a repeated structure. */
export interface RepeatedField {
  /** Selector relative to the item element, e.g. `h3` or `a.title`. */
  selector: string;
  /** Where the value lives: element text, or a named attribute. */
  source: "text" | "href" | "src" | "attr";
  /** Attribute name when `source` is "attr". */
  attribute?: string;
  /** How many of the items actually produced a non-empty value. */
  coverage: number;
  /** A few real values, truncated. Used only to help the model judge meaning. */
  samples: string[];
  /** Structural hints for semantic interpretation; never executable. */
  hints?: string[];
  /** Count of direct list-item values when this field is a nested UL/OL. */
  nestedItemCount?: number;
}

export interface RepeatedGroupContext {
  sectionSelector?: string;
  sectionId?: string;
  heading?: string;
  ariaLabel?: string;
  landmark?: string;
  documentOrder?: number;
}

/**
 * A repeated DOM structure — the shape a project grid, a skills list or an
 * experience timeline all take. These are the candidates the model chooses
 * among; it never invents selectors of its own.
 */
export interface RepeatedGroup {
  /** Stable id used to refer to this group in AI input/output. */
  id: string;
  /** Selector matching every item, e.g. `.project-card`. */
  itemSelector: string;
  /** Selector for the element containing the items, when one is identifiable. */
  containerSelector?: string;
  /** How many elements `itemSelector` matched at scan time. */
  count: number;
  /** Candidate fields, keyed by a guessed role (`title`, `link`, `image`, ...). */
  fields: Record<string, RepeatedField>;
  /** Compact text preview of the first few items. */
  samples: string[];
  /** Rough score used to order candidates; higher looks more content-like. */
  score: number;
  /** Nearby semantic context used to distinguish otherwise similar lists. */
  context?: RepeatedGroupContext;
}

/** A run of prose under a heading — the raw material for profile/about text. */
export interface PageSection {
  heading?: string;
  /** Selector for the section element. */
  selector: string;
  /** Truncated text. */
  text: string;
  id?: string;
  ariaLabel?: string;
  landmark?: string;
  documentOrder?: number;
  repeatedItemCount?: number;
}

export interface ContactSignals {
  emails: string[];
  phones: string[];
  /** `{ platform: "github", url: "https://github.com/..." }` */
  socials: Array<{ platform: string; url: string }>;
  /** Bounded structural candidates only; never user-entered form content. */
  forms?: ContactFormCandidate[];
}

export type ContactFormSupport = "SUPPORTED" | "UNSUPPORTED" | "UNCERTAIN";

export interface ContactFormCandidate {
  formSelector: string;
  submitSelector?: string;
  fields: Partial<Record<"name" | "email" | "subject" | "message", string>>;
  support: ContactFormSupport;
  reasons: string[];
}

export interface PlatformFingerprint {
  platform: PlatformId;
  confidence: number;
  /** Human-readable evidence, e.g. `meta[name=generator]=Framer`. */
  evidence: string[];
}

/** Everything deterministic extraction found on one page. */
export interface PageExtraction {
  url: string;
  pathname: string;
  routePattern: string;
  pageType: PageTypeId;

  title?: string;
  metaDescription?: string;
  canonical?: string;
  openGraph: Record<string, string>;
  /** Parsed JSON-LD blocks, bounded in size and count. */
  jsonLd: unknown[];

  /** Platform signals visible on this page. Merged site-wide by
   *  `buildRepresentation`. Carried on the page itself rather than in a
   *  side-channel so a `PageExtraction` survives being serialised. */
  platform: PlatformFingerprint;

  headings: Heading[];
  nav: NavLink[];
  /** Same-origin links, deduplicated and bounded. */
  links: NavLink[];
  sections: PageSection[];
  repeatedGroups: RepeatedGroup[];
  contact: ContactSignals;

  /**
   * A WebMCP Forge snippet already installed on this page, if one was found.
   *
   * This is the only reliable statement about which configuration the site is
   * ACTUALLY running — the newest version generated in Forge says nothing
   * about what has been deployed.
   */
  installedSnippet?: {
    siteId: string;
    configVersion: number | null;
    /** The runtime URL the site loads. Forge-hosted, so a different host. */
    runtimeSrc: string | null;
  };

  /** Total visible text length, used to spot client-rendered pages. */
  textLength: number;
  /** True when the server HTML carried almost nothing readable. */
  lowInformation: boolean;

  httpStatus: number;
  contentType?: string;
  byteSize: number;
}

/** Site-level deterministic result: the input to semantic interpretation. */
export interface ScanRepresentation {
  origin: string;
  entryUrl: string;
  platform: PlatformFingerprint;
  pages: PageExtraction[];
  /** Distinct route shapes seen, e.g. `/`, `/about`, `/work/*`. */
  routePatterns: string[];
  /** Site navigation, merged across pages. */
  navigation: NavLink[];
  /** Pages we could not fetch, with a user-safe reason. */
  failures: Array<{ url: string; reason: string }>;
  /** True when most pages looked client-rendered. */
  lowInformation: boolean;
}
