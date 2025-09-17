// Express proxy with CORS + Stability + FAL + Smart Split (AI optional)
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json({ limit: '10mb' }));

app.get('/api/health', (_, res)=> res.json({ ok: true }));

app.post('/api/stability/txt2img', async (req, res) => {
  try {
    const key = process.env.STABILITY_API_KEY;
    if(!key) return res.status(500).json({ error: 'Missing STABILITY_API_KEY' });

    const { prompt, negative_prompt, width=768, height=576, steps=26, style_preset="anime" } = req.body || {};
    const endpoint = 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        text_prompts: [
          { text: prompt, weight: 1.0 },
          { text: negative_prompt || '', weight: -1.0 }
        ],
        width: Math.min(1024, width),
        height: Math.min(1024, height),
        steps,
        style_preset
      })
    });
    if(!resp.ok){ const t = await resp.text(); return res.status(resp.status).json({ error: 'Stability error', details: t }); }
    const data = await resp.json();
    const images = (data.artifacts || []).map(a => a.base64);
    res.json({ images });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Proxy error', details: String(e) });
  }
});

app.post('/api/fal/txt2img', async (req, res) => {
  try {
    const key = process.env.FAL_KEY || process.env.FAL_API_KEY;
    if (!key) return res.status(500).json({ error: 'Missing FAL_KEY' });
    const MODEL = process.env.FAL_MODEL || 'fal-ai/flux/dev';

    const { prompt, negative_prompt, width=768, height=576, steps=26 } = req.body || {};
    const upstream = await fetch(`https://fal.run/${MODEL}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, negative_prompt, image_size: { width, height }, num_inference_steps: steps
      })
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'FAL upstream', details: await upstream.text() });

    const json = await upstream.json();
    const urls = [
      json?.image?.url,
      ...(json?.images?.map(i => i.url) || []),
      ...(json?.output?.map(i => i.url) || []),
    ].filter(Boolean);
    if (!urls.length) return res.status(500).json({ error: 'No image URL returned by FAL' });

    const imgResp = await fetch(urls[0]);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get('content-type') || 'image/png';
    res.json({ images: [buf.toString('base64')], mime });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Proxy error', details: String(e) });
  }
});

function heuristicSplit(text){
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

app.post('/api/split', async (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    const useAI = !!process.env.OPENAI_API_KEY;
    if(!useAI){
      return res.json({ mode: 'heuristic', prompts: heuristicSplit(text) });
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const payload = {
      model,
      messages: [
        { role: "system", content: "Split the user's text into an ordered JSON array of image prompts. Do not paraphrase. Preserve wording. Only return valid JSON: {\"prompts\": [\"...\"]}." },
        { role: "user", content: text }
      ],
      temperature: 0.1
    };
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if(!resp.ok){ const t=await resp.text(); console.error(t); return res.json({ mode:'heuristic', prompts: heuristicSplit(text), note:'AI split failed, used heuristic' }); }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    let prompts=[];
    try{
      const match = content.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match? match[0] : content);
      if(Array.isArray(obj.prompts)) prompts = obj.prompts;
    }catch{}
    if(!prompts.length) prompts = heuristicSplit(text);
    res.json({ mode: 'ai', prompts });
  } catch (e) {
    console.error(e);
    res.json({ mode:'heuristic', prompts: heuristicSplit((req.body&&req.body.text)||''), note:'AI split error, used heuristic' });
  }
});

app.post('/api/custom/txt2img', async (req, res) => {
  try {
    const { target, ...payload } = req.body || {};
    const url = target || process.env.TARGET_URL;
    if(!url) return res.status(400).json({ error: 'Missing target URL' });
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if(!resp.ok){ const t=await resp.text(); return res.status(resp.status).json({ error: 'Upstream error', details: t }); }
    const json = await resp.json();
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Proxy error', details: String(e) });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, ()=> console.log('Proxy listening on http://localhost:'+port));
