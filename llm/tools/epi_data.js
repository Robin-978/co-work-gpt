'use strict';
// EPI 生產資料的查詢函式層。
//
// 定位：這一層是「大模型 + RAG」架構裡的第三層——可查詢的資料。
// 文獻走向量檢索，原理計算走 epi_calc.js，而爐次數據走這裡。
//
// 為什麼是參數化函式，不是讓模型自由寫 SQL：
//   1. 函式可以釘在已知答案上做測試，自由生成的 SQL 不行
//   2. 不可能掃全表、不可能查到不該查的欄位、不可能寫入
//   3. 回答時可以附上「用了哪個函式、哪些參數、幾筆資料」——可驗證
// 現場九成的問題就是這裡的十幾種查詢，長尾才需要人工下 SQL。
//
//   node epi_data.js --demo                    產生範例資料並跑一輪查詢
//   node epi_data.js --test                    自我測試
//   node epi_data.js runs.csv --stats 波長     讀檔並統計
//   node epi_data.js runs.csv --cpk 波長 1540 1560
//   node epi_data.js runs.csv --spc 波長

const fs = require('fs');

// ─────────────────────────────────────────────────────────────
// 1. 讀檔與正規化
// ─────────────────────────────────────────────────────────────

// 台灣的 MES／Excel 匯出常常是 Big5 而不是 UTF-8，直接當 UTF-8 讀會整片變亂碼。
// Node 內建的 TextDecoder 支援 big5，不需要額外套件。
function decodeWithInfo(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8 (BOM)' };
  }
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // U+FFFD 是解碼失敗的替代字元；出現得多就代表這根本不是 UTF-8
  const bad = (asUtf8.match(/�/g) || []).length;
  if (bad > asUtf8.length * 0.002) {
    try { return { text: new TextDecoder('big5').decode(buf), encoding: 'big5' }; }
    catch { /* 落回 UTF-8 */ }
  }
  return { text: asUtf8, encoding: 'utf-8' };
}
const decode = (buf) => decodeWithInfo(buf).text;

// 逗號或 Tab 分隔，支援雙引號包住的欄位（Excel 匯出必備）
function parseDelimited(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length >
                (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// 各家 MES 的欄位名稱都不一樣，這裡放常見寫法。
// 標「實測」的是從真實 MES 匯出確認過的欄名，其餘是通用猜測——
// 第一次接資料時請對著真實表頭確認、補上你家系統的寫法。
const COLUMN_ALIASES = {
  runId:   ['RUN_NO',   // 實測（MAT06 engineer 匯出）
            '爐號', '爐次', 'RunID', 'Run ID', 'RunNo', 'Run No', 'LotID', 'Lot ID', '批號'],
  machine: ['REACTOR',  // 實測
            '機台', '機台號', '機台編號', 'Machine', 'Tool', 'ToolID', 'EquipmentID'],
  product: ['Product',  // 實測
            '產品', '產品別', '料號', 'PartNo', 'Part No', 'Device', 'Recipe', 'STRUCTURE'],
  date:    ['G_DATE',   // 實測
            '日期', '時間', '成長日期', 'Date', 'DateTime', 'StartTime', 'Start Time', 'Timestamp'],
  pos:     ['POS_NO',   // 實測：一爐多片時的片號
            '位置', 'Position', 'Slot', 'WaferNo', 'Wafer No'],
};

// 底線與連字號也要去掉，否則 RUN_NO 對不上 RunNo——實測踩過這個坑
function normHeader(h) {
  return String(h).replace(/[\s　_-]/g, '').replace(/[（(].*?[）)]/g, '').toLowerCase();
}

function mapColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.some((a) => normHeader(a) === n)) { map[key] = i; return; }
    }
  });
  return map;
}

function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/\//g, '-');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[5] || 0), +(m[6] || 0)));
}

const isNum = (s) => s !== '' && s != null && isFinite(Number(String(s).replace(/,/g, '')));
const toNum = (s) => Number(String(s).replace(/,/g, ''));

