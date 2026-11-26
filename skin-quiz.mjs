#!/usr/bin/env node
// Selfie -> YouCam AI Skin Analysis -> product picks from any Shopify store.
// Bring your own YouCam API key: https://yce.makeupar.com/api-console
// Usage: YOUCAM_API_KEY=... node skin-quiz.mjs selfie.jpg https://yourstore.com [acne,pore,redness,moisture]
// Node 18+, no dependencies. MIT licence.
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const BASE = process.env.YOUCAM_API_BASE || 'https://yce-api-01.makeupar.com';
const KEY = process.env.YOUCAM_API_KEY;
const [, , imagePath, shopUrl, concernArg] = process.argv;
if (!imagePath || !shopUrl) {
  console.error('Usage: YOUCAM_API_KEY=... node skin-quiz.mjs selfie.jpg https://yourstore.com [acne,pore,redness,moisture]');
  process.exit(1);
}
// 1-4 concerns is the cheapest Skin Analysis tier (SD). Valid codes include:
// acne, redness, pore, moisture, wrinkle, age_spot, texture, radiance
const concerns = (concernArg || 'acne,pore,redness,moisture').split(',').map(s => s.trim()).slice(0, 4);

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.status && body.status !== 200)) throw new Error(`${path}: HTTP ${res.status} ${body.error || ''}`);
  return body;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. Ask YouCam for an upload URL, then PUT the photo bytes to it
const bytes = await readFile(imagePath);
const type = extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
const init = await api('/s2s/v2.0/file', {
  method: 'POST',
  body: JSON.stringify({ files: [{ content_type: type, file_name: basename(imagePath), file_size: bytes.length }] }),
});
const file = init.data.files[0];
const upload = file.requests[0];
const put = await fetch(upload.url, { method: upload.method || 'PUT', headers: upload.headers || { 'Content-Type': type }, body: bytes });
if (!put.ok) throw new Error(`upload failed: HTTP ${put.status}`);

// 2. Start the skin analysis task and poll until it finishes
const task = await api('/s2s/v2.1/task/skin-analysis', {
  method: 'POST',
  body: JSON.stringify({ src_file_id: file.file_id, dst_actions: concerns, miniserver_args: { enable_mask_overlay: false }, format: 'json' }),
});
let result;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const r = await api(`/s2s/v2.1/task/skin-analysis/${task.data.task_id}`);
  if (r.data.task_status === 'success') { result = r.data.results.output; break; }
  if (r.data.task_status !== 'running') throw new Error(`analysis ${r.data.task_status}: ${r.data.error || ''}`);
}
if (!result) throw new Error('analysis timed out');

// 3. ui_score: 0-100, higher = healthier-looking skin. Lowest scores = focus areas.
const scores = result.filter(o => concerns.includes(o.type)).map(o => ({ type: o.type, score: Math.round(o.ui_score) }))
  .sort((a, b) => a.score - b.score);
const overall = result.find(o => o.type === 'all')?.score;
const skinAge = result.find(o => o.type === 'skin_age')?.score;

// 4. Match products from the store's public Shopify feed by ingredient keywords
const KEYWORDS = {
  acne: ['salicylic', 'bha', 'benzoyl', 'blemish', 'acne', 'azelaic', 'tea tree'],
  redness: ['centella', 'cica', 'azelaic', 'soothing', 'calming', 'redness', 'panthenol'],
  pore: ['niacinamide', 'pore', 'bha', 'salicylic', 'clay', 'zinc'],
  moisture: ['hyaluronic', 'ceramide', 'squalane', 'moisturi', 'hydrat', 'barrier'],
  wrinkle: ['retinol', 'retinal', 'peptide', 'bakuchiol', 'collagen', 'firming'],
  age_spot: ['vitamin c', 'tranexamic', 'arbutin', 'dark spot', 'brightening', 'spf'],
  texture: ['aha', 'glycolic', 'lactic', 'mandelic', 'exfoliat', 'resurfacing'],
  radiance: ['vitamin c', 'glow', 'radiance', 'brighten', 'niacinamide'],
};
const SKIP = /\b(gift|bundle|kit|set|routine|advent|calendar|mystery|sample|duo|trio|body)\b/i;
const feed = await (await fetch(shopUrl.replace(/\/$/, '') + '/products.json?limit=250')).json().catch(() => ({ products: [] }));
const products = (feed.products || [])
  .filter(p => !SKIP.test(p.title) && p.variants.some(v => v.available !== false && Number(v.price) > 0))
  .map(p => ({ ...p, text: [p.title, [].concat(p.tags).join(' '), p.product_type, String(p.body_html || '').replace(/<[^>]+>/g, ' ')].join(' ').toLowerCase() }));
const picks = [];
for (const c of scores.slice(0, 3)) {
  const best = products.filter(p => !picks.some(x => x.handle === p.handle))
    .map(p => ({ p, hits: KEYWORDS[c.type].filter(k => p.text.includes(k)) }))
    .filter(x => x.hits.length).sort((a, b) => b.hits.length - a.hits.length)[0];
  if (best) picks.push({ handle: best.p.handle, title: best.p.title, price: best.p.variants[0].price, for: c.type, hits: best.hits.slice(0, 2),
    url: `${shopUrl.replace(/\/$/, '')}/products/${best.p.handle}` });
}
console.log(JSON.stringify({ overall, skinAge, scores, picks }, null, 2));
