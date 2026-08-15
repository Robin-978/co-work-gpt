'use strict';
// 摸清一份陌生 CSV 的結構——在你自己的機器上跑，資料不用外流。
//
// 接一套沒看過的 MES／機台匯出時，第一件事不是寫解析器，而是**先知道裡面長什麼樣**。
// 憑檔名或憑經驗猜欄位，猜錯會安靜地讀錯數字，那比讀不到更糟。
//
//   node inspect.js 機台log.csv                      看結構
//   node inspect.js 機台log.csv 量測.csv --join       找兩個檔的關聯鍵
//   node inspect.js 機台log.csv --name               解析檔名的欄位結構
//   node inspect.js 機台log.csv --redact -o 樣本.csv  產生可外流的去識別化樣本
//
// --redact 做的事：字串識別碼換成 A0001 這種代號、日期整批平移一個固定天數、
// 欄位名稱保留（結構才看得懂）。加 --redact-numbers 連數值也換成同分布的合成值。

const fs = require('fs');
const path = require('path');
const { decodeWithInfo, parseDelimited, parseDate } = require('./epi_data.js');

// ─────────────────────────────────────────────────────────────
// 欄位剖析
// ─────────────────────────────────────────────────────────────

const isNumLike = (s) => s !== '' && s != null && isFinite(Number(String(s).replace(/,/g, '')));

function profileColumn(name, vals, total) {
  const nonEmpty = vals.filter((v) => v != null && String(v).trim() !== '');
  const uniq = new Set(nonEmpty);
  const nums = nonEmpty.filter(isNumLike).map((v) => Number(String(v).replace(/,/g, '')));
  const dates = nonEmpty.filter((v) => parseDate(v));

  // 階層標籤（1.3.1、163.7.7）裡有一大半長得像數字，光看比例會被騙過去，
  // 只要出現一個兩點以上的值就足以判定整欄是標籤而不是量。
  const versionLike = nonEmpty.some((v) => /^\d+(\.\d+){2,}$/.test(String(v).trim()));

  let type = 'text';
  if (versionLike) type = 'label';
  else if (nonEmpty.length && dates.length >= nonEmpty.length * 0.8) type = 'date';
  else if (nonEmpty.length && nums.length >= nonEmpty.length * 0.8) type = 'number';

  const c = {
    name, type,
    fill: total ? nonEmpty.length / total : 0,
    unique: uniq.size,
    uniqueRatio: nonEmpty.length ? uniq.size / nonEmpty.length : 0,
    samples: [...uniq].slice(0, 4),
  };
  if (type === 'number' && nums.length) {
    c.min = Math.min(...nums); c.max = Math.max(...nums);
    c.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    // 整數且遞增又幾乎不重複 → 多半是流水號而不是量測值
    c.looksLikeSerial = nums.every((n) => Number.isInteger(n)) && c.uniqueRatio > 0.95;
  }
  if (type === 'date') {
    const ds = dates.map((v) => parseDate(v)).sort((a, b) => a - b);
    c.from = ds[0]; c.to = ds[ds.length - 1];
  }
  // 角色推測——是推測，不是判定，所以叫 guess
  if (type === 'label') c.guess = `階層標籤（像 ${c.samples.find((s) => /\d\.\d+\.\d/.test(String(s))) || '1.3.1'}，不是數值）`;
  else if (type === 'text' && c.uniqueRatio > 0.9 && c.fill > 0.9) c.guess = '識別碼（每列幾乎都不同）';
  else if (type === 'text' && c.unique <= 30 && c.unique > 1) c.guess = `分組欄位（只有 ${c.unique} 種值）`;
  else if (type === 'date') c.guess = '時間';
  else if (c.looksLikeSerial) c.guess = '流水號（整數且幾乎不重複，不像量測值）';
  else if (type === 'number') c.guess = '量測值';
  else if (c.unique === 1) c.guess = '常數（整欄同一個值）';
  return c;
}

