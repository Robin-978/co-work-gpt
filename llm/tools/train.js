'use strict';
// 純 JS 訓練一個極小的 GPT（char-level），輸出量化後的權重供網頁端 inference 使用。
const fs = require('fs');
const path = require('path');
const { buildCorpus } = require('./corpus.js');

// ---------- utils ----------
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const rand = rng(1337);
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function zeros(n) { return new Float32Array(n); }
function normal(n, std) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = randn() * std; return a; }
function ones(n) { const a = new Float32Array(n); a.fill(1); return a; }

// C[M,N] = A[M,K] @ B[K,N]
function matmul(A, B, M, K, N, C) {
  C.fill(0);
  for (let m = 0; m < M; m++) {
    const ao = m * K, co = m * N;
    for (let k = 0; k < K; k++) {
      const a = A[ao + k];
      if (a === 0) continue;
      const bo = k * N;
      for (let n = 0; n < N; n++) C[co + n] += a * B[bo + n];
    }
  }
}
// C[M,K] += dY[M,N] @ B[K,N]^T
function matmulNT(dY, B, M, K, N, C) {
  for (let m = 0; m < M; m++) {
    const yo = m * N, co = m * K;
    for (let k = 0; k < K; k++) {
      const bo = k * N;
      let s = 0;
      for (let n = 0; n < N; n++) s += dY[yo + n] * B[bo + n];
      C[co + k] += s;
    }
  }
}
// dW[K,N] += X[M,K]^T @ dY[M,N]
function matmulTN(X, dY, M, K, N, dW) {
  for (let m = 0; m < M; m++) {
    const xo = m * K, yo = m * N;
    for (let k = 0; k < K; k++) {
      const x = X[xo + k];
      if (x === 0) continue;
      const wo = k * N;
      for (let n = 0; n < N; n++) dW[wo + n] += x * dY[yo + n];
    }
  }
}

const GC = Math.sqrt(2 / Math.PI);
function gelu(x) { return 0.5 * x * (1 + Math.tanh(GC * (x + 0.044715 * x * x * x))); }
function dgelu(x) {
  const inner = GC * (x + 0.044715 * x * x * x);
  const t = Math.tanh(inner);
  const dt = (1 - t * t) * GC * (1 + 3 * 0.044715 * x * x);
  return 0.5 * (1 + t) + 0.5 * x * dt;
}

// ---------- model ----------
function makeModel(cfg) {
  const { V, C, L, H, F, B } = cfg;
  const p = {};
  p.wte = normal(V * C, 0.02);
  p.wpe = normal(B * C, 0.02);
  p.layers = [];
  for (let l = 0; l < L; l++) {
    p.layers.push({
      ln1g: ones(C), ln1b: zeros(C),
      wqkv: normal(C * 3 * C, 0.02), bqkv: zeros(3 * C),
      wo: normal(C * C, 0.02 / Math.sqrt(2 * L)), bo: zeros(C),
      ln2g: ones(C), ln2b: zeros(C),
      w1: normal(C * F, 0.02), b1: zeros(F),
      w2: normal(F * C, 0.02 / Math.sqrt(2 * L)), b2: zeros(C),
    });
  }
  p.lnfg = ones(C); p.lnfb = zeros(C);
  return { cfg, p };
}

function paramList(model) {
  const out = [];
  const p = model.p;
  out.push(['wte', p.wte], ['wpe', p.wpe]);
  p.layers.forEach((L, i) => {
    for (const k of ['ln1g', 'ln1b', 'wqkv', 'bqkv', 'wo', 'bo', 'ln2g', 'ln2b', 'w1', 'b1', 'w2', 'b2']) {
      out.push([`layers.${i}.${k}`, L[k]]);
    }
  });
  out.push(['lnfg', model.p.lnfg], ['lnfb', model.p.lnfb]);
  return out;
}

function makeGrads(model) {
  const g = {};
  for (const [name, arr] of paramList(model)) g[name] = new Float32Array(arr.length);
  return g;
}

