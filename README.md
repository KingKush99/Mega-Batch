# AI Mega Batch — Online (Cloudflare) with **AI Smart Split** (v3)

- AI/Heuristic splitter (toggle in UI).
- AI split now **chunks text** and **retries with exponential backoff** to survive 429s.
- Up to **1000 prompts** per batch; generation uses a **parallel limit** (8–24 recommended).

## Required secrets (Worker)
- `FAL_KEY` (or `FAL_API_KEY`) — FAL.ai key
- `OPENAI_API_KEY` — for AI Smart Split

## Optional vars
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `FAL_MODEL` (default `fal-ai/flux/dev`)
- `SPLIT_MAX_CHARS` (default `12000` per chunk)

## Endpoints
- `GET  /api/health`
- `POST /api/fal/txt2img`
- `POST /api/split`  body `{ text, ai: true|false }`

## Use
1) Deploy `worker.js` to Cloudflare Worker; add the secrets above.
2) Open `index.html`; set Proxy Base Path to `https://<your-worker>.workers.dev/api/fal`.
3) Paste big text → **AI Smart Split** (or Heuristic) → **🚀 Start Generation**.
