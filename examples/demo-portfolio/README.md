# WebMCP Forge demo portfolio

A static, fictional portfolio for the contest demonstration. It deliberately
contains no WebMCP implementation and no Forge runtime script: before Forge
installation, this source registers zero `document.modelContext` tools.

## Deploy it separately on Vercel

1. Import this repository into Vercel, or create another Vercel project from it.
2. Set the project **Root Directory** to `examples/demo-portfolio`.
3. Keep Vercel's static-site defaults; no build command or environment variables
   are necessary.
4. Deploy and copy the new HTTPS origin.

Scan that origin in a separately deployed WebMCP Forge instance. During the
demo, add the generated script tag to the deployed page or inject it temporarily
using DevTools. Do not commit that tag: the clean pre-installation state is part
of the demonstration.
