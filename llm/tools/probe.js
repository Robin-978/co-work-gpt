'use strict';
// 檢查訓練結果：語料/字典統計、指定 prompt 的機率分布與熵、實際續寫。
// 用法：node probe.js [溫度] ["提示1" "提示2" ...]
//   node probe.js
//   node probe.js 1.3 "今天天氣" "老師說，"
const fs = require('fs');
const path = require('path');

const WEIGHTS = path.join(__dirname, 'weights.json');
const R = JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'));
const CFG = R.cfg, V = CFG.V, C = CFG.C, H = CFG.H, F = CFG.F, HD = C / H;
const VOCAB = R.vocab, stoi = new Map(VOCAB.map((c, i) => [c, i]));
const show = (c) => (c === '\n' ? '⏎' : c === ' ' ? '␣' : c);

/* ---------- 反量化 ---------- */
function deq(t) {
  const b = Buffer.from(t.d, 'base64'), o = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) { let x = b[i]; if (x > 127) x -= 256; o[i] = x * t.s; }
  return o;
}
const P = { layers: [] };
P.wte = deq(R.tensors.wte); P.wpe = deq(R.tensors.wpe);
for (let l = 0; l < CFG.L; l++) {
  const o = {};
  for (const k of ['ln1g','ln1b','wqkv','bqkv','wo','bo','ln2g','ln2b','w1','b1','w2','b2']) o[k] = deq(R.tensors['layers.' + l + '.' + k]);
  P.layers.push(o);
}
P.lnfg = deq(R.tensors.lnfg); P.lnfb = deq(R.tensors.lnfb);
const N_PARAMS = Object.keys(R.tensors).reduce((a, k) => a + Buffer.from(R.tensors[k].d, 'base64').length, 0);

/* ---------- 推論 ---------- */
function mm(A, B, M, K, N, O) {
  O.fill(0);
  for (let m = 0; m < M; m++) {
    const ao = m * K, co = m * N;
    for (let k = 0; k < K; k++) { const a = A[ao + k]; if (!a) continue; const bo = k * N; for (let n = 0; n < N; n++) O[co + n] += a * B[bo + n]; }
  }
}
const G = Math.sqrt(2 / Math.PI), gelu = (x) => 0.5 * x * (1 + Math.tanh(G * (x + 0.044715 * x ** 3)));
function ln(x, g, b, T, out) {
  for (let t = 0; t < T; t++) {
    const o = t * C;
    let m = 0; for (let c = 0; c < C; c++) m += x[o + c]; m /= C;
    let v = 0; for (let c = 0; c < C; c++) { const d = x[o + c] - m; v += d * d; } v /= C;
    const rs = 1 / Math.sqrt(v + 1e-5);
    for (let c = 0; c < C; c++) out[o + c] = (x[o + c] - m) * rs * g[c] + b[c];
  }
}
function fwd(tok) {
  const T = tok.length;
  let x = new Float32Array(T * C);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) x[t * C + c] = P.wte[tok[t] * C + c] + P.wpe[t * C + c];
  const scale = 1 / Math.sqrt(HD);
  for (let l = 0; l < CFG.L; l++) {
    const p = P.layers[l];
    const a = new Float32Array(T * C); ln(x, p.ln1g, p.ln1b, T, a);
    const qkv = new Float32Array(T * 3 * C); mm(a, p.wqkv, T, C, 3 * C, qkv);
    for (let t = 0; t < T; t++) for (let j = 0; j < 3 * C; j++) qkv[t * 3 * C + j] += p.bqkv[j];
    const ao = new Float32Array(T * C);
    for (let h = 0; h < H; h++) {
      const qo = h * HD, ko = C + h * HD, vo = 2 * C + h * HD;
      for (let t = 0; t < T; t++) {
        const sc = new Float64Array(t + 1); let mx = -Infinity;
        for (let s = 0; s <= t; s++) { let d = 0; for (let k = 0; k < HD; k++) d += qkv[t * 3 * C + qo + k] * qkv[s * 3 * C + ko + k]; sc[s] = d * scale; if (sc[s] > mx) mx = sc[s]; }
        let sum = 0; for (let s = 0; s <= t; s++) { sc[s] = Math.exp(sc[s] - mx); sum += sc[s]; }
        for (let k = 0; k < HD; k++) { let acc = 0; for (let s = 0; s <= t; s++) acc += (sc[s] / sum) * qkv[s * 3 * C + vo + k]; ao[t * C + h * HD + k] = acc; }
      }
    }
    const pr = new Float32Array(T * C); mm(ao, p.wo, T, C, C, pr);
    const r1 = new Float32Array(T * C);
    for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) r1[t * C + c] = x[t * C + c] + pr[t * C + c] + p.bo[c];
    const a2 = new Float32Array(T * C); ln(r1, p.ln2g, p.ln2b, T, a2);
    const fc = new Float32Array(T * F); mm(a2, p.w1, T, C, F, fc);
    for (let t = 0; t < T; t++) for (let f = 0; f < F; f++) fc[t * F + f] = gelu(fc[t * F + f] + p.b1[f]);
    const fo = new Float32Array(T * C); mm(fc, p.w2, T, F, C, fo);
    const r2 = new Float32Array(T * C);
    for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) r2[t * C + c] = r1[t * C + c] + fo[t * C + c] + p.b2[c];
    x = r2;
  }
  const lf = new Float32Array(T * C); ln(x, P.lnfg, P.lnfb, T, lf);
  const lg = new Float32Array(V), o = (T - 1) * C;
  for (let v = 0; v < V; v++) { let s = 0; for (let c = 0; c < C; c++) s += lf[o + c] * P.wte[v * C + c]; lg[v] = s; }
  return lg;
}
function probs(logits, temp) {
  let mx = -Infinity;
  for (let i = 0; i < V; i++) mx = Math.max(mx, logits[i] / temp);
  let sum = 0; const e = new Float64Array(V);
  for (let i = 0; i < V; i++) { e[i] = Math.exp(logits[i] / temp - mx); sum += e[i]; }
  for (let i = 0; i < V; i++) e[i] /= sum;
  return e;
}