// 把一份檔案讀成 { rows, metrics }。metrics 是「看起來是數值」的欄位名稱。
function loadFile(path) {
  const rows2d = parseDelimited(decode(fs.readFileSync(path)));
  if (rows2d.length < 2) throw new Error(`${path}：沒有資料列（只有表頭或空檔）`);
  const header = rows2d[0].map((h) => h.trim());
  const col = mapColumns(header);
  const body = rows2d.slice(1);

  // 數值欄位：整欄有八成以上能轉成數字才算，避免把「爐號 A123」誤認成數值
  const metrics = [];
  header.forEach((h, i) => {
    if (Object.values(col).includes(i)) return;
    const vals = body.map((r) => r[i]).filter((v) => v != null && v !== '');
    if (vals.length >= Math.max(3, body.length * 0.5) && vals.filter(isNum).length >= vals.length * 0.8) {
      metrics.push(h.trim());
    }
  });

  const rows = body.map((r) => {
    const o = { _file: path, _raw: r };
    for (const [k, i] of Object.entries(col)) o[k] = r[i] == null ? '' : r[i].trim();
    o.date = parseDate(o.date);
    for (const m of metrics) {
      const i = header.indexOf(m);
      o[m] = isNum(r[i]) ? toNum(r[i]) : null;
    }
    return o;
  });
  return { rows, metrics, header, columns: col, path };
}

// 多個檔案合併成一個資料集。MES 匯出常常一個月一個檔，散落的 Excel 也是。
function load(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const parts = list.map(loadFile);
  const rows = parts.flatMap((p) => p.rows);
  const metrics = [...new Set(parts.flatMap((p) => p.metrics))];
  const missing = ['runId', 'machine', 'product', 'date'].filter((k) => !parts.every((p) => k in p.columns));
  return { rows, metrics, files: list.length, missing };
}

// ─────────────────────────────────────────────────────────────
// 2. 篩選
// ─────────────────────────────────────────────────────────────

// filter = { machine, product, from, to, runId }
// machine / product 可以給字串或字串陣列；from / to 吃 'YYYY-MM-DD'
function select(ds, filter = {}) {
  const arr = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)]);
  const mach = arr(filter.machine), prod = arr(filter.product), rid = arr(filter.runId);
  const from = filter.from ? parseDate(filter.from) : null;
  const to = filter.to ? parseDate(filter.to) : null;
  if (filter.from && !from) throw new Error(`from 的日期格式看不懂：${filter.from}（用 YYYY-MM-DD）`);
  if (filter.to && !to) throw new Error(`to 的日期格式看不懂：${filter.to}（用 YYYY-MM-DD）`);
  // 只給日期時，to 要涵蓋當天整天
  const toEnd = to && !/[ T]\d/.test(String(filter.to)) ? new Date(to.getTime() + 86399999) : to;

  return ds.rows.filter((r) => {
    if (mach && !mach.includes(String(r.machine))) return false;
    if (prod && !prod.includes(String(r.product))) return false;
    if (rid && !rid.includes(String(r.runId))) return false;
    if (from && (!r.date || r.date < from)) return false;
    if (toEnd && (!r.date || r.date > toEnd)) return false;
    return true;
  });
}

// 取出某個量測值，順便回報「有幾筆是空的」——空值被默默忽略是很危險的事
function values(rows, metric) {
  const all = rows.map((r) => r[metric]);
  const ok = all.filter((v) => typeof v === 'number' && isFinite(v));
  return { v: ok, missing: all.length - ok.length, total: all.length };
}