function layernormFwd(x, g, b, T, C, out, mean, rstd) {
  for (let t = 0; t < T; t++) {
    const o = t * C;
    let m = 0;
    for (let c = 0; c < C; c++) m += x[o + c];
    m /= C;
    let v = 0;
    for (let c = 0; c < C; c++) { const d = x[o + c] - m; v += d * d; }
    v /= C;
    const rs = 1 / Math.sqrt(v + 1e-5);
    mean[t] = m; rstd[t] = rs;
    for (let c = 0; c < C; c++) out[o + c] = (x[o + c] - m) * rs * g[c] + b[c];
  }
}
function layernormBwd(dout, x, g, mean, rstd, T, C, dx, dg, db) {
  for (let t = 0; t < T; t++) {
    const o = t * C, m = mean[t], rs = rstd[t];
    let dnormMean = 0, dnormXMean = 0;
    for (let c = 0; c < C; c++) {
      const norm = (x[o + c] - m) * rs;
      const dn = dout[o + c] * g[c];
      dnormMean += dn;
      dnormXMean += dn * norm;
    }
    dnormMean /= C; dnormXMean /= C;
    for (let c = 0; c < C; c++) {
      const norm = (x[o + c] - m) * rs;
      const dn = dout[o + c] * g[c];
      dg[c] += dout[o + c] * norm;
      db[c] += dout[o + c];
      dx[o + c] += (dn - dnormMean - norm * dnormXMean) * rs;
    }
  }
}

// forward one sequence; returns cache. capture=true keeps everything for viz.
function forward(model, tokens, cache) {
  const { C, L, H, F } = model.cfg;
  const hd = C / H;
  const T = tokens.length;
  const p = model.p;
  const c = cache || {};
  c.T = T; c.tokens = tokens;
  const alloc = (k, n) => { if (!c[k] || c[k].length !== n) c[k] = new Float32Array(n); return c[k]; };

  const emb = alloc('emb', T * C);
  const tokv = alloc('tokv', T * C);
  const posv = alloc('posv', T * C);
  for (let t = 0; t < T; t++) {
    const to = tokens[t] * C, po = t * C;
    for (let ch = 0; ch < C; ch++) {
      tokv[po + ch] = p.wte[to + ch];
      posv[po + ch] = p.wpe[po + ch];
      emb[po + ch] = p.wte[to + ch] + p.wpe[po + ch];
    }
  }

  c.blocks = c.blocks || [];
  let x = emb;
  for (let l = 0; l < L; l++) {
    const P = p.layers[l];
    const b = c.blocks[l] || (c.blocks[l] = {});
    const ba = (k, n) => { if (!b[k] || b[k].length !== n) b[k] = new Float32Array(n); return b[k]; };
    b.x = x;
    const ln1 = ba('ln1', T * C), mean1 = ba('mean1', T), rstd1 = ba('rstd1', T);
    layernormFwd(x, P.ln1g, P.ln1b, T, C, ln1, mean1, rstd1);
    const qkv = ba('qkv', T * 3 * C);
    matmul(ln1, P.wqkv, T, C, 3 * C, qkv);
    for (let t = 0; t < T; t++) for (let j = 0; j < 3 * C; j++) qkv[t * 3 * C + j] += P.bqkv[j];

    const att = ba('att', H * T * T);      // softmax probs
    const scores = ba('scores', H * T * T); // pre-softmax
    const ao = ba('attout', T * C);
    const scale = 1 / Math.sqrt(hd);
    for (let h = 0; h < H; h++) {
      const qoff = h * hd, koff = C + h * hd, voff = 2 * C + h * hd;
      for (let t = 0; t < T; t++) {
        const so = h * T * T + t * T;
        let mx = -Infinity;
        for (let s = 0; s <= t; s++) {
          let dot = 0;
          for (let d = 0; d < hd; d++) dot += qkv[t * 3 * C + qoff + d] * qkv[s * 3 * C + koff + d];
          dot *= scale;
          scores[so + s] = dot;
          if (dot > mx) mx = dot;
        }
        for (let s = t + 1; s < T; s++) { scores[so + s] = 0; att[so + s] = 0; }
        let sum = 0;
        for (let s = 0; s <= t; s++) { const e = Math.exp(scores[so + s] - mx); att[so + s] = e; sum += e; }
        for (let s = 0; s <= t; s++) att[so + s] /= sum;
        for (let d = 0; d < hd; d++) {
          let acc = 0;
          for (let s = 0; s <= t; s++) acc += att[so + s] * qkv[s * 3 * C + voff + d];
          ao[t * C + h * hd + d] = acc;
        }
      }
    }
    const proj = ba('proj', T * C);
    matmul(ao, P.wo, T, C, C, proj);
    const res1 = ba('res1', T * C);
    for (let t = 0; t < T; t++) for (let ch = 0; ch < C; ch++) res1[t * C + ch] = x[t * C + ch] + proj[t * C + ch] + P.bo[ch];

    const ln2 = ba('ln2', T * C), mean2 = ba('mean2', T), rstd2 = ba('rstd2', T);
    layernormFwd(res1, P.ln2g, P.ln2b, T, C, ln2, mean2, rstd2);
    const fc = ba('fc', T * F);
    matmul(ln2, P.w1, T, C, F, fc);
    const act = ba('act', T * F);
    for (let t = 0; t < T; t++) for (let f = 0; f < F; f++) { const v = fc[t * F + f] + P.b1[f]; fc[t * F + f] = v; act[t * F + f] = gelu(v); }
    const fo = ba('fo', T * C);
    matmul(act, P.w2, T, F, C, fo);
    const res2 = ba('res2', T * C);
    for (let t = 0; t < T; t++) for (let ch = 0; ch < C; ch++) res2[t * C + ch] = res1[t * C + ch] + fo[t * C + ch] + P.b2[ch];
    x = res2;
  }
  const lnf = alloc('lnf', T * C), meanf = alloc('meanf', T), rstdf = alloc('rstdf', T);
  c.xfinal = x;
  layernormFwd(x, p.lnfg, p.lnfb, T, C, lnf, meanf, rstdf);
  const V = model.cfg.V;
  const logits = alloc('logits', T * V);
  // logits = lnf @ wte^T
  for (let t = 0; t < T; t++) {
    const lo = t * C, go = t * V;
    for (let v = 0; v < V; v++) {
      let s = 0; const wo = v * C;
      for (let ch = 0; ch < C; ch++) s += lnf[lo + ch] * p.wte[wo + ch];
      logits[go + v] = s;
    }
  }
  return c;
}

