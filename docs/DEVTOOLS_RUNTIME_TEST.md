# Test the runtime temporarily with DevTools

Use this path to prove a generated integration before permanently adding the
script to a portfolio. It is for a site you own or are authorised to test.

1. Start Forge locally with `pnpm dev`, or use a deployed Forge origin.
   If the target portfolio is HTTPS, expose local Forge through an HTTPS
   development tunnel or preview deployment so the browser can load the
   runtime without mixed-content restrictions. Do not disable browser security
   as a testing shortcut.
2. Open the target portfolio in a WebMCP-capable browser and open DevTools.
3. In the Console, replace the two values below and run it:

```js
const script = document.createElement("script");
script.src = "https://YOUR-FORGE-ORIGIN/runtime/v1.js";
script.dataset.wmfSite = "wmf_YOUR_SITE_ID";
script.defer = true;
document.head.append(script);
```

4. Wait for the script load, then inspect the runtime:

```js
window.__webmcpForge.getState();
window.__webmcpForge.getLiveCounts();
await document.modelContext.getTools();
await window.__webmcpForge.invokeViaWebMcp("list_projects");
```

`getState()` reports configuration and registration status. `getLiveCounts()`
checks the current DOM, not a saved scan. The last command runs through the
browser's WebMCP registry; use another enabled tool name and input where
appropriate.

If `document.modelContext` is unavailable, the runtime still reads the DOM and
reports that WebMCP is unsupported. That is expected in browsers without the
experimental API; it is not a successful agent-tool test.

To test installation verification temporarily, click **Check installation** in
Forge. It opens the portfolio with a short-lived challenge in the URL. Inject
the runtime in that verification tab before the challenge expires; the runtime
will make its normal callback, then return to Forge to see the result.

Removing the injected element does not fully undo runtime listeners or tool
registrations. Reload the portfolio page for a clean reset. The permanent
installation is the generated script tag in the site's source or custom-code
area.