function requireMetric(ds, metric) {
  if (!metric) throw new Error(`缺少參數：metric。可用的量測欄位：${ds.metrics.join('、') || '（這份資料沒有數值欄位）'}`);
  if (!ds.metrics.includes(metric)) {
    throw new Error(`找不到量測欄位「${metric}」。可用的是：${ds.metrics.join('、')}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. 統計
// ─────────────────────────────────────────────────────────────

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// 樣本標準差（n-1）。製程能力用的是樣本，不是母體。
function std(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function runStats(ds, filter, metric) {
  requireMetric(ds, metric);
  const rows = select(ds, filter);
  const { v, missing, total } = values(rows, metric);
  if (!v.length) {
    return { ok: false, error: `沒有符合條件的資料（篩到 ${total} 筆爐次，其中 ${metric} 全部是空值）`, n: 0 };
  }
  const s = [...v].sort((a, b) => a - b);
  return {
    ok: true, metric, n: v.length, missing,
    mean: mean(v), std: std(v), min: s[0], max: s[s.length - 1],
    median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75),
    from: rows.reduce((a, r) => (r.date && (!a || r.date < a) ? r.date : a), null),
    to: rows.reduce((a, r) => (r.date && (!a || r.date > a) ? r.date : a), null),
  };
}

// 製程能力。n 太小的 Cpk 沒有意義——這件事一定要說出來，不能默默算給你看。
function cpk(ds, filter, metric, lsl, usl) {
  requireMetric(ds, metric);
  if (lsl == null && usl == null) {
    return { ok: false, error: '缺少參數：lsl 或 usl 至少要給一個。規格界限不能用猜的。' };
  }
  if (lsl != null && usl != null && !(lsl < usl)) {
    return { ok: false, error: `規格界限反了：lsl=${lsl} 必須小於 usl=${usl}` };
  }
  const st = runStats(ds, filter, metric);
  if (!st.ok) return st;
  if (!(st.std > 0)) {
    return { ok: false, error: `${metric} 在這批資料裡完全沒有變異（std=0），Cpk 沒有定義`, n: st.n };
  }
  const cpu = usl != null ? (usl - st.mean) / (3 * st.std) : Infinity;
  const cpl = lsl != null ? (st.mean - lsl) / (3 * st.std) : Infinity;
  const out = {
    ok: true, metric, n: st.n, mean: st.mean, std: st.std, lsl, usl,
    cpu: isFinite(cpu) ? cpu : null,
    cpl: isFinite(cpl) ? cpl : null,
    cpk: Math.min(cpu, cpl),
    cp: (lsl != null && usl != null) ? (usl - lsl) / (6 * st.std) : null,
    warnings: [],
  };
  // 一般實務要求 n ≥ 25～30 才談製程能力；少於這個數字算出來的 Cpk 只是噪音
  if (st.n < 25) out.warnings.push(`只有 ${st.n} 筆資料，n < 25 的 Cpk 不可靠，只能當參考`);
  if (st.missing) out.warnings.push(`有 ${st.missing} 筆爐次的 ${metric} 是空值，已排除`);
  return out;
}

// 依機台／產品／日分組比較，這是「哪一台有問題」最常問的形式
function groupStats(ds, filter, metric, by = 'machine') {
  requireMetric(ds, metric);
  const keyOf = {
    machine: (r) => r.machine || '(未填)',
    product: (r) => r.product || '(未填)',
    day: (r) => (r.date ? r.date.toISOString().slice(0, 10) : '(無日期)'),
    month: (r) => (r.date ? r.date.toISOString().slice(0, 7) : '(無日期)'),
  }[by];
  if (!keyOf) throw new Error(`by 只能是 machine / product / day / month，收到「${by}」`);

  const rows = select(ds, filter);
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!buckets.has(k)) buckets.set(k, []);
    const val = r[metric];
    if (typeof val === 'number' && isFinite(val)) buckets.get(k).push(val);
  }
  const groups = [...buckets].filter(([, v]) => v.length)
    .map(([key, v]) => ({ key, n: v.length, mean: mean(v), std: v.length > 1 ? std(v) : null }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!groups.length) return { ok: false, error: '沒有符合條件的資料', groups: [] };

  const ms = groups.map((g) => g.mean);
  return {
    ok: true, metric, by, groups,
    spread: Math.max(...ms) - Math.min(...ms),   // 組間最大差距，機台差異一眼看出來
  };
}

// 皮爾森相關。用來回答「波長偏移跟成長溫度有沒有關係」這種問題。
function correlate(ds, filter, metricX, metricY) {
  requireMetric(ds, metricX); requireMetric(ds, metricY);
  const rows = select(ds, filter);
  const pairs = rows.map((r) => [r[metricX], r[metricY]])
    .filter(([a, b]) => typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b));
  if (pairs.length < 3) return { ok: false, error: `成對的有效資料只有 ${pairs.length} 筆，算不出相關係數`, n: pairs.length };
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { ok: false, error: '其中一個欄位完全沒有變異，相關係數沒有定義' };
  const r = sxy / Math.sqrt(sxx * syy);
  return {
    ok: true, n: pairs.length, r, r2: r * r,
    slope: sxy / sxx,
    note: '相關不代表因果——這只是說兩個數字一起動，沒說誰造成誰。',
  };
}

// 離群爐次：偏離平均超過 k 倍標準差的，直接把爐號列出來
function outliers(ds, filter, metric, k = 3) {
  requireMetric(ds, metric);
  const st = runStats(ds, filter, metric);
  if (!st.ok) return st;
  if (!(st.std > 0)) return { ok: false, error: `${metric} 沒有變異，找不出離群` };
  const rows = select(ds, filter);
  const hits = rows
    .filter((r) => typeof r[metric] === 'number' && isFinite(r[metric]) &&
                   Math.abs(r[metric] - st.mean) > k * st.std)
    .map((r) => ({
      runId: r.runId, machine: r.machine, product: r.product,
      date: r.date ? r.date.toISOString().slice(0, 10) : null,
      value: r[metric], sigma: (r[metric] - st.mean) / st.std,
    }))
    .sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma));
  return { ok: true, metric, k, mean: st.mean, std: st.std, n: st.n, count: hits.length, runs: hits };
}

// ─────────────────────────────────────────────────────────────
// 4. SPC 判異規則
// ─────────────────────────────────────────────────────────────
// 語料裡教的那幾條（連續七點同側、連續七點上升下降）就是這裡。
// 註：Western Electric 原始規則的第 4 條是連續 8 點、Nelson 是 9 點；
//     國內實務常用 7 點，所以 runLength 預設 7 但可以調。

function spcRules(ds, filter, metric, opt = {}) {
  requireMetric(ds, metric);
  const runLength = opt.runLength || 7;
  const rows = select(ds, filter)
    .filter((r) => typeof r[metric] === 'number' && isFinite(r[metric]))
    .sort((a, b) => (a.date && b.date ? a.date - b.date : 0));
  if (rows.length < runLength) {
    return { ok: false, error: `只有 ${rows.length} 個點，不足以判斷（至少要 ${runLength} 個）`, n: rows.length };
  }
  const v = rows.map((r) => r[metric]);
  const cl = opt.center != null ? opt.center : mean(v);
  const sd = opt.sigma != null ? opt.sigma : std(v);
  if (!(sd > 0)) return { ok: false, error: '標準差為 0，管制圖沒有意義' };

  const label = (i) => rows[i].runId || (rows[i].date ? rows[i].date.toISOString().slice(0, 10) : `#${i + 1}`);
  const z = v.map((x) => (x - cl) / sd);
  const hits = [];

  // 規則 1：單點超出三倍標準差
  z.forEach((zi, i) => {
    if (Math.abs(zi) > 3) hits.push({ rule: 1, desc: '單點超出三倍標準差', at: label(i), index: i, z: zi });
  });
  // 規則 2：連續三點中有兩點落在同側二倍標準差外
  for (let i = 0; i + 2 < z.length; i++) {
    for (const sgn of [1, -1]) {
      const c = [z[i], z[i + 1], z[i + 2]].filter((x) => x * sgn > 2).length;
      if (c >= 2) { hits.push({ rule: 2, desc: '連續三點中有兩點落在同側二倍標準差外', at: label(i), index: i }); break; }
    }
  }
  // 規則 3：連續五點中有四點落在同側一倍標準差外
  for (let i = 0; i + 4 < z.length; i++) {
    for (const sgn of [1, -1]) {
      const c = z.slice(i, i + 5).filter((x) => x * sgn > 1).length;
      if (c >= 4) { hits.push({ rule: 3, desc: '連續五點中有四點落在同側一倍標準差外', at: label(i), index: i }); break; }
    }
  }
  // 規則 4：連續 N 點在中心線同一側 → 製程偏移
  for (let i = 0; i + runLength <= z.length; i++) {
    const w = z.slice(i, i + runLength);
    if (w.every((x) => x > 0) || w.every((x) => x < 0)) {
      hits.push({ rule: 4, desc: `連續 ${runLength} 點在中心線同一側（製程偏移）`, at: label(i), index: i });
    }
  }
  // 規則 5：連續 N 點持續上升或下降 → 趨勢
  for (let i = 0; i + runLength <= v.length; i++) {
    const w = v.slice(i, i + runLength);
    let up = true, down = true;
    for (let j = 1; j < w.length; j++) { if (w[j] <= w[j - 1]) up = false; if (w[j] >= w[j - 1]) down = false; }
    if (up || down) {
      hits.push({ rule: 5, desc: `連續 ${runLength} 點持續${up ? '上升' : '下降'}（趨勢）`, at: label(i), index: i });
    }
  }

  // 同一條規則連續觸發會產生一長串重疊的警報，只留每條規則的第一個起點區段
  const dedup = [];
  for (const h of hits.sort((a, b) => a.rule - b.rule || a.index - b.index)) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.rule === h.rule && h.index - prev.index < runLength) continue;
    dedup.push(h);
  }
  return {
    ok: true, metric, n: v.length, center: cl, sigma: sd,
    ucl: cl + 3 * sd, lcl: cl - 3 * sd,
    runLength, violations: dedup, clean: dedup.length === 0,
  };
}