function crossEntropyAndDLogits(model, c, targets, dlogits) {
  const V = model.cfg.V, T = c.T;
  let loss = 0;
  for (let t = 0; t < T; t++) {
    const o = t * V;
    let mx = -Infinity;
    for (let v = 0; v < V; v++) if (c.logits[o + v] > mx) mx = c.logits[o + v];
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(c.logits[o + v] - mx);
    const lse = mx + Math.log(sum);
    loss += lse - c.logits[o + targets[t]];
    for (let v = 0; v < V; v++) dlogits[o + v] = Math.exp(c.logits[o + v] - lse) / T;
    dlogits[o + targets[t]] -= 1 / T;
  }
  return loss / T;
}

function backward(model, c, dlogits, g) {
  const { C, L, H, F, V } = model.cfg;
  const hd = C / H;
  const T = c.T, p = model.p;
  const scratch = backward.scratch || (backward.scratch = {});
  const sa = (k, n) => { if (!scratch[k] || scratch[k].length !== n) scratch[k] = new Float32Array(n); scratch[k].fill(0); return scratch[k]; };

  const dlnf = sa('dlnf', T * C);
  // logits = lnf @ wte^T  ->  dlnf = dlogits @ wte ; dwte += dlogits^T @ lnf
  for (let t = 0; t < T; t++) {
    const go = t * V, lo = t * C;
    for (let v = 0; v < V; v++) {
      const d = dlogits[go + v];
      if (d === 0) continue;
      const wo = v * C;
      for (let ch = 0; ch < C; ch++) {
        dlnf[lo + ch] += d * p.wte[wo + ch];
        g.wte[wo + ch] += d * c.lnf[lo + ch];
      }
    }
  }
  let dx = sa('dxf', T * C);
  layernormBwd(dlnf, c.xfinal, p.lnfg, c.meanf, c.rstdf, T, C, dx, g.lnfg, g.lnfb);

  for (let l = L - 1; l >= 0; l--) {
    const P = p.layers[l], b = c.blocks[l];
    const gl = (k) => g[`layers.${l}.${k}`];
    const dres2 = dx;
    // res2 = res1 + fo + b2
    const dfo = sa(`dfo${l}`, T * C);
    for (let t = 0; t < T; t++) for (let ch = 0; ch < C; ch++) { dfo[t * C + ch] = dres2[t * C + ch]; gl('b2')[ch] += dres2[t * C + ch]; }
    const dact = sa(`dact${l}`, T * F);
    matmulNT(dfo, P.w2, T, F, C, dact);
    matmulTN(b.act, dfo, T, F, C, gl('w2'));
    const dfc = sa(`dfc${l}`, T * F);
    for (let t = 0; t < T; t++) for (let f = 0; f < F; f++) { const d = dact[t * F + f] * dgelu(b.fc[t * F + f]); dfc[t * F + f] = d; gl('b1')[f] += d; }
    const dln2 = sa(`dln2${l}`, T * C);
    matmulNT(dfc, P.w1, T, C, F, dln2);
    matmulTN(b.ln2, dfc, T, C, F, gl('w1'));
    const dres1 = sa(`dres1${l}`, T * C);
    for (let i = 0; i < T * C; i++) dres1[i] = dres2[i];
    layernormBwd(dln2, b.res1, P.ln2g, b.mean2, b.rstd2, T, C, dres1, gl('ln2g'), gl('ln2b'));

    // res1 = x + proj + bo
    const dproj = sa(`dproj${l}`, T * C);
    for (let t = 0; t < T; t++) for (let ch = 0; ch < C; ch++) { dproj[t * C + ch] = dres1[t * C + ch]; gl('bo')[ch] += dres1[t * C + ch]; }
    const dao = sa(`dao${l}`, T * C);
    matmulNT(dproj, P.wo, T, C, C, dao);
    matmulTN(b.attout, dproj, T, C, C, gl('wo'));

    const dqkv = sa(`dqkv${l}`, T * 3 * C);
    const scale = 1 / Math.sqrt(hd);
    for (let h = 0; h < H; h++) {
      const qoff = h * hd, koff = C + h * hd, voff = 2 * C + h * hd;
      for (let t = 0; t < T; t++) {
        const so = h * T * T + t * T;
        // dV and dP
        const dp = sa(`dp${l}_${h}`, T);
        for (let s = 0; s <= t; s++) {
          let acc = 0;
          for (let d = 0; d < hd; d++) {
            acc += dao[t * C + h * hd + d] * b.qkv[s * 3 * C + voff + d];
            dqkv[s * 3 * C + voff + d] += b.att[so + s] * dao[t * C + h * hd + d];
          }
          dp[s] = acc;
        }
        // softmax backward
        let dot = 0;
        for (let s = 0; s <= t; s++) dot += dp[s] * b.att[so + s];
        for (let s = 0; s <= t; s++) {
          const ds = b.att[so + s] * (dp[s] - dot) * scale;
          for (let d = 0; d < hd; d++) {
            dqkv[t * 3 * C + qoff + d] += ds * b.qkv[s * 3 * C + koff + d];
            dqkv[s * 3 * C + koff + d] += ds * b.qkv[t * 3 * C + qoff + d];
          }
        }
      }
    }
    for (let t = 0; t < T; t++) for (let j = 0; j < 3 * C; j++) gl('bqkv')[j] += dqkv[t * 3 * C + j];
    const dln1 = sa(`dln1${l}`, T * C);
    matmulNT(dqkv, P.wqkv, T, C, 3 * C, dln1);
    matmulTN(b.ln1, dqkv, T, C, 3 * C, gl('wqkv'));

    const dxin = sa(`dxin${l}`, T * C);
    for (let i = 0; i < T * C; i++) dxin[i] = dres1[i];
    layernormBwd(dln1, b.x, P.ln1g, b.mean1, b.rstd1, T, C, dxin, gl('ln1g'), gl('ln1b'));
    dx = dxin;
  }
  // embeddings
  for (let t = 0; t < T; t++) {
    const to = c.tokens[t] * C, po = t * C;
    for (let ch = 0; ch < C; ch++) { g.wte[to + ch] += dx[po + ch]; g.wpe[po + ch] += dx[po + ch]; }
  }
}