// 有些機台匯出在表頭前面還有前置行（實測看過空行、以及只有一個 "#" 的行）。
// 空行會被 parseDelimited 濾掉，但 "#" 不會，直接拿第 0 列當表頭就會抓錯整個檔。
// 資料列與表頭的欄數一致，前置行通常只有一兩欄——用這點把它們切掉。
function dropPreamble(rows) {
  if (rows.length < 2) return { rows, dropped: 0 };
  const counts = rows.slice(0, 20).map((r) => r.length);
  const tally = new Map();
  for (const c of counts) tally.set(c, (tally.get(c) || 0) + 1);
  const mode = [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  let i = 0;
  while (i < rows.length - 1 && rows[i].length < mode) i++;
  return { rows: rows.slice(i), dropped: i };
}

function profile(file) {
  const buf = fs.readFileSync(file);
  const { text, encoding } = decodeWithInfo(buf);
  const firstLine = text.split('\n')[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? 'Tab' : '逗號';
  const all = parseDelimited(text);
  const { rows, dropped: preamble } = dropPreamble(all);
  if (rows.length < 2) throw new Error(`${file}：只有 ${rows.length} 列，沒有資料`);

  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1);
  const columns = header.map((h, i) => profileColumn(h, body.map((r) => r[i]), body.length));
  return { file, encoding, delim, bytes: buf.length, header, body, columns, rowCount: body.length, preamble };
}

// ─────────────────────────────────────────────────────────────
// 報告
// ─────────────────────────────────────────────────────────────

const pad = (s, n) => {
  // 中日韓字元佔兩個位寬，不補償的話表格會歪
  const w = (t) => Array.from(String(t)).reduce((a, c) => a + (/[⺀-鿿＀-｠]/.test(c) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w(s)));
};
const fmt = (x) => (typeof x === 'number' ? (Number.isInteger(x) ? x : +x.toFixed(4)) : x);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

function report(p) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`檔案：${path.basename(p.file)}`);
  console.log(`編碼：${p.encoding}　分隔：${p.delim}　大小：${(p.bytes / 1024).toFixed(1)} KB`);
  console.log(`${p.rowCount.toLocaleString()} 列資料　${p.columns.length} 個欄位` + (p.preamble ? `　（表頭前有 ${p.preamble} 行前置內容，已略過）` : ''));
  console.log('─'.repeat(72));
  console.log(pad('欄位', 26) + pad('型別', 8) + pad('填充', 7) + pad('相異', 8) + '推測用途');
  console.log('─'.repeat(72));
  for (const c of p.columns) {
    console.log(
      pad(c.name.slice(0, 24), 26) +
      pad(c.type, 8) +
      pad((c.fill * 100).toFixed(0) + '%', 7) +
      pad(c.unique, 8) +
      (c.guess || '')
    );
  }
  console.log('─'.repeat(72));
  console.log('各欄的實際樣子：');
  for (const c of p.columns) {
    let extra = '';
    if (c.type === 'number' && c.min != null) extra = `　範圍 ${fmt(c.min)} ~ ${fmt(c.max)}　平均 ${fmt(c.mean)}`;
    if (c.type === 'date' && c.from) extra = `　${day(c.from)} ~ ${day(c.to)}`;
    console.log(`  ${pad(c.name.slice(0, 24), 26)} ${c.samples.map((s) => JSON.stringify(String(s).slice(0, 18))).join(' ')}${extra}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 兩個檔怎麼接起來
// ─────────────────────────────────────────────────────────────
// 機台 log 和量測資料一定要能對上同一爐，否則兩邊都只是孤立的數字。
// 這裡不猜，直接算「哪兩個欄位的值重疊最多」。

function joinCandidates(a, b) {
  const setOf = (p, i) => new Set(p.body.map((r) => (r[i] == null ? '' : String(r[i]).trim())).filter(Boolean));
  const out = [];
  a.columns.forEach((ca, i) => {
    const sa = setOf(a, i);
    if (sa.size < 2) return;
    b.columns.forEach((cb, j) => {
      const sb = setOf(b, j);
      if (sb.size < 2) return;
      let hit = 0;
      for (const v of sa) if (sb.has(v)) hit++;
      if (!hit) return;
      out.push({
        left: ca.name, right: cb.name, hit,
        coverLeft: hit / sa.size, coverRight: hit / sb.size,
        leftUnique: sa.size, rightUnique: sb.size,
        sample: [...sa].find((v) => sb.has(v)),
      });
    });
  });
  return out.sort((x, y) => (y.coverLeft + y.coverRight) - (x.coverLeft + x.coverRight)).slice(0, 12);
}

function reportJoin(a, b) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`關聯鍵候選：${path.basename(a.file)}  ×  ${path.basename(b.file)}`);
  console.log('─'.repeat(72));
  const cands = joinCandidates(a, b);
  if (!cands.length) {
    console.log('兩個檔沒有任何欄位的值重疊。');
    console.log('可能是：關聯鍵藏在檔名裡（用 --name 看）、需要先做格式正規化');
    console.log('（例如一邊有前導零、一邊沒有），或這兩個檔本來就不該直接對。');
    return;
  }
  console.log(pad('左檔欄位', 24) + pad('右檔欄位', 24) + pad('左涵蓋', 9) + pad('右涵蓋', 9) + '範例值');
  for (const c of cands) {
    console.log(
      pad(c.left.slice(0, 22), 24) + pad(c.right.slice(0, 22), 24) +
      pad((c.coverLeft * 100).toFixed(0) + '%', 9) +
      pad((c.coverRight * 100).toFixed(0) + '%', 9) +
      JSON.stringify(String(c.sample).slice(0, 20))
    );
  }
  console.log('\n兩邊涵蓋率都高＝可以直接當關聯鍵；只有一邊高＝多對一（例如一爐多片）。');
}

// ─────────────────────────────────────────────────────────────
// 檔名結構
// ─────────────────────────────────────────────────────────────
// 機台匯出常把爐號、機台、產品、時間全塞進檔名。這裡只把它切開並描述，
// 不替你決定哪一段是什麼——那要你對著實機確認。

function describeSegment(s) {
  const notes = [];
  if (/^\d+$/.test(s)) {
    notes.push(`純數字 ${s.length} 位`);
    if (s.length === 8) notes.push('長度像 YYYYMMDD 或 MMDDHHmm');
    if (s.length === 6) notes.push('長度像 YYMMDD 或 HHmmss');
  } else if (/^[A-Za-z]+$/.test(s)) notes.push('純英文');
  else if (/^[A-Za-z]+\d+$/.test(s)) {
    const m = s.match(/^([A-Za-z]+)(\d+)$/);
    notes.push(`英文前綴「${m[1]}」＋ ${m[2].length} 位數字`);
  } else notes.push('英數混合');
  return notes.join('，');
}

function reportName(file) {
  const base = path.basename(file, path.extname(file));
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`檔名結構：${base}`);
  console.log('─'.repeat(72));
  // 先用 . 切大段，再用 _ 切小段——這兩個是最常見的分隔符
  base.split('.').forEach((chunk, ci, arr) => {
    const label = arr.length > 1 ? `第 ${ci + 1} 段（以 . 分隔）` : '整串';
    console.log(`${label}：${chunk}`);
    const parts = chunk.split('_');
    parts.forEach((p2, i) => {
      console.log(`   ${parts.length > 1 ? `[${i}] ` : '    '}${pad(p2, 22)} ${describeSegment(p2)}`);
    });
  });
  console.log('\n這只是把字串切開並描述，沒有替你認定哪一段是機台、哪一段是爐號。');
  console.log('拿幾個不同的檔名一起看，會變的那幾段才是變數，不變的是常數。');
}

// ─────────────────────────────────────────────────────────────
// 去識別化樣本
// ─────────────────────────────────────────────────────────────
// 資料不能出廠，但「結構」可以。這裡把值換掉、把欄位留著。

function redact(p, opt) {
  const n = opt.sample || 20;
  const rows = p.body.slice(0, n);
  const maps = p.columns.map(() => new Map());
  // 日期整批平移同一個天數，這樣先後順序與間隔都還在，但對不回真實日期
  const shiftDays = opt.dateShift == null ? 137 : opt.dateShift;

  const out = [p.header.join(',')];
  for (const r of rows) {
    const cells = p.columns.map((c, i) => {
      const raw = r[i] == null ? '' : String(r[i]).trim();
      if (raw === '') return '';
      if (c.type === 'date') {
        const d = parseDate(raw);
        if (!d) return raw;
        return new Date(d.getTime() - shiftDays * 86400000).toISOString().slice(0, 16).replace('T', ' ');
      }
      if (c.type === 'number') {
        if (!opt.redactNumbers) return raw;
        // 保留量級與小數位數，只把數字本身換掉
        const v = Number(raw.replace(/,/g, ''));
        const dec = (raw.split('.')[1] || '').length;
        return (v * (0.9 + ((i * 37 + raw.length * 11) % 20) / 100)).toFixed(dec);
      }
      // 文字：同樣的原值一律對到同樣的代號，欄位間的關聯才不會被破壞
      const m = maps[i];
      if (!m.has(raw)) m.set(raw, `${String.fromCharCode(65 + (i % 26))}${String(m.size + 1).padStart(4, '0')}`);
      return m.get(raw);
    });
    out.push(cells.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','));
  }
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
module.exports = { profile, joinCandidates, redact, describeSegment };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const files = argv.filter((a, i) => !a.startsWith('--') && !['-o'].includes(argv[i - 1]) &&
                                      !['--sample', '--date-shift'].includes(argv[i - 1]));

  if (!files.length) {
    console.log(`用法：node inspect.js <檔案...> [選項]

  --join                  兩個以上檔案時，找出可以當關聯鍵的欄位
  --name                  解析檔名的欄位結構
  --redact                產生去識別化樣本（文字換代號、日期平移）
  --redact-numbers        連數值也換掉（量級與小數位數保留）
  --sample <n>            樣本列數，預設 20
  --date-shift <天>       日期平移天數，預設 137
  -o <檔名>               樣本輸出到檔案

資料不會離開這台機器。--redact 產生的樣本才是可以外流的東西。`);
    process.exit(0);
  }

  const profiles = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`找不到檔案：${f}`); process.exit(1); }
    try { profiles.push(profile(f)); }
    catch (e) { console.error(`讀取失敗 ${f}：${e.message}`); process.exit(1); }
  }

  if (flag('--name')) for (const f of files) reportName(f);
  for (const p of profiles) report(p);

  if (flag('--join')) {
    if (profiles.length < 2) console.log('\n--join 需要兩個以上的檔案。');
    else for (let i = 1; i < profiles.length; i++) reportJoin(profiles[0], profiles[i]);
  }

  if (flag('--redact')) {
    const opt = {
      sample: parseInt(val('--sample', '20'), 10),
      dateShift: parseInt(val('--date-shift', '137'), 10),
      redactNumbers: flag('--redact-numbers'),
    };
    for (const p of profiles) {
      const txt = redact(p, opt);
      const out = files.length === 1 && val('-o', '')
        ? val('-o', '')
        : path.join(path.dirname(p.file), path.basename(p.file, path.extname(p.file)) + '.sample.csv');
      fs.writeFileSync(out, '﻿' + txt);   // 加 BOM，Excel 開起來才不會亂碼
      console.log(`\n已寫出去識別化樣本：${out}（${opt.sample} 列）`);
    }
    console.log(`\n樣本裡：文字已換成代號、日期已平移 ${val('--date-shift', '137')} 天` +
      (flag('--redact-numbers') ? '、數值已替換' : '、**數值保持原樣**（要一併遮掉請加 --redact-numbers）') + '。');
    console.log('送出前請自己開起來確認一遍——這支程式不知道你們的機密界線在哪。');
  }
}
