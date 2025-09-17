// Cloudflare Worker proxy: Stability + FAL + Smart Split
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
    if (url.pathname === '/api/health') return json({ ok: true }, request);

    if (url.pathname === '/api/stability/txt2img' && request.method === 'POST') {
      if (!env.STABILITY_API_KEY) return json({ error: 'Missing STABILITY_API_KEY' }, request, 500);
      const body = await request.json();
      const prompt = body.prompt || '';
      const negative = body.negative_prompt || '';
      const width = Math.min(1024, body.width || 768);
      const height = Math.min(1024, body.height || 576);
      const steps = body.steps || 26;
      const style_preset = body.style_preset || 'anime';
      const endpoint = 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image';
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.STABILITY_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          text_prompts: [
            { text: prompt, weight: 1.0 },
            { text: negative, weight: -1.0 }
          ],
          width, height, steps, style_preset
        })
      });
      if (!upstream.ok) {
        const t = await upstream.text();
        return json({ error: 'Stability error', details: t }, request, upstream.status);
      }
      const data = await upstream.json();
      const images = (data.artifacts || []).map(a => a.base64);
      return json({ images }, request);
    }

    if (url.pathname === '/api/fal/txt2img' && request.method === 'POST') {
      if (!env.FAL_KEY && !env.FAL_API_KEY) return json({ error: 'Missing FAL_KEY' }, request, 500);
      const key = env.FAL_KEY || env.FAL_API_KEY;
      const model = env.FAL_MODEL || 'fal-ai/flux/dev';
      const body = await request.json();
      const prompt = body.prompt || '';
      const negative_prompt = body.negative_prompt || '';
      const width = body.width || 768;
      const height = body.height || 576;
      const steps = body.steps || 26;
      const upstream = await fetch(`https://fal.run/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt, negative_prompt, image_size: { width, height }, num_inference_steps: steps
        })
      });
      if (!upstream.ok) {
        const t = await upstream.text();
        return json({ error: 'FAL upstream', details: t }, request, upstream.status);
      }
      const jsonData = await upstream.json();
      const urls = [
        jsonData?.image?.url,
        ...(jsonData?.images?.map(i => i.url) || []),
        ...(jsonData?.output?.map(i => i.url) || []),
      ].filter(Boolean);
      if (!urls.length) return json({ error: 'No image URL returned by FAL' }, request, 500);
      const imgResp = await fetch(urls[0]);
      const arr = await imgResp.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(arr)));
      return json({ images: [b64], mime: imgResp.headers.get('content-type') || 'image/png' }, request);
    }

    if (url.pathname === '/api/split' && request.method === 'POST') {
      const body = await request.json();
      const text = body.text || '';
      const prompts = heuristicSplit(text);
      if (env.OPENAI_API_KEY) {
        try {
          const payload = {
            model: env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
              { role: "system", content: "Split the user's text into an ordered JSON array of image prompts. Do not paraphrase. Preserve wording. Only return valid JSON: {\"prompts\": [\"...\"]}." },
              { role: "user", content: text }
            ],
            temperature: 0.1
          };
          const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (resp.ok) {
            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content || '';
            let arr=[];
            try{
              const match = content.match(/\{[\s\S]*\}/);
              const obj = JSON.parse(match? match[0] : content);
              if (Array.isArray(obj.prompts)) arr = obj.prompts;
            }catch{}
            if (arr.length) return json({ mode:'ai', prompts: arr }, request);
          }
        } catch (e) {}
      }
      return json({ mode:'heuristic', prompts }, request);
    }

    return json({ error: 'Not found' }, request, 404);
  }
};

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
function json(obj, request, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}
function heuristicSplit(text) {
  text = (text||'').replace(/\r\n/g,'\n').replace(/\u00A0/g,' ').trim();
  if(!text) return [];
  const lines = text.split('\n');
  const isSep = (s)=>/^\s*(?:[-–—]{3,}|={3,}|\*{3,}|#{2,}|_{3,})\s*$/.test(s);
  const bulletRe = /^\s*(?:[-*•◦–]|(\d+)[\.\)]|(?:Prompt|Image|Scene|Shot)\s*#?\s*\d+[:.\-]?)\s+/i;
  const blocks=[]; let cur=[];
  const pushCur=()=>{ const j=cur.join(' ').replace(/\s{2,}/g,' ').trim(); if(j) blocks.push(j); cur=[]; };
  for(const raw of lines){
    const line = raw.trim();
    if(!line){ if(cur.length) pushCur(); continue; }
    if(isSep(line)){ if(cur.length) pushCur(); continue; }
    if(bulletRe.test(line)){ if(cur.length) pushCur(); cur.push(line.replace(bulletRe,'')); continue; }
    if(/^([A-Z][\w\s]{0,60})[:\-–—]\s*$/.test(line) && cur.length){ pushCur(); cur.push(line.replace(/[:\-–—]\s*$/,'')); continue; }
    cur.push(line);
  }
  if(cur.length) pushCur();
  const minLen=12; const merged=[];
  for(let i=0;i<blocks.length;i++){ const b=blocks[i]; if(b.length<minLen && i<blocks.length-1){ blocks[i+1]=b+' '+blocks[i+1]; } else { merged.push(b); } }
  const out=[]; const seen=new Set();
  for(const b of merged){ const t=b.trim(); if(t && !seen.has(t.toLowerCase())){ seen.add(t.toLowerCase()); out.push(t); } }
  return out;
}
