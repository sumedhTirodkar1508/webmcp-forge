# Contest demo runbook

This is a focused three-to-five minute product demonstration.

1. Open the clean demo portfolio from `examples/demo-portfolio` on its own
   Vercel deployment. Point out that its source is plain HTML/CSS: no Forge
   runtime and no `document.modelContext` calls.
2. Open Forge and scan that public URL. Show the profile, four projects, three
   experience entries, six skill groups, two education entries, contact data,
   and hash navigation candidates.
3. Review the suggested capabilities, generate an installation, and publish.
   Copy the one script tag into the portfolio's custom-code location (or use
   the temporary DevTools path in `DEVTOOLS_RUNTIME_TEST.md`).
4. Run **Check installation**. Show live DOM counts and the browser WebMCP
   registration result. In a WebMCP-capable browser, invoke `list_projects`,
   `get_project`, `get_skills`, `get_experience`, `navigate_site`, and
   `focus_project` from the registered tools. Make the last two visible by
   showing the page move to a hash target and focus a project card.
5. Add another project card matching the existing markup, reload, and invoke
   `list_projects` again. The count changes without scanning or publishing;
   the runtime always reads the live DOM.
6. On the Forge builder, demonstrate its own WebMCP tools: set a target URL,
   scan, inspect the summary, change an allowed capability, and generate the
   installation. End on the builder's Agent Ready state. The agent and UI
   share the same application actions.

What to emphasize:

- Gemini is used once during setup to select scanner-verified structure. It is
  never called by a portfolio runtime tool invocation.
- The production scanner is bounded server-side fetch plus Cheerio, not a
  headless browser. SSRF checks run on every redirect and connection lookup.
- The generated runtime is framework-free and has no database or Gemini
  dependency. It registers genuine browser WebMCP tools when supported.
- If a site already exposes a tool with a Forge capability name, Forge leaves
  that native tool untouched and reports the collision in verification rather
  than overwriting it or claiming registration succeeded.