module.exports = { makeModel, forward, backward, crossEntropyAndDLogits, paramList, makeGrads, rand, matmul };

// ---------- gradient check ----------
if (require.main === module && process.argv[2] === 'gradcheck') {
  const cfg = { V: 11, C: 8, L: 2, H: 2, F: 10, B: 6 };
  const model = makeModel(cfg);
  const T = 5;
  const toks = [1, 3, 5, 2, 7], tgts = [3, 5, 2, 7, 4];
  const g = makeGrads(model);
  const c = forward(model, toks, {});
  const dl = new Float32Array(T * cfg.V);
  const loss = crossEntropyAndDLogits(model, c, tgts, dl);
  backward(model, c, dl, g);
  const names = paramList(model);
  let worst = 0;
  for (const [name, arr] of names) {
    for (let trial = 0; trial < 3; trial++) {
      const i = Math.floor(rand() * arr.length);
      const eps = 1e-3;
      const orig = arr[i];
      arr[i] = orig + eps;
      let cc = forward(model, toks, {});
      const d2 = new Float32Array(T * cfg.V);
      const lp = crossEntropyAndDLogits(model, cc, tgts, d2);
      arr[i] = orig - eps;
      cc = forward(model, toks, {});
      const lm = crossEntropyAndDLogits(model, cc, tgts, d2);
      arr[i] = orig;
      const num = (lp - lm) / (2 * eps);
      const ana = g[name][i];
      const rel = Math.abs(num - ana) / Math.max(1e-6, Math.abs(num) + Math.abs(ana));
      if (rel > worst) worst = rel;
      if (rel > 2e-2) console.log('BAD', name, i, 'num', num.toFixed(6), 'ana', ana.toFixed(6), 'rel', rel.toFixed(4));
    }
  }
  console.log('loss', loss.toFixed(4), 'worst rel err', worst.toExponential(2));
}