/* ---------- 1. 語料與字典的健康度 ---------- */
function corpusReport() {
  let text = null;
  try { text = require('./corpus.js').buildCorpus(); } catch (e) { return; }
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) || 0) + 1);
  const sorted = Array.from(freq.entries()).sort((a, b) => a[1] - b[1]);
  const ratio = text.length / freq.size;
  console.log('=== 語料 / 字典 ===');
  console.log(`語料 ${text.length.toLocaleString()} 字　字典 ${freq.size} 個字元　平均每字出現 ${ratio.toFixed(1)} 次`);
  console.log(`模型參數 ${N_PARAMS.toLocaleString()}（權重檔 ${(fs.statSync(WEIGHTS).size / 1024).toFixed(0)} KB）`);
  if (freq.size !== V) console.log(`⚠ 語料字典 ${freq.size} 與權重字典 ${V} 不一致——weights.json 是舊的，請重新訓練`);
  if (ratio < 15) console.log(`⚠ 平均每字只出現 ${ratio.toFixed(1)} 次，太少，模型學不起來；建議加語料或減少罕用字（目標 ≥ 20 次）`);
  const rare = sorted.filter(([, n]) => n < 10);
  if (rare.length) {
    console.log(`出現不到 10 次的字有 ${rare.length} 個，這些字幾乎學不到，會變成 Top-K 裡的雜訊：`);
    console.log('  ' + rare.slice(0, 40).map(([c, n]) => `${show(c)}(${n})`).join(' ') + (rare.length > 40 ? ' …' : ''));
  } else {
    console.log('✓ 每個字都至少出現 10 次');
  }
  console.log('');
}

/* ---------- 2. 分布與續寫 ---------- */
function report(prompt, temp) {
  const tok = Array.from(prompt).map((c) => stoi.get(c));
  const bad = Array.from(prompt).filter((c) => !stoi.has(c));
  if (bad.length) return console.log(`"${prompt}" → 不在字典的字：${bad.join(' ')}`);
  const p = probs(fwd(tok), temp);
  const top = Array.from(p, (q, i) => [i, q]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  let Hb = 0;
  for (const q of p) if (q > 1e-12) Hb -= q * Math.log2(q);
  console.log(`"${prompt}" → ` + top.map(([i, q]) => `${show(VOCAB[i])} ${(q * 100).toFixed(1)}%`).join('  ') + `　| 熵 ${Hb.toFixed(2)} bits`);
}
function gen(prompt, n, temp) {
  let tok = Array.from(prompt).map((c) => stoi.get(c));
  if (tok.some((t) => t === undefined)) return '(有字不在字典)';
  let out = prompt;
  for (let i = 0; i < n; i++) {
    const p = probs(fwd(tok.slice(-CFG.B)), temp);
    let r = Math.random(), k = V - 1;
    for (let j = 0; j < V; j++) { r -= p[j]; if (r <= 0) { k = j; break; } }
    tok.push(k); out += VOCAB[k];
  }
  return out.replace(/\n/g, '⏎');
}

// 讓其他工具（例如 rag_demo.js）可以直接用這裡的推論核心
module.exports = { CFG, VOCAB, stoi, show, fwd, probs, gen };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const temp = argv.length && !isNaN(parseFloat(argv[0])) ? parseFloat(argv.shift()) : 1.3;
  const prompts = argv.length ? argv : ['今天天氣', '今天天氣很', '老師說，', '如果明天', '我喜歡在早上'];

  corpusReport();
  console.log(`=== 下一個字的機率分布（溫度 ${temp}）===`);
  for (const s of prompts) report(s, temp);
  console.log(`\n=== 實際續寫（溫度 ${temp}）===`);
  for (const s of prompts.slice(0, 3)) console.log('  ' + gen(s, 26, temp));
}
