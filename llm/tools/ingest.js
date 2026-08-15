'use strict';
// 把文獻／報告的純文字轉成可以拿來訓練的語料塊。
//
//   node ingest.js 論文資料夾 -o papers.js -n PAPERS
//   node ingest.js a.txt b.md --min 12 --max-len 44
//
// 直接把論文全文丟進去訓練會讓模型變差，因為會帶進幾百個只出現兩三次的字元：
// 字典變大、輸出層變慢，而那些字根本學不到東西，只會變成 Top-K 裡的雜訊。
// 這支程式做的就是那道清洗——重點在最後的「稀有字元反覆剪枝」。

const fs = require('fs');
const path = require('path');

// ---------- 參數 ----------
const argv = process.argv.slice(2);
const opt = { min: 10, maxLen: 44, minLen: 8, out: '', name: 'DOCS', inputs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--min') opt.min = parseInt(argv[++i], 10);
  else if (a === '--max-len') opt.maxLen = parseInt(argv[++i], 10);
  else if (a === '--min-len') opt.minLen = parseInt(argv[++i], 10);
  else if (a === '-o' || a === '--out') opt.out = argv[++i];
  else if (a === '-n' || a === '--name') opt.name = argv[++i];
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else opt.inputs.push(a);
}
function usage() {
  console.log(`用法：node ingest.js <檔案或資料夾...> [選項]

  -o, --out <檔名>     輸出的語料塊檔名（省略就只印報告，不寫檔）
  -n, --name <名稱>    語料塊的變數名稱，預設 DOCS
      --min <次數>     每個字元至少要出現幾次，預設 10（低於就把含它的句子剪掉）
      --max-len <字>   句子上限，預設 44（要留餘裕給 48 的上下文）
      --min-len <字>   句子下限，預設 8

只吃 .txt / .md。PDF 請先轉純文字（見最後的說明）。`);
}
if (!opt.inputs.length) { usage(); process.exit(1); }

// ---------- 收集檔案 ----------
function collect(p, acc) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) collect(path.join(p, f), acc);
  } else if (/\.(txt|md)$/i.test(p)) {
    acc.push(p);
  }
  return acc;
}
const files = [];
for (const p of opt.inputs) {
  if (!fs.existsSync(p)) { console.error(`找不到：${p}`); process.exit(1); }
  collect(p, files);
}
if (!files.length) { console.error('沒有找到任何 .txt / .md'); process.exit(1); }

// ---------- 正規化 ----------
// 全形英數字轉半形，讓 MOCVD、Cpk、600 這些跟既有語料用同一套字元，不會分裂成兩份
const toHalf = (s) => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

function normalize(s) {
  return toHalf(s)
    .replace(/[​﻿ ]/g, ' ')   // 零寬字元、不斷行空白
    .replace(/[""]/g, '「').replace(/['']/g, '」')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 切句 ----------
function sentences(text) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map(normalize)
    .filter(Boolean);
}

// ---------- 逐句過濾 ----------
const CJK = /[一-鿿]/;
const reasons = new Map();
const drop = (why) => { reasons.set(why, (reasons.get(why) || 0) + 1); return false; };

function keepSentence(s) {
  const n = Array.from(s).length;
  if (n < opt.minLen) return drop(`太短（< ${opt.minLen} 字）`);
  if (n > opt.maxLen) return drop(`太長（> ${opt.maxLen} 字，塞不進 48 的上下文）`);
  if (!CJK.test(s)) return drop('沒有中文（純英文或純數字）');
  if (/https?:\/\/|doi:|et al\.|arXiv/i.test(s)) return drop('參考文獻／網址');
  if (/^[\[\(【（]?\s*\d+\s*[\]\)】）\.]/.test(s)) return drop('編號開頭（條列或參考文獻）');
  if (/^(圖|表|Fig|Table|Figure)\s*\.?\s*\d/i.test(s)) return drop('圖表標題');

  const chars = Array.from(s);
  const cjk = chars.filter((c) => CJK.test(c)).length;
  if (cjk / n < 0.45) return drop('中文比例太低（< 45%，多半是公式或英文夾雜）');

  const punct = chars.filter((c) => /[，。、；：！？（）「」\-—–…·]/.test(c)).length;
  if (punct / n > 0.30) return drop('標點過多（多半是表格或殘缺片段）');
  return true;
}

// ---------- 讀入 ----------
let raw = 0;
let kept = [];
for (const f of files) {
  const ss = sentences(fs.readFileSync(f, 'utf8'));
  raw += ss.length;
  kept.push(...ss.filter(keepSentence));
}
// 去重：文獻裡同一句常常在摘要與內文各出現一次
const before = kept.length;
kept = [...new Set(kept)];
if (before - kept.length) reasons.set('重複句', before - kept.length);

