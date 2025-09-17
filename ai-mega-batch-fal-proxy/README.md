# AI Mega Batch — Cartoon (Online) + Smart Split (FAL-ready)

This build adds **FAL.ai** support.

## Providers
- **Proxy: FAL AI** → set **Proxy Base Path** to `/api/fal` (or full URL like `https://<worker>/api/fal`).  
  Env var: `FAL_KEY` (or `FAL_API_KEY`), optional `FAL_MODEL` (default `fal-ai/flux/dev`).
- **Proxy: Stability API** → `/api/stability`, env `STABILITY_API_KEY`.
- **Custom HTTP** → your own endpoint returning `{ images: [ "<base64>" ] }`.
- **Demo Cartoon** → no backend (for UI testing).

## Proxies
- **Cloudflare Worker:** `server/cloudflare/worker.js`
- **Express:** `server/express-proxy/server.js` (run `PORT=8787 node server.js`)

## Notes
- When opening `index.html` via `file://`, the app auto-prefixes `http://localhost:8787` for relative base paths to avoid the `file:///` CORS trap. Prefer a full URL.
- Smart Split can run heuristic-only (no keys) or AI via proxy with `OPENAI_API_KEY`.
