'use strict';
// 上下文到底用到幾個字？
//
// 把 B 從 48 拉到 128 這件事本身不會讓模型變好——只有當語料裡真的存在跨過 48 個
// token 的依賴，多出來的視窗才有東西可看。這支程式直接量：對段落裡每一個位置
// >= 48 的字，分別用「完整前綴」和「只留最後 N 個字」去預測，比較 NLL。
//
// 掃一整排 N（而不是只比 48 對 128）是刻意的：只比一組的話，看到「沒有差別」
// 沒辦法分辨是「遠處的字真的沒用」還是「這支程式量錯了」。短的 N 一定要看得出
// 明顯的劣化，這個量法才可信——那是這個實驗的對照組。
//
//   node ctx_test.js
const { CFG, VOCAB, stoi, fwd } = require('./probe.js');
const { PARAGRAPHS } = require('./corpus.js');

const FROM = 48;                         // 從這個位置開始評分（舊模型的上下文長度）
const TRUNCS = [4, 8, 16, 24, 32, 48];   // 截短到幾個 token
const cache = new Map();

function nll(tokens, target) {
  const logits = fwd(tokens);
  let mx = -Infinity;
  for (let i = 0; i < CFG.V; i++) mx = Math.max(mx, logits[i]);
  let sum = 0;
  for (let i = 0; i < CFG.V; i++) sum += Math.exp(logits[i] - mx);
  return -(logits[target] - mx - Math.log(sum));
}

const sums = new Map(TRUNCS.map((n) => [n, 0]));
let sFull = 0, n = 0;
const examples = [];

for (const para of PARAGRAPHS) {
  const tok = Array.from(para.join('\n')).map((c) => stoi.get(c)).filter((x) => x !== undefined);
  for (let t = FROM; t < Math.min(tok.length - 1, CFG.B); t++) {
    const target = tok[t + 1];
    const a = nll(tok.slice(0, t + 1), target);       // 完整前綴（最多 CFG.B）
    sFull += a; n++;
    for (const k of TRUNCS) {
      const b = nll(tok.slice(t + 1 - k, t + 1), target);
      sums.set(k, sums.get(k) + b);
      if (k === FROM && b - a > 2) {
        examples.push({ gain: b - a, ctx: para.join('\n').slice(Math.max(0, t - 18), t + 1), next: VOCAB[target] });
      }
    }
  }
}

const ppl = (s) => Math.exp(s / n);
console.log(`段落裡位置 ${FROM}～${Math.min(CFG.B, 128) - 1} 的字，共 ${n} 格`);
console.log(`\n  可見的前文長度        平均 NLL    困惑度`);
for (const k of TRUNCS) {
  console.log(`  只留最後 ${String(k).padStart(3)} 個 token   ${(sums.get(k) / n).toFixed(4).padStart(8)}  ${ppl(sums.get(k)).toFixed(2).padStart(8)}`);
}
console.log(`  完整前綴（最多 ${CFG.B}）     ${(sFull / n).toFixed(4).padStart(8)}  ${ppl(sFull).toFixed(2).padStart(8)}`);

const short = sums.get(TRUNCS[0]) / n, at48 = sums.get(FROM) / n, full = sFull / n;
console.log(`\n對照組：只留 ${TRUNCS[0]} 個 token 時 NLL 是完整前綴的 ${(short / Math.max(full, 1e-9)).toFixed(0)} 倍——量法對「看不到前文」有反應。`);
if (full < at48 - 1e-4) {
  console.log(`結論：完整前綴比只留 ${FROM} 個好（${full.toFixed(4)} < ${at48.toFixed(4)}），超過 ${FROM} 的部分有被用到。`);
} else {
  console.log(`結論：完整前綴和只留 ${FROM} 個幾乎一樣（${full.toFixed(4)} vs ${at48.toFixed(4)}）。`);
  console.log(`      這個語料被背下來了，${FROM} 個字已經足以認出是哪一段，所以更遠的字沒有額外資訊。`);
}

if (examples.length) {
  console.log('\n遠處的字幫助最大的幾格：');
  examples.sort((a, b) => b.gain - a.gain);
  for (const e of examples.slice(0, 5)) {
    console.log(`  ΔNLL ${e.gain.toFixed(2)}　…${e.ctx.replace(/\n/g, '⏎')} → 「${e.next.replace(/\n/g, '⏎')}」`);
  }
}
