import type { PlatformId } from "@/lib/scanner/types";

/**
 * The installation snippet and the platform-specific instructions around it.
 *
 * The snippet is generated once and never changes: it carries the site's public
 * id and nothing else, so turning a capability on or re-scanning the site does
 * not require the owner to touch their website again. Everything variable lives
 * behind the configuration endpoint the runtime fetches.
 */

export const RUNTIME_PATH = "/runtime/v1.js";

export function buildScriptTag(appOrigin: string, publicId: string): string {
  return [
    "<script",
    "  defer",
    `  src="${appOrigin}${RUNTIME_PATH}"`,
    `  data-wmf-site="${publicId}">`,
    "</script>",
  ].join("\n");
}

export interface InstallInstructions {
  platform: PlatformId;
  platformLabel: string;
  /** One line telling the owner what they are about to do. */
  summary: string;
  steps: string[];
  /** Anything that commonly goes wrong on this platform. */
  notes: string[];
  docsUrl?: string;
}

const CUSTOM: Omit<InstallInstructions, "platform"> = {
  platformLabel: "Custom site",
  summary: "Paste the snippet into the <head> of every page.",
  steps: [
    "Open the HTML template that every page of your site shares.",
    "Paste the snippet just before the closing </head> tag.",
    "Deploy or publish your site.",
    "Come back here and press Check Installation.",
  ],
  notes: [
    "If your site is built from separate HTML files, add the snippet to each one — or to the shared layout/partial if you have one.",
    "The snippet is safe to leave in place permanently. Changing your settings here never requires editing it again.",
  ],
};

const BY_PLATFORM: Record<PlatformId, Omit<InstallInstructions, "platform">> = {
  FRAMER: {
    platformLabel: "Framer",
    summary: "Add the snippet to your site's custom code, in the End of <head> slot.",
    steps: [
      "In Framer, open your project and go to Site Settings.",
      "Select General, then scroll to Custom Code.",
      "Paste the snippet into the “End of <head> tag” box.",
      "Press Publish — custom code only runs on the published site, not in the editor.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Custom code does not run inside the Framer canvas or preview. You must publish first.",
      "Framer sites are single-page apps: the runtime follows in-app navigation on its own.",
    ],
    docsUrl: "https://www.framer.com/help/articles/how-can-i-add-custom-code-to-my-site/",
  },
  WIX: {
    platformLabel: "Wix",
    summary: "Add the snippet as a custom code element that loads on all pages.",
    steps: [
      "In your Wix dashboard, go to Settings, then Custom Code (under Advanced).",
      "Press “+ Add Custom Code”.",
      "Paste the snippet into the code box.",
      "Set “Add Code to Pages” to All pages, and “Place Code in” to Head.",
      "Press Apply, then publish your site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Custom code requires a Wix Premium plan with a connected domain.",
      "Code added this way does not run on the free wixsite.com preview in all cases — publish to your real domain if verification fails.",
    ],
    docsUrl: "https://support.wix.com/en/article/embedding-custom-code-on-your-site",
  },
  WEBFLOW: {
    platformLabel: "Webflow",
    summary: "Add the snippet to your project's head code, then publish.",
    steps: [
      "In Webflow, open Site Settings, then the Custom Code tab.",
      "Paste the snippet into “Head Code”.",
      "Press Save Changes.",
      "Publish your site — custom code only runs on the published site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Head Code is only available on paid site plans.",
      "If you only want the runtime on some pages, use that page's own Page Settings instead.",
    ],
    docsUrl: "https://university.webflow.com/lesson/custom-code-in-the-head-and-body-tags",
  },
  SQUARESPACE: {
    platformLabel: "Squarespace",
    summary: "Add the snippet to Code Injection, in the Header field.",
    steps: [
      "Open Settings, then Advanced, then Code Injection.",
      "Paste the snippet into the Header field.",
      "Press Save.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Code Injection requires a Business plan or higher.",
      "Code Injection does not run in the Squarespace editor preview.",
    ],
  },
  NEXTJS: {
    platformLabel: "Next.js site",
    summary: "Add the snippet to your root layout.",
    steps: [
      "Open your root layout (app/layout.tsx) or _document if you use the Pages Router.",
      "Add the script using next/script with the afterInteractive strategy, or paste the raw tag into <head>.",
      "Deploy your site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "With next/script, pass the site id as a data-wmf-site prop so it reaches the rendered tag.",
      "Client-side route changes are handled by the runtime; you do not need to re-add anything per page.",
    ],
  },
  CUSTOM,
  UNKNOWN: CUSTOM,
};

export function getInstallInstructions(platform: PlatformId): InstallInstructions {
  return { platform, ...(BY_PLATFORM[platform] ?? CUSTOM) };
}