// ---------- 稀有字元反覆剪枝 ----------
// 這一段才是重點，而且判斷基準必須是「合併之後」的次數，不是文獻本身的次數。
// 新句子是要併進既有語料的，而 buildCorpus() 會把每句重複 REPEAT 次；
// 「量」在文獻裡只出現 3 次不代表它稀有——既有語料裡它可能已經有幾百次。
// 只有在合併後仍然不到 --min 的字元，才是真正學不起來、該剪掉的。
const REPEAT = 6;
function charCount(list, mul = 1) {
  const m = new Map();
  for (const s of list) for (const c of s) m.set(c, (m.get(c) || 0) + mul);
  return m;
}
let baseCount = new Map();
try {
  const { buildCorpus } = require('./corpus.js');
  for (const c of buildCorpus()) baseCount.set(c, (baseCount.get(c) || 0) + 1);
} catch { /* 單獨使用時沒有 corpus.js，就只看文獻本身 */ }
const haveBase = baseCount.size > 0;

const mergedCount = (list) => {
  const m = charCount(list, REPEAT);
  for (const [c, v] of baseCount) m.set(c, (m.get(c) || 0) + v);
  return m;
};

const docVocab0 = new Set(kept.join(''));   // 剪枝前，文獻用到的字元
const prunedChars = new Set();
let rounds = 0;
for (;;) {
  const cnt = mergedCount(kept);
  const rare = new Set([...cnt].filter(([, v]) => v < opt.min).map(([c]) => c));
  if (!rare.size) break;
  const next = kept.filter((s) => !Array.from(s).some((c) => rare.has(c)));
  if (next.length === kept.length) break;   // 剪不動了（稀有字只在既有語料裡），避免無窮迴圈
  rare.forEach((c) => prunedChars.add(c));
  kept = next;
  rounds++;
  if (!kept.length) break;
}

// ---------- 報告 ----------
const own = charCount(kept);
const chars = [...own.keys()].sort();
const total = kept.reduce((a, s) => a + Array.from(s).length, 0);

console.log(`\n讀了 ${files.length} 個檔，切出 ${raw.toLocaleString()} 句`);
console.log('─'.repeat(58));
console.log('丟掉的句子：');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${why}`);
}
const droppedFromDocs = [...docVocab0].filter((c) => prunedChars.has(c));
console.log(`  ${String(rounds).padStart(6)}  輪稀有字元剪枝，剪掉文獻裡的 ${droppedFromDocs.length} 個字元` +
  (haveBase ? '（以「合併既有語料之後」的次數判斷）' : '（沒有 corpus.js，只看文獻本身）'));
console.log('─'.repeat(58));
console.log(`留下 ${kept.length.toLocaleString()} 句，${total.toLocaleString()} 字，用到 ${chars.length} 個字元`);

if (!kept.length) {
  console.log('\n沒有任何句子活下來。可能是：文獻太短（每個新字都湊不到 ' + opt.min +
    ' 次）、不是中文純文字，或 --min 設太高。');
  process.exit(0);
}

// 真正花錢的是「新字元」，因為每個新字都要多一列詞向量
if (haveBase) {
  const merged = mergedCount(kept);
  const fresh = chars.filter((c) => !baseCount.has(c));
  const V0 = baseCount.size;
  // 只看「這批文獻用到的字元」——既有語料裡本來就冷門的字不是這支程式造成的，也不該由它負責
  const worst = chars.reduce((a, c) => (merged.get(c) < merged.get(a) ? c : a), chars[0]);
  console.log(`文獻用到的字元裡，合併後最冷門的是「${worst}」，出現 ${merged.get(worst)} 次（門檻 ${opt.min}）`);
  console.log(`\n其中 ${fresh.length} 個字元是現有語料沒有的：`);
  if (fresh.length) {
    console.log('  ' + fresh.slice(0, 60).join(' ') + (fresh.length > 60 ? ' …' : ''));
  }
  console.log(`  字典 ${V0} → ${V0 + fresh.length}，詞向量表多 ${(fresh.length * 64).toLocaleString()} 個參數`);
  if (fresh.length > 40) {
    console.log('  ⚠ 新字超過 40 個，續訓（RESUME）多半學不起來，建議從零訓練。');
  }
} else {
  console.log(`每字平均出現 ${(total / chars.length).toFixed(1)} 次`);
}

console.log(`\n${'─'.repeat(56)}`);
console.log('提醒：語料乾淨不等於模型學得會。丟進去訓練之後，一定要用');
console.log('node probe.js 0.9 "你在意的那句的開頭" 看分布，不要只看 loss。');

// ---------- 輸出 ----------
if (opt.out) {
  const body = kept.map((s) => `  ${JSON.stringify(s)},`).join('\n');
  const js = `'use strict';\n// 由 ingest.js 自動產生：${files.length} 個檔案 → ${kept.length} 句、${total} 字\n` +
    `// 每個字元至少出現 ${opt.min} 次（--min ${opt.min}），句長 ${opt.minLen}–${opt.maxLen} 字\n` +
    `const ${opt.name} = [\n${body}\n];\n\nmodule.exports = { ${opt.name} };\n`;
  fs.writeFileSync(opt.out, js);
  console.log(`\n寫出 ${opt.out}`);
  console.log(`接下來在 corpus.js 裡加兩處：`);
  console.log(`  1. 檔案開頭   const { ${opt.name} } = require('./${path.basename(opt.out)}');`);
  console.log(`  2. SENTENCES 的 concat 清單末端加上 ${opt.name}`);
  console.log(`然後 node run_train.js（新字多就從零訓練，字典沒變才用 RESUME=1）`);
}
