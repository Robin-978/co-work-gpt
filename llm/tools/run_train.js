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

// RESUME=1 時，從既有的 weights.json 接著訓練（微調），而不是從零開始。
// 語料改過、字典多了幾個字也沒關係：舊字的詞向量會照「字」搬過來，新字才隨機初始化。
const RESUME = process.env.RESUME ? String(process.env.RESUME) : '';
const ckptPath = RESUME && RESUME !== '1' ? RESUME : __dirname + '/weights.json';

function loadCheckpoint(model) {
  const R = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
  for (const k of ['C', 'L', 'H', 'F', 'B']) {
    if (R.cfg[k] !== cfg[k]) {
      throw new Error(`續訓失敗：檢查點的 ${k}=${R.cfg[k]}，這次要的是 ${cfg[k]}。` +
        `續訓不能改模型結構，請用 ${k === 'C' ? 'DIM' : k === 'L' ? 'LAYERS' : k === 'H' ? 'HEADS' : k === 'F' ? 'FF' : 'BLOCK'}=${R.cfg[k]}，或拿掉 RESUME 從零訓練。`);
    }
  }
  const deq = (t) => {
    const b = Buffer.from(t.d, 'base64'), o = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) { let x = b[i]; if (x > 127) x -= 256; o[i] = x * t.s; }
    return o;
  };
  const oldIdx = new Map(R.vocab.map((c, i) => [c, i]));
  let kept = 0;
  for (const [name, arr] of paramList(model)) {
    const src = deq(R.tensors[name]);
    if (name === 'wte') {
      // 逐「字」搬：舊字典有的就沿用，沒有的維持隨機初始化
      for (let i = 0; i < chars.length; i++) {
        const j = oldIdx.get(chars[i]);
        if (j === undefined) continue;
        for (let c = 0; c < cfg.C; c++) arr[i * cfg.C + c] = src[j * cfg.C + c];
        kept++;
      }
    } else {
      if (src.length !== arr.length) throw new Error(`續訓失敗：張量 ${name} 大小不符`);
      arr.set(src);
    }
  }
  const fresh = chars.length - kept;
  console.log(`續訓：載入 ${ckptPath}`);
  console.log(`  字典 ${R.vocab.length} → ${chars.length}，沿用 ${kept} 個字的詞向量，${fresh} 個新字隨機初始化`);
  if (fresh > 40) console.log(`  ⚠ 新字有 ${fresh} 個，數量偏多，續訓可能不夠——考慮拿掉 RESUME 從零訓練`);
}

const model = makeModel(cfg);
const params = paramList(model);
console.log('params', params.reduce((a, [, x]) => a + x.length, 0));
if (RESUME) loadCheckpoint(model);

const grads = makeGrads(model);
const m = {}, v = {};
for (const [name, arr] of params) { m[name] = new Float32Array(arr.length); v[name] = new Float32Array(arr.length); }

const T = cfg.B;
const BATCH = num('BATCH', 12);
// 續訓的預設值不一樣：步數少、學習率小，才不會把原本學會的東西洗掉
const STEPS = num('STEPS', RESUME ? 900 : 7000);
const LR = process.env.LR ? parseFloat(process.env.LR) : (RESUME ? 4e-4 : 2.5e-3);
const WARM = RESUME ? 40 : 150, MINLR = RESUME ? 5e-5 : 1.5e-4, WD = 0.02;
const beta1 = 0.9, beta2 = 0.95, eps = 1e-8;

let seed = 7;
function nextRand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const cache = {};
const dl = new Float32Array(T * cfg.V);
const t0 = Date.now();
let best = Infinity;

// 續訓前先量一次 loss：如果檢查點有正確載入，這個值會接近它當初訓練到的 loss，
// 而不是從零開始的 ~6.5。這是確認「真的接上了」最直接的證據。
function evalLoss(n) {
  let s = 0, sd = 12345;
  const r = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
  for (let b = 0; b < n; b++) {
    const i = Math.floor(r() * (data.length - T - 1));
    forward(model, Array.from(data.subarray(i, i + T)), cache);
    s += crossEntropyAndDLogits(model, cache, Array.from(data.subarray(i + 1, i + T + 1)), dl);
  }
  return s / n;
}
if (RESUME) {
  console.log(`  載入後的 loss ${evalLoss(24).toFixed(4)}（從零開始約 ${Math.log(cfg.V).toFixed(2)}）`);
  const prev = __dirname + '/weights.prev.json';
  fs.copyFileSync(ckptPath, prev);
  console.log(`  原檢查點已備份到 ${prev}`);
}
console.log(`設定：STEPS=${STEPS} LR=${LR} BATCH=${BATCH} ${RESUME ? '(續訓)' : '(從零訓練)'}`);

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
