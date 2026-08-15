'use strict';
// RAG（檢索增強生成）的最小可執行示範。
//
// 重點：RAG 完全不碰模型的權重。它只做一件事——
//   把「檢索到的資料」接在使用者的問題前面，一起送進同一個模型。
// 所以整支程式分成兩半：外面的檢索是普通的字串比對，裡面的生成還是原本那個 LLM。
//
// 用法：
//   node rag_demo.js                    # 跑內建的三組對照
//   node rag_demo.js "Cpk 的標準是多少"   # 自己問

const { CFG, VOCAB, stoi, show, fwd, probs } = require('./probe.js');

/* ==========================================================
   1. 知識庫：模型「沒有學過」的內容，例如本廠的內規、當月的實際數值
   ========================================================== */
const KNOWLEDGE = [
  '本廠的規定是 Cpk 大於 1.50 代表能力足夠。',
  '本廠的 MOCVD 成長溫度設定在 720 度。',
  '本廠的載盤轉速設定在 1200 轉。',
  '本廠的波長規格是正負 3 奈米以內。',
  '本廠的良率目標是 95%。',
];

/* ==========================================================
   2. 檢索：這裡故意用最笨的字元重疊計分，好讓人看見它只是字串比對
      （真實系統會換成向量相似度，但在整體流程裡的位置一模一樣）
   ========================================================== */
function retrieve(query, k) {
  const q = new Set(Array.from(query));
  const scored = KNOWLEDGE.map((doc) => {
    let hit = 0;
    const seen = new Set();
    for (const ch of doc) {
      if (q.has(ch) && !seen.has(ch)) { hit++; seen.add(ch); }
    }
    // 除以文件長度，避免長文件單純因為字多就贏
    return { doc, score: hit / Math.sqrt(doc.length) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k || 1);
}

/* ==========================================================
   3. 生成：跟平常一模一樣，唯一的差別是 prompt 前面多了檢索到的文字
   ========================================================== */
function encode(text) {
  const bad = Array.from(text).filter((c) => !stoi.has(c));
  if (bad.length) return { err: '字典裡沒有：' + Array.from(new Set(bad)).join(' ') };
  return { toks: Array.from(text).map((c) => stoi.get(c)) };
}

function nextDist(text, temp, topN) {
  const e = encode(text);
  if (e.err) return e;
  const used = e.toks.slice(-CFG.B);              // 超過上下文長度就只留最後 B 個
  const dropped = e.toks.length - used.length;
  const p = probs(fwd(used), temp);
  const top = Array.from(p, (q, i) => [i, q]).sort((a, b) => b[1] - a[1]).slice(0, topN || 5);
  let H = 0;
  for (const q of p) if (q > 1e-12) H -= q * Math.log2(q);
  return { top, H, dropped, len: e.toks.length };
}

function fmtDist(d) {
  if (d.err) return d.err;
  return d.top.map(([i, q]) => `${show(VOCAB[i])} ${(q * 100).toFixed(1)}%`).join('  ') +
    `　| 熵 ${d.H.toFixed(2)} bits`;
}

/* ==========================================================
   4. 對照：同一個問題，有檢索 vs 沒檢索
   ========================================================== */
function compare(question, want, temp) {
  const hits = retrieve(question, 1);
  const ctx = hits[0].doc;
  console.log('─'.repeat(72));
  console.log(`問題：${question}`);
  console.log(`檢索到（score ${hits[0].score.toFixed(2)}）：${ctx}`);
  if (want) console.log(`期待模型接出：「${want}」`);
  console.log('');

  const plain = nextDist(question, temp);
  const rag = nextDist(ctx + '\n' + question, temp);
  console.log(`  沒有檢索　→ ${fmtDist(plain)}`);
  console.log(`  有檢索　　→ ${fmtDist(rag)}`);

  if (want && !plain.err && !rag.err) {
    const idx = stoi.get(want);
    const pOf = (d) => {
      const hit = d.top.find(([i]) => i === idx);
      return hit ? hit[1] : null;
    };
    const a = pOf(plain), b = pOf(rag);
    const f = (x) => (x === null ? '不在前五名' : (x * 100).toFixed(1) + '%');
    console.log(`  「${want}」的機率：${f(a)} → ${f(b)}` +
      (a !== null && b !== null ? `（${b > a ? '↑ 被檢索拉高了' : '↓ 沒有被拉高'}）` : ''));
  }
  if (rag.len > CFG.B) {
    console.log(`  ⚠ prompt 共 ${rag.len} 個 token，超過上下文 ${CFG.B}，前面 ${rag.dropped} 個被截掉了`);
  }
  console.log('');
}

const temp = 1.3;
const argv = process.argv.slice(2);

console.log(`\n模型：${CFG.V} 字典 / ${CFG.L} 層 / 上下文 ${CFG.B} tokens　　溫度 ${temp}`);
console.log('知識庫裡的內容，模型在訓練時「完全沒看過」——只能靠 prompt 讀到。\n');

if (argv.length) {
  for (const q of argv) compare(q, null, temp);
} else {
  compare('Cpk 大於 1.', '5', temp);
  compare('MOCVD 的反應室溫度設定在 ', '7', temp);
  compare('載盤的轉速設定在 1', '2', temp);
}

console.log('─'.repeat(72));
console.log(`
RAG 的三個步驟，對應到上面的三段程式：
  1. 檢索  retrieve()  —— 普通的字串／向量比對，跟模型無關
  2. 組裝  ctx + '\\n' + question  —— 只是字串相接
  3. 生成  fwd()  —— 同一個模型、同一組權重，什麼都沒改

所以 RAG 改的是「模型看到什麼」，不是「模型知道什麼」。不必重訓，
換一份知識庫就換一套答案——這是它最大的優點。

但上面的實測也把它的前提攤開了：這個 128,896 參數的模型
**完全不理會檢索到的內容**，照樣講訓練時背下來的數字。
第一組甚至更明顯：讀到「Cpk 大於 1.50」之後，它反而更確定要接自己
記住的 1.67（6 從 34% 升到 96%）——它有注意到上下文，只是把上下文
當成「這是在講 Cpk」的線索，而不是「這裡有一個我該照抄的數字」。

會照抄上下文的能力叫 in-context learning，它要模型大到一定程度才會浮現。
換句話說：**RAG 不是模型的功能，是模型的一種用法；能不能用，取決於模型
夠不夠大。** 這也是為什麼 RAG 是在 GPT-3 那個級距之後才變成標準做法。
`);
