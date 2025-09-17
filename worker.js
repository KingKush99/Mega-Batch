// Cloudflare Worker v2: FAL proxy + AI Smart Split (chunked + backoff)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });

    try {
      if (url.pathname === "/api/health") return json({ ok: true }, request);

      if (url.pathname === "/api/fal/txt2img" && request.method === "POST") {
        const key = env.FAL_KEY || env.FAL_API_KEY;
        if (!key) return json({ error: "Missing FAL_KEY" }, request, 500);
        const model = env.FAL_MODEL || "fal-ai/flux/dev";
        const body = await request.json();
        const { prompt = "", negative_prompt = "", width = 768, height = 576, steps = 26 } = body || {};

        const upstream = await fetch(`https://fal.run/${model}`, {
          method: "POST",
          headers: { "Authorization": `Key ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, negative_prompt, image_size: { width, height }, num_inference_steps: steps })
        });
        if (!upstream.ok) {
          return json({ error: "FAL upstream", status: upstream.status, details: await safeText(upstream) }, request, upstream.status);
        }
        const data = await upstream.json();
        const urls = [
          data?.image?.url,
          ...(data?.images?.map(i => i.url) || []),
          ...(data?.output?.map(i => i.url) || []),
        ].filter(Boolean);
        if (!urls.length) return json({ error: "No image URL returned by FAL" }, request, 502);

        const imgResp = await fetch(urls[0]);
        if (!imgResp.ok) return json({ error: "Image fetch failed", details: await safeText(imgResp) }, request, imgResp.status);

        const buf = await imgResp.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        return json({ images: [b64], mime: imgResp.headers.get("content-type") || "image/png" }, request);
      }

      if (url.pathname === "/api/split" && request.method === "POST") {
        const { text = "", ai = false } = await request.json();
        if (!text.trim()) return json({ error: "No text provided" }, request, 400);

        const HARD_MAX = 1000;
        if (!ai) {
          const arr = heuristicSplit(text).slice(0, HARD_MAX);
          return json({ mode: "heuristic", prompts: arr }, request);
        }

        if (!env.OPENAI_API_KEY) {
          return json({ error: "AI split requested but OPENAI_API_KEY is not set on the Worker" }, request, 400);
        }

        const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";
        const CHUNK_CHARS = parseInt(env.SPLIT_MAX_CHARS || "12000", 10); // keep each request small
        const chunks = smartChunks(text, CHUNK_CHARS);

        const prompts = [];
        for (let i = 0; i < chunks.length; i++) {
          const part = chunks[i];
          const sys = `You are a precise prompt chunk splitter. Return ONLY JSON like {"prompts":["..."]}. 
Each element must be a self-contained image prompt derived from the user's text. 
Do NOT invent content. Preserve as-is. If the text contains numbering or separators, use them as boundaries.`;
          const payload = {
            model: OPENAI_MODEL,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: part }
            ],
            temperature: 0.1
          };

          const r = await withBackoff(() => fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }), 4, 400);

          if (!r.ok) return json({ error: "OpenAI upstream", status: r.status, details: await safeText(r) }, request, r.status);
          const data = await r.json();
          const content = data?.choices?.[0]?.message?.content || "";
          const arr = extractPromptsFromContent(content);
          for (const p of arr) if (p && !prompts.includes(p)) prompts.push(p);
          if (prompts.length >= HARD_MAX) break;
        }

        return json({ mode: "ai", prompts: prompts.slice(0, HARD_MAX) }, request);
      }

      return json({ error: "Not found" }, request, 404);
    } catch (e) {
      return json({ error: "Server error", details: String(e) }, request, 500);
    }
  }
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, request, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}
async function safeText(resp){ try { return await resp.text(); } catch { return ""; } }

function extractPromptsFromContent(content) {
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : content);
    if (Array.isArray(obj.prompts)) return obj.prompts.map(x => String(x).trim()).filter(Boolean);
  } catch {}
  // fallback: split lines
  return content.split(/\n{2,}|\n-\s+|\n\d+[.)]\s+/).map(s => s.trim()).filter(Boolean);
}

// Backoff helper for 429s
async function withBackoff(fn, tries=4, startMs=400) {
  let delay = startMs;
  for (let i=0; i<tries; i++) {
    const r = await fn();
    if (r.status !== 429) return r;
    await new Promise(res => setTimeout(res, delay));
    delay *= 2;
  }
  return await fn(); // final
}

function heuristicSplit(text) {
  text = (text || "").replace(/\r\n/g, "\n").replace(/\u00A0/g, " ").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const isSep = (s) => /^\s*(?:[-–—]{3,}|={3,}|\*{3,}|#{2,}|_{3,})\s*$/.test(s);
  const bulletRe = /^\s*(?:[-*•◦–]|(\d+)[\.)]|(?:Prompt|Image|Scene|Shot)\s*#?\s*\d+[:.\-]?)\s+/i;
  const blocks = []; let cur = [];
  const pushCur = () => { const j = cur.join(" ").replace(/\s{2,}/g, " ").trim(); if (j) blocks.push(j); cur = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (cur.length) pushCur(); continue; }
    if (isSep(line)) { if (cur.length) pushCur(); continue; }
    if (bulletRe.test(line)) { if (cur.length) pushCur(); cur.push(line.replace(bulletRe, "")); continue; }
    if (/^([A-Z][\w\s]{0,60})[:\-–—]\s*$/.test(line) && cur.length) { pushCur(); cur.push(line.replace(/[:\-–—]\s*$/, "")); continue; }
    cur.push(line);
  }
  if (cur.length) pushCur();
  const minLen = 12; const merged = [];
  for (let i = 0; i < blocks.length; i++) { const b = blocks[i]; if (b.length < minLen && i < blocks.length - 1) { blocks[i + 1] = b + " " + blocks[i + 1]; } else { merged.push(b); } }
  const out = []; const seen = new Set();
  for (const b of merged) { const t = b.trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); } }
  return out;
}

// chunk on clear boundaries, then by length
function smartChunks(text, maxChars) {
  const parts = [];
  const rough = text.split(/\n-{3,}\n|={3,}\n|\n\n+/); // separators/paragraphs
  let cur = "";
  for (const p of rough) {
    if ((cur + "\n" + p).length > maxChars) {
      if (cur) parts.push(cur.trim());
      if (p.length > maxChars) {
        // force-split overly long piece
        for (let i = 0; i < p.length; i += maxChars) parts.push(p.slice(i, i + maxChars));
        cur = "";
      } else {
        cur = p;
      }
    } else {
      cur = cur ? (cur + "\n\n" + p) : p;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
