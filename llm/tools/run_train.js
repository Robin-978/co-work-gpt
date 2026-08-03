'use strict';
const fs = require('fs');
const { buildCorpus } = require('./corpus.js');
const { makeModel, forward, backward, crossEntropyAndDLogits, paramList, makeGrads } = require('./train.js');

const text = buildCorpus();
const chars = Array.from(new Set(Array.from(text))).sort();
const stoi = new Map(chars.map((c, i) => [c, i]));
const data = Int32Array.from(Array.from(text).map((c) => stoi.get(c)));
console.log('corpus chars', text.length, 'vocab', chars.length);

// 超參數可用環境變數覆寫，例如：DIM=48 HEADS=3 FF=128 STEPS=3000 node run_train.js
const num = (k, d) => (process.env[k] ? parseInt(process.env[k], 10) : d);
const cfg = {
  V: chars.length,
  C: num('DIM', 64),      // 向量維度，必須能被 HEADS 整除
  L: num('LAYERS', 2),    // 層數
  H: num('HEADS', 4),     // 注意力頭數
  F: num('FF', 192),      // 前饋層寬度
  B: num('BLOCK', 48),    // 上下文長度
};
if (cfg.C % cfg.H) throw new Error('DIM 必須能被 HEADS 整除');
const model = makeModel(cfg);
const params = paramList(model);
console.log('params', params.reduce((a, [, x]) => a + x.length, 0));

const grads = makeGrads(model);
const m = {}, v = {};
for (const [name, arr] of params) { m[name] = new Float32Array(arr.length); v[name] = new Float32Array(arr.length); }

const T = cfg.B;
const BATCH = num('BATCH', 12);
const STEPS = num('STEPS', 7000);
const LR = process.env.LR ? parseFloat(process.env.LR) : 2.5e-3;
const WARM = 150, MINLR = 1.5e-4, WD = 0.02;
const beta1 = 0.9, beta2 = 0.95, eps = 1e-8;

let seed = 7;
function nextRand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const cache = {};
const dl = new Float32Array(T * cfg.V);
const t0 = Date.now();
let best = Infinity;

for (let step = 1; step <= STEPS; step++) {
  for (const [name] of params) grads[name].fill(0);
  let loss = 0;
  for (let b = 0; b < BATCH; b++) {
    const i = Math.floor(nextRand() * (data.length - T - 1));
    const toks = Array.from(data.subarray(i, i + T));
    const tgts = Array.from(data.subarray(i + 1, i + T + 1));
    forward(model, toks, cache);
    loss += crossEntropyAndDLogits(model, cache, tgts, dl);
    for (let k = 0; k < dl.length; k++) dl[k] /= BATCH;
    backward(model, cache, dl, grads);
  }
  loss /= BATCH;

  // grad clip
  let sq = 0;
  for (const [name] of params) { const g = grads[name]; for (let i = 0; i < g.length; i++) sq += g[i] * g[i]; }
  const norm = Math.sqrt(sq);
  const clip = norm > 1 ? 1 / norm : 1;

  const lr = step < WARM ? LR * step / WARM
    : MINLR + 0.5 * (LR - MINLR) * (1 + Math.cos(Math.PI * (step - WARM) / (STEPS - WARM)));

  for (const [name, arr] of params) {
    const g = grads[name], mm = m[name], vv = v[name];
    const decay = /w(te|pe|qkv|o|1|2)$/.test(name.split('.').pop()) && name !== 'wpe' ? WD : 0;
    for (let i = 0; i < arr.length; i++) {
      const gi = g[i] * clip;
      mm[i] = beta1 * mm[i] + (1 - beta1) * gi;
      vv[i] = beta2 * vv[i] + (1 - beta2) * gi * gi;
      const mh = mm[i] / (1 - Math.pow(beta1, step));
      const vh = vv[i] / (1 - Math.pow(beta2, step));
      arr[i] -= lr * (mh / (Math.sqrt(vh) + eps) + decay * arr[i]);
    }
  }

  if (step % 50 === 0 || step === 1) {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`step ${step}/${STEPS} loss ${loss.toFixed(4)} lr ${lr.toExponential(2)} |g| ${norm.toFixed(2)} ${el}s`);
  }
  if (step % 400 === 0 || step === STEPS) {
    for (const q of (process.env.SAMPLES || 'MOCVD 的|Cpk 大於|磊晶的').split('|')) {
      console.log('  sample:', sample(q, 40, 0.9));
    }
    save();
  }
  if (loss < best) best = loss;
}
console.log('best loss', best.toFixed(4));

function sample(prompt, n, temp) {
  let toks = Array.from(prompt).map((c) => (stoi.has(c) ? stoi.get(c) : 0));
  let out = prompt;
  for (let i = 0; i < n; i++) {
    const ctx = toks.slice(-cfg.B);
    const c = forward(model, ctx, {});
    const o = (ctx.length - 1) * cfg.V;
    const lg = [];
    let mx = -Infinity;
    for (let vv = 0; vv < cfg.V; vv++) { const z = c.logits[o + vv] / temp; lg.push(z); if (z > mx) mx = z; }
    let s = 0;
    for (let vv = 0; vv < cfg.V; vv++) { lg[vv] = Math.exp(lg[vv] - mx); s += lg[vv]; }
    let r = nextRand() * s, pick = cfg.V - 1;
    for (let vv = 0; vv < cfg.V; vv++) { r -= lg[vv]; if (r <= 0) { pick = vv; break; } }
    toks.push(pick);
    out += chars[pick];
  }
  return out.replace(/\n/g, '⏎');
}

function save() {
  // int8 對稱量化，每個張量一個 scale
  const tensors = {};
  for (const [name, arr] of params) {
    let mx = 0;
    for (let i = 0; i < arr.length; i++) mx = Math.max(mx, Math.abs(arr[i]));
    const scale = mx / 127 || 1e-8;
    const q = Buffer.alloc(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let qi = Math.round(arr[i] / scale);
      if (qi > 127) qi = 127; if (qi < -127) qi = -127;
      q[i] = qi & 0xff;
    }
    tensors[name] = { s: scale, d: q.toString('base64') };
  }
  const out = { cfg, vocab: chars, tensors };
  fs.writeFileSync(__dirname + '/weights.json', JSON.stringify(out));
  const kb = (fs.statSync(__dirname + '/weights.json').size / 1024).toFixed(0);
  console.log(`  saved weights.json (${kb} KB)`);
}