// 單一爐次的完整資料——追異常一定會用到
function runDetail(ds, runId) {
  if (!runId) return { ok: false, error: '缺少參數：runId' };
  const rows = ds.rows.filter((r) => String(r.runId) === String(runId));
  if (!rows.length) return { ok: false, error: `找不到爐號「${runId}」` };
  return { ok: true, runId, count: rows.length, rows };
}

function listRuns(ds, filter, limit = 50) {
  const rows = select(ds, filter);
  return {
    ok: true, total: rows.length, shown: Math.min(limit, rows.length),
    runs: rows.slice(0, limit).map((r) => ({
      runId: r.runId, machine: r.machine, product: r.product,
      date: r.date ? r.date.toISOString().slice(0, 10) : null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// 5. 範例資料（讓你沒有真實資料也能先跑通流程）
// ─────────────────────────────────────────────────────────────
function demoCsv() {
  // 固定亂數，讓範例每次都一樣、測試可重現
  let seed = 20260804;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const lines = ['爐號,機台,產品,日期,成長溫度,成長壓力,V/III比,厚度,波長,半高寬'];
  const machines = ['MOCVD-01', 'MOCVD-02', 'MOCVD-03'];
  let n = 0;
  for (let d = 0; d < 40; d++) {
    for (const m of machines) {
      for (let k = 0; k < 2; k++) {
        n++;
        const day = new Date(Date.UTC(2026, 5, 1 + d));
        // MOCVD-03 刻意做成偏移 + 隨時間漂移，讓 SPC 規則抓得到東西
        const bias = m === 'MOCVD-03' ? 4 + d * 0.15 : 0;
        const temp = 650 + gauss() * 3;
        const wl = 1550 + bias + gauss() * 3.2 + (temp - 650) * 0.6;
        lines.push([
          `R${String(n).padStart(4, '0')}`, m, 'InGaAsP-1550',
          day.toISOString().slice(0, 10),
          temp.toFixed(1), (100 + gauss() * 2).toFixed(1), (85 + gauss() * 4).toFixed(1),
          (2.0 + gauss() * 0.05).toFixed(3), wl.toFixed(2), (28 + gauss() * 2).toFixed(1),
        ].join(','));
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────
// 6. 自我測試：釘在手算得出來的答案上
// ─────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const near = (name, got, want, tol = 1e-9) => {
    const ok = Math.abs(got - want) <= tol;
    console.log(`  ${ok ? '✓' : '✗'} ${name}：算出 ${typeof got === 'number' ? +got.toFixed(6) : got}，預期 ${want} ±${tol}`);
    ok ? pass++ : fail++;
  };
  const is = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); cond ? pass++ : fail++; };

  // 用一份手寫的小資料集，數字都可以自己驗
  const csv = [
    '爐號,機台,產品,日期,波長,溫度',
    'R1,A,P1,2026-06-01,10,1',
    'R2,A,P1,2026-06-02,12,2',
    'R3,B,P1,2026-06-03,14,3',
    'R4,B,P1,2026-06-04,16,4',
    'R5,B,P2,2026-06-05,18,5',
  ].join('\n');
  const tmp = require('os').tmpdir() + '/epi_data_test.csv';
  fs.writeFileSync(tmp, csv);
  const ds = load(tmp);

  console.log('\n── 讀檔與欄位辨識 ──');
  is('五筆資料都讀進來', ds.rows.length === 5);
  is('波長與溫度被認出是數值欄位', ds.metrics.includes('波長') && ds.metrics.includes('溫度'));
  is('爐號沒有被誤認成數值欄位', !ds.metrics.includes('爐號'));

  console.log('\n── 統計 ──');
  // 10,12,14,16,18 → 平均 14，樣本標準差 sqrt(40/4)=sqrt(10)
  const st = runStats(ds, {}, '波長');
  near('平均值', st.mean, 14);
  near('樣本標準差（n-1）', st.std, Math.sqrt(10), 1e-9);
  near('中位數', st.median, 14);
  near('Q1', st.q1, 12);
  is('n = 5', st.n === 5);

  console.log('\n── 篩選 ──');
  is('依機台篩 B 得三筆', select(ds, { machine: 'B' }).length === 3);
  is('依產品篩 P2 得一筆', select(ds, { product: 'P2' }).length === 1);
  is('日期區間含當天整天', select(ds, { from: '2026-06-02', to: '2026-06-03' }).length === 2);
  is('機台可以給陣列', select(ds, { machine: ['A', 'B'] }).length === 5);

  console.log('\n── 製程能力 ──');
  // mean=14, std=sqrt(10)≈3.1623, USL=20 → Cpu=(20-14)/(3*3.1623)=0.6325
  const c = cpk(ds, {}, '波長', 8, 20);
  near('Cpu', c.cpu, (20 - 14) / (3 * Math.sqrt(10)), 1e-9);
  near('Cpl', c.cpl, (14 - 8) / (3 * Math.sqrt(10)), 1e-9);
  near('Cpk 取兩者較小', c.cpk, Math.min(c.cpu, c.cpl), 1e-12);
  near('Cp', c.cp, (20 - 8) / (6 * Math.sqrt(10)), 1e-9);
  is('n < 25 會警告', c.warnings.some((w) => w.includes('n < 25')));
  is('沒給任何規格界限要被擋下', cpk(ds, {}, '波長').ok === false);
  is('規格界限反了要被擋下', cpk(ds, {}, '波長', 20, 8).ok === false);

  console.log('\n── 相關 ──');
  // 波長 = 10 + 2×溫度，完全線性 → r = 1，斜率 dy/dx = 2
  const co = correlate(ds, {}, '溫度', '波長');
  near('完全線性時 r = 1', co.r, 1, 1e-12);
  near('斜率', co.slope, 2, 1e-12);

  console.log('\n── 分組 ──');
  const g = groupStats(ds, {}, '波長', 'machine');
  near('A 組平均 (10+12)/2', g.groups.find((x) => x.key === 'A').mean, 11);
  near('B 組平均 (14+16+18)/3', g.groups.find((x) => x.key === 'B').mean, 16);
  near('組間差距', g.spread, 5);

  console.log('\n── SPC 判異 ──');
  // 建一組單調遞增的序列，規則 5（趨勢）必中
  const trendCsv = ['爐號,機台,產品,日期,值']
    .concat(Array.from({ length: 10 }, (_, i) =>
      `T${i},A,P,2026-07-${String(i + 1).padStart(2, '0')},${100 + i}`)).join('\n');
  fs.writeFileSync(tmp, trendCsv);
  const dsT = load(tmp);
  const spc = spcRules(dsT, {}, '值');
  is('連續上升會被判為趨勢（規則 5）', spc.violations.some((h) => h.rule === 5));
  near('中心線', spc.center, 104.5, 1e-9);
  // 單調遞增又以自身平均為中心線時，兩側各只有 5 點，構不成連續 7 點同側——規則 4 不該誤報
  is('同側點數不足 7 點時，規則 4 不該誤報', !spc.violations.some((h) => h.rule === 4));
  // 明確指定中心線，讓十個點全部落在同一側，規則 4 才該觸發
  const spcShift = spcRules(dsT, {}, '值', { center: 90, sigma: 3 });
  is('連續七點同側會被判為製程偏移（規則 4）', spcShift.violations.some((h) => h.rule === 4));
  is('點數不足時要擋下', spcRules(dsT, { runId: 'T0' }, '值').ok === false);

  console.log('\n── 防呆 ──');
  let threw = false;
  try { runStats(ds, {}, '不存在的欄位'); } catch { threw = true; }
  is('查不存在的欄位要報錯並列出可用欄位', threw);
  threw = false;
  try { select(ds, { from: '去年' }); } catch { threw = true; }
  is('日期格式看不懂要報錯', threw);
  is('找不到爐號要回傳錯誤而不是空物件', runDetail(ds, 'NOPE').ok === false);
  is('沒給爐號要反問', runDetail(ds).ok === false);

  fs.unlinkSync(tmp);
  console.log(`\n${fail === 0 ? '全部通過' : '有失敗項目'}：${pass} 通過，${fail} 失敗\n`);
  return fail === 0;
}

module.exports = {
  load, loadFile, select, values, decode, decodeWithInfo, parseDelimited, parseDate,
  runStats, cpk, groupStats, correlate, outliers, spcRules, runDetail, listRuns,
  demoCsv, selfTest, COLUMN_ALIASES,
};

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const a = process.argv.slice(2);
  const fmt = (x) => (typeof x === 'number' ? +x.toFixed(4) : x);

  if (a.includes('--test')) { process.exit(selfTest() ? 0 : 1); }

  if (a.includes('--demo')) {
    const p = require('os').tmpdir() + '/epi_demo.csv';
    fs.writeFileSync(p, demoCsv());
    console.log(`範例資料寫到 ${p}（240 爐、3 台機、40 天）\n`);
    const ds = load(p);
    console.log('可用量測欄位：' + ds.metrics.join('、') + '\n');

    console.log('── 全部爐次的波長 ──');
    const st = runStats(ds, {}, '波長');
    console.log(`  n=${st.n}  平均 ${fmt(st.mean)}  標準差 ${fmt(st.std)}  範圍 ${fmt(st.min)} ~ ${fmt(st.max)}`);

    console.log('\n── 各機台比較 ──');
    for (const g of groupStats(ds, {}, '波長', 'machine').groups) {
      console.log(`  ${g.key}  n=${g.n}  平均 ${fmt(g.mean)}  標準差 ${fmt(g.std)}`);
    }

    console.log('\n── MOCVD-03 的製程能力（規格 1540–1560）──');
    const c = cpk(ds, { machine: 'MOCVD-03' }, '波長', 1540, 1560);
    console.log(`  Cpk ${fmt(c.cpk)}（Cp ${fmt(c.cp)}）n=${c.n}`);
    c.warnings.forEach((w) => console.log(`  ⚠ ${w}`));

    console.log('\n── MOCVD-03 的管制圖判異 ──');
    const s = spcRules(ds, { machine: 'MOCVD-03' }, '波長');
    console.log(`  中心線 ${fmt(s.center)}  UCL ${fmt(s.ucl)}  LCL ${fmt(s.lcl)}`);
    if (s.clean) console.log('  沒有判異');
    else s.violations.slice(0, 6).forEach((h) => console.log(`  規則 ${h.rule}：${h.desc}　起於 ${h.at}`));

    console.log('\n── 波長和成長溫度的關係 ──');
    const co = correlate(ds, {}, '成長溫度', '波長');
    console.log(`  全部機台一起算：r = ${fmt(co.r)}　斜率 ${fmt(co.slope)} nm/°C　n=${co.n}`);
    for (const m of ['MOCVD-01', 'MOCVD-02', 'MOCVD-03']) {
      const c1 = correlate(ds, { machine: m }, '成長溫度', '波長');
      console.log(`  ${m}：斜率 ${fmt(c1.slope)} nm/°C　r = ${fmt(c1.r)}　n=${c1.n}`);
    }
    console.log(`  ${co.note}`);
    console.log('  注意上面兩行的落差：這份範例資料裡真正的溫度係數是 0.6 nm/°C，');
    console.log('  單看乾淨的兩台機台都算得回來，但把偏移的 MOCVD-03 混進去一起算就會失真。');
    console.log('  混機台算相關是現場很常犯的錯——所以查詢函式一律吃 filter，先分群再看關係。');
    console.log('\n這些數字全部由這支程式算出來，模型只負責決定要呼叫哪一個函式。');
    process.exit(0);
  }

  const files = a.filter((x) => !x.startsWith('--'));
  if (!files.length) {
    console.log(`用法：
  node epi_data.js --demo                     產生範例資料並跑一輪查詢
  node epi_data.js --test                     自我測試
  node epi_data.js <檔案...> --stats <欄位>
  node epi_data.js <檔案...> --cpk <欄位> <LSL> <USL>
  node epi_data.js <檔案...> --spc <欄位>
  node epi_data.js <檔案...> --group <欄位> [machine|product|day|month]

支援 CSV / TSV，UTF-8 與 Big5 自動辨識（MES 匯出常是 Big5）。`);
    process.exit(0);
  }

  const ds = load(files);
  console.log(`讀了 ${ds.files} 個檔、${ds.rows.length} 筆爐次`);
  if (ds.missing.length) {
    console.log(`⚠ 這些欄位沒有對應到：${ds.missing.join('、')}——請在 epi_data.js 的 COLUMN_ALIASES 補上你家系統的欄位名稱`);
  }
  console.log(`可用量測欄位：${ds.metrics.join('、')}\n`);

  const arg = (flag) => { const i = a.indexOf(flag); return i < 0 ? null : a.slice(i + 1).filter((x) => !x.startsWith('--')); };
  let r = null;
  if (arg('--stats')) r = runStats(ds, {}, arg('--stats')[0]);
  else if (arg('--cpk')) { const [m, l, u] = arg('--cpk'); r = cpk(ds, {}, m, l == null ? null : +l, u == null ? null : +u); }
  else if (arg('--spc')) r = spcRules(ds, {}, arg('--spc')[0]);
  else if (arg('--group')) { const [m, by] = arg('--group'); r = groupStats(ds, {}, m, by || 'machine'); }
  if (r) console.log(JSON.stringify(r, null, 2));
}
