'use strict';
// 把一爐的機台 log（每秒一列、上萬列）壓成「每個 step 每個通道一列」的特徵表。
//
// 為什麼一定要有這一層：
//   機台 log 是 10,629 列 × 97 欄的時間序列，量測資料是每爐 7 片。
//   兩者粒度差三個數量級，不可能直接 join。中間必須先把一爐壓成特徵，
//   才接得上 RUN_NO，也才餵得進 SPC 或模型。
//
// 現場給的三條規則，這支程式照做：
//   1. Control == 1 才是有效資料，0 是爐與爐之間的空檔
//   2. 以 StepLabel 分段，看每段的平均與偏差
//   3. 每段前段有等待平衡的 overshoot，穩態統計必須把那段切掉
//
//   node epi_log.js <log.csv>                     摘要
//   node epi_log.js <log.csv> --channel Reactor.temp   看單一通道逐 step
//   node epi_log.js <log.csv> -o features.csv     輸出特徵表（每 step 每通道一列）
//   node epi_log.js <log.csv> --run-row -o run.csv 輸出「一爐一列」給 SPC 用

const fs = require('fs');
const path = require('path');
const { profile } = require('./inspect.js');

// ─────────────────────────────────────────────────────────────
// 檔名裡的身分：RUN_NO 只存在於檔名，檔案內容沒有
// ─────────────────────────────────────────────────────────────
// 實測對照：量測檔的 Box No = "PMAT06261042-MW" = P + REACTOR + RUN_NO + -MW
//           log 檔名     = "..._PUHGR_MAT06261042_17004.txt"  →  MAT06 + 261042
// 所以 RUN_NO 是六位流水號，不是日期（261042 對應 G_DATE 2026/6/3，解不出來）。
//
// 第一版寫死成 /_P_.../，是照著當時唯一一份樣本 "..._P_MAT06261314_17351.csv" 訂的，
// 換一批檔名（"..._PUHGR_MAT06261042_17004.txt"）就整個抽不到。
// 改成只要求「分隔符 + 機台碼 + 六位數」，中間那段叫什麼都不管。
const NAME_PATTERN = /(?:^|[._-])([A-Z]{2,4}\d{2})(\d{6})(?:[._-](\d+))?(?:[._-]|$)/;

function parseRunName(file) {
  const base = path.basename(file, path.extname(file));
  const m = base.match(NAME_PATTERN);
  const out = { file: base, reactor: null, runNo: null, logSeq: null, structure: null, product: null };
  if (m) { out.reactor = m[1]; out.runNo = m[2]; out.logSeq = m[3] || null; }
  // 以 . 分段：第一段是結構代號、第三段是產品後綴。
  // 兩批樣本都吻合（H01A2N.PRODUCT.A2N.… 與 H01A4N.TECN2602001.A4N.…），
  // 但這是從兩份樣本歸納的，不是規格——所以照樣印出來讓人看得到對不對。
  const dots = base.split('.');
  if (dots.length >= 3) {
    out.structure = dots[0].replace(/^[0-9a-f]{6,}-/i, '');   // 去掉上傳時加的雜湊前綴
    out.product = dots[2];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 讀檔 → 有效區間 → 分段
// ─────────────────────────────────────────────────────────────

const num = (v) => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };

function loadRun(file, opt = {}) {
  const p = profile(file);
  const H = p.header, at = (n) => H.indexOf(n);
  const need = ['StepLabel'];
  for (const k of need) if (at(k) < 0) throw new Error(`${path.basename(file)} 少了必要欄位 ${k}`);

  // Control 欄位可能叫 Control_MV 或 Control；兩個都沒有就不過濾，但要講出來
  const ctrlIdx = at('Control_MV') >= 0 ? at('Control_MV') : at('Control');
  const all = p.body;
  const rows = ctrlIdx >= 0 ? all.filter((r) => num(r[ctrlIdx]) === 1) : all.slice();
  const dropped = all.length - rows.length;

  // SP/MV 成對的通道
  const channels = [];
  for (const h of H) {
    if (!h.endsWith('_SP')) continue;
    const base = h.slice(0, -3);
    if (at(base + '_MV') >= 0) channels.push({ name: base, sp: at(h), mv: at(base + '_MV') });
  }

  // 依 StepLabel 切連續區段（同一個 label 若不連續就是兩段，分開算）
  const slIdx = at('StepLabel'), stIdx = at('Step'), tsIdx = at('Timestamp');
  const segs = [];
  let cur = null;
  rows.forEach((r, i) => {
    const label = String(r[slIdx] == null ? '' : r[slIdx]).trim();
    if (!cur || cur.label !== label) {
      cur = { label, step: stIdx >= 0 ? r[stIdx] : null, start: i, rows: [], t0: tsIdx >= 0 ? r[tsIdx] : null };
      segs.push(cur);
    }
    cur.rows.push(r);
  });

  return {
    ...parseRunName(file), path: file,
    header: H, channels, segments: segs,
    totalRows: all.length, validRows: rows.length, droppedRows: dropped,
    hasControl: ctrlIdx >= 0,
    startTime: tsIdx >= 0 && rows.length ? rows[0][tsIdx] : null,
    endTime: tsIdx >= 0 && rows.length ? rows[rows.length - 1][tsIdx] : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 單一 step × 單一通道的特徵
// ─────────────────────────────────────────────────────────────
// 關鍵：用「追隨誤差 e = MV − SP」而不是假設 SP 固定。
// 實測 Reactor.temp 在某些 step 是從 277.6 斜坡升到 600，
// 假設 SP 固定的話那一段的統計會完全沒有意義。

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function stepFeatures(seg, ch, prevSpEnd, opt) {
  const relBand = opt.relBand == null ? 0.05 : opt.relBand;   // 以「這一步 SP 跳了多少」的 5% 當穩態帶
  const minSteady = opt.minSteady == null ? 5 : opt.minSteady; // 穩態至少要留幾秒才算數
  const skipFrac = opt.skipFrac == null ? 0.3 : opt.skipFrac;  // 抓不到穩態時，退而砍掉前 30%

  const sp = seg.rows.map((r) => num(r[ch.sp]));
  const mv = seg.rows.map((r) => num(r[ch.mv]));
  const n = sp.length;
  const f = { step: seg.label, channel: ch.name, n, tooShort: n < minSteady + 2 };
  if (!n || sp.some((v) => v == null) || mv.some((v) => v == null)) { f.error = '有空值'; return f; }

  const spMin = Math.min(...sp), spMax = Math.max(...sp);
  const spSpan = spMax - spMin;
  f.spStart = sp[0]; f.spEnd = sp[n - 1];
  f.isRamp = spSpan > Math.max(1e-9, Math.abs(mean(sp)) * 1e-4);

  const err = mv.map((v, i) => v - sp[i]);
  // 這一步 SP 相對前一步跳了多少——穩態帶要照這個尺度定，不然溫度和流量沒得比
  const dSP = prevSpEnd == null ? null : sp[0] - prevSpEnd;
  // 誤差帶不能只綁在「這一步跳了多少」：一段降溫如果跨了好幾個 step，
  // 從第二步起 SP 相對前一步就沒變（dSP=0），帶會變成 0，還在降的誤差
  // 就會被當成穩態偏差。實測 step 126→127 的降溫正是這樣被誤判的。
  // 所以再加一條以「通道自身量級」為準的地板帶。
  const levelFrac = opt.levelFrac == null ? 0.005 : opt.levelFrac;   // SP 量級的 0.5%
  const spLevel = Math.abs(mean(sp));
  const band = Math.max(
    Math.abs(dSP || 0) * relBand,
    spLevel * levelFrac,
    opt.floorBand == null ? 0 : opt.floorBand
  );
  f.dSP = dSP; f.band = band;

  // 找穩態起點：第一個「進入誤差帶之後就沒再出去」的位置
  let settleIdx = null;
  if (band > 0) {
    for (let i = 0; i < n; i++) {
      if (Math.abs(err[i]) <= band) {
        let ok = true;
        for (let j = i; j < n; j++) if (Math.abs(err[j]) > band) { ok = false; break; }
        if (ok) { settleIdx = i; break; }
      }
    }
  }
  f.settled = settleIdx != null;
  f.settle_s = settleIdx;   // null = 這一步從頭到尾都沒進到帶內（或本來就沒有 SP 跳變）

  // overshoot：整定期間往 SP 跳變方向衝過頭多少，用跳變量的百分比表示
  if (dSP != null && Math.abs(dSP) > 0) {
    const upto = settleIdx == null ? n : settleIdx;
    const dir = Math.sign(dSP);
    let peak = 0;
    for (let i = 0; i < upto; i++) { const over = dir * err[i]; if (over > peak) peak = over; }
    f.overshootPct = (peak / Math.abs(dSP)) * 100;
  } else {
    f.overshootPct = null;
  }

  // 穩態視窗：優先用偵測到的整定點，抓不到就砍掉前 skipFrac
  let s = settleIdx == null ? Math.floor(n * skipFrac) : settleIdx;
  if (n - s < minSteady) s = Math.max(0, n - minSteady);
  const e2 = err.slice(s), m2 = mv.slice(s);
  f.steadyFrom = s; f.steadyN = e2.length;
  f.bias = mean(e2);                                   // 系統性偏差：MV 一直比 SP 高或低
  f.errStd = sd(e2);                                   // 穩態抖動
  f.errMaxAbs = Math.max(...e2.map(Math.abs));         // 穩態最大偏離
  f.mvMean = mean(m2); f.mvStd = sd(m2);
  f.spMean = mean(sp.slice(s));
  f.endErr = err[n - 1];

  // 這一步屬於哪一種，決定了 bias 這個數字能不能解讀成「穩態偏差」。
  // 混在一起排序的話，物理上正常的降溫會蓋過真正的控制異常——實測 step 126
  // 是 30 秒內要降 157°C，結束時還差 152°C，那是來不及，不是偏掉。
  // 判斷依據是「這一步是不是從頭就已經在帶內」，而不是「SP 有沒有跳」。
  // 跨多步的轉態、以及收尾時閥門關斷但 SP 還掛著的情況，都靠這條擋下來。
  if (f.isRamp) f.kind = 'ramp';                       // SP 在動，bias 是追隨延遲
  else if (settleIdx === 0) f.kind = 'static';         // 一開始就在帶內＝真的穩態
  else if (settleIdx != null) f.kind = 'settled';      // 中途進帶並待住
  else f.kind = 'incomplete';                          // 整段都沒進帶：還在轉態或跟不上
  return f;
}

// ─────────────────────────────────────────────────────────────
// 整爐
// ─────────────────────────────────────────────────────────────

function extractRun(file, opt = {}) {
  const run = loadRun(file, opt);
  const only = opt.channels && opt.channels.length ? new Set(opt.channels) : null;
  const chans = only ? run.channels.filter((c) => only.has(c.name)) : run.channels;
  if (only && !chans.length) {
    throw new Error(`指定的通道都不存在。可用的有：${run.channels.map((c) => c.name).join(', ')}`);
  }

  const features = [];
  const prevSp = new Map();
  for (const seg of run.segments) {
    for (const ch of chans) {
      const f = stepFeatures(seg, ch, prevSp.has(ch.name) ? prevSp.get(ch.name) : null, opt);
      f.runNo = run.runNo; f.reactor = run.reactor;
      features.push(f);
      if (f.spEnd != null) prevSp.set(ch.name, f.spEnd);
    }
  }
  return { ...run, channels: chans, features };
}

// ─────────────────────────────────────────────────────────────
// 通道分族：44 個通道全放進管制圖只會被雜訊淹掉
// ─────────────────────────────────────────────────────────────
// 現場點名的三族，而且它們要用不同的指標：
//   source  前驅物源流量 —— 直接決定組成與成長速率，看 SP/MV 追隨
//   temp    反應器溫度   —— 實測 1°C 就讓 LEHI_RS 動 5σ，看 SP/MV 追隨
//   dp      壓差／排氣   —— 這幾個的 SP 逐列等於 MV（鏡射），追隨誤差恆為 0，
//                           要看的是「水位與漂移」：dP_Filter 慢慢爬升＝濾網在堵
const CHANNEL_GROUPS = {
  source: (n) => /\.source$/.test(n),
  temp: (n) => /temp$/i.test(n),
  dp: (n) => /^dP_|^dT_|^Ptrap\./i.test(n),
  push: (n) => /\.push$/.test(n),
  press: (n) => /\.press$/.test(n),
};
function groupOf(name) {
  for (const [g, test] of Object.entries(CHANNEL_GROUPS)) if (test(name)) return g;
  return 'other';
}

// 這個產品沒用到的通道，整爐 SP 都不變——放進寬表只是佔欄位。
// 先前現場確認過 AsH3_2 / Si2H6_3 / TMGa_3 就是這種情況。
function isActive(ex, ch) {
  const seen = new Set();
  for (const seg of ex.segments) {
    for (const r of seg.rows) { seen.add(r[ch.sp]); if (seen.size > 1) return true; }
  }
  return false;
}

// dp 這族要的是整爐的水位與漂移，不是逐 step 的追隨誤差
function levelStats(ex, ch) {
  const v = [];
  for (const seg of ex.segments) for (const r of seg.rows) { const x = num(r[ch.mv]); if (x != null) v.push(x); }
  if (!v.length) return null;
  const half = Math.floor(v.length / 2);
  return {
    channel: ch.name, n: v.length,
    mean: mean(v), std: sd(v), min: Math.min(...v), max: Math.max(...v),
    // 爐內漂移：後半段平均減前半段平均，比「最後一點減第一點」耐雜訊
    drift: mean(v.slice(half)) - mean(v.slice(0, half)),
  };
}

// 依分族挑出這一爐真正該盯的通道
function focusChannels(ex, groups = ['source', 'temp', 'dp']) {
  const want = new Set(groups);
  const out = { tracked: [], level: [], skippedInactive: [] };
  const mirrors = mirrorChannels(ex);
  for (const ch of ex.channels) {
    const g = groupOf(ch.name);
    if (!want.has(g)) continue;
    if (!isActive(ex, ch)) { out.skippedInactive.push(ch.name); continue; }
    // 鏡射通道（含整個 dp 族）沒有追隨誤差可談，只能看水位
    if (g === 'dp' || mirrors.has(ch.name)) out.level.push(ch);
    else out.tracked.push(ch);
  }
  return out;
}

// 每個通道跨所有 step 的摘要——一爐幾千列特徵，人要看的是這個
function channelSummary(ex) {
  const by = new Map();
  for (const f of ex.features) {
    if (f.error || f.tooShort) continue;
    if (!by.has(f.channel)) by.set(f.channel, []);
    by.get(f.channel).push(f);
  }
  const out = [];
  for (const [channel, fs2] of by) {
    // 只有「平台且已到位」的 step，bias 才真的是穩態偏差。
    // 斜坡的 bias 是追隨延遲、未到位的 bias 是還沒降完，混進來會把排序帶歪。
    const steady = fs2.filter((f) => f.kind === 'settled' || f.kind === 'static');
    const incomplete = fs2.filter((f) => f.kind === 'incomplete');
    const ramps = fs2.filter((f) => f.kind === 'ramp');
    const biases = steady.map((f) => f.bias).filter((v) => v != null);
    const stds = steady.map((f) => f.errStd).filter((v) => v != null);
    const settles = fs2.map((f) => f.settle_s).filter((v) => v != null && v > 0);
    const overs = fs2.map((f) => f.overshootPct).filter((v) => v != null && v > 0);
    const worst = steady.length
      ? steady.reduce((a, f) => (Math.abs(f.bias) > Math.abs(a.bias) ? f : a), steady[0]) : null;
    const worstInc = incomplete.length
      ? incomplete.reduce((a, f) => (Math.abs(f.endErr) > Math.abs(a.endErr) ? f : a), incomplete[0]) : null;
    const worstRamp = ramps.length
      ? ramps.reduce((a, f) => (Math.abs(f.bias) > Math.abs(a.bias) ? f : a), ramps[0]) : null;
    out.push({
      channel, steps: fs2.length,
      steadySteps: steady.length, rampSteps: ramps.length, incompleteSteps: incomplete.length,
      biasMean: biases.length ? mean(biases) : null,
      biasWorst: worst ? worst.bias : null, biasWorstStep: worst ? worst.step : null,
      errStdMean: stds.length ? mean(stds) : null,
      settleMax: settles.length ? Math.max(...settles) : null,
      settleMean: settles.length ? mean(settles) : null,
      overshootMax: overs.length ? Math.max(...overs) : null,
      // 未到位與追隨延遲分開報，不併進 bias
      endErrWorst: worstInc ? worstInc.endErr : null,
      endErrWorstStep: worstInc ? worstInc.step : null,
      rampLagWorst: worstRamp ? worstRamp.bias : null,
      rampLagWorstStep: worstRamp ? worstRamp.step : null,
    });
  }
  return out.sort((a, b) => Math.abs(b.biasWorst || 0) - Math.abs(a.biasWorst || 0));
}

// 一爐一列：把摘要攤平成寬表，這才是接得上 RUN_NO 和量測資料的形狀。
// groups 給 null 就是全部通道（274 欄，只適合探索）；
// 給 ['source','temp','dp'] 會收斂到現場真正會盯的那十來個，管制圖才不會被雜訊淹掉。
function runRow(ex, groups) {
  const row = {
    RUN_NO: ex.runNo, REACTOR: ex.reactor, STRUCTURE: ex.structure, PRODUCT: ex.product,
    LOG_SEQ: ex.logSeq, START: ex.startTime, END: ex.endTime,
    VALID_S: ex.validRows, IDLE_S: ex.droppedRows, STEPS: ex.segments.length,
  };
  if (!groups) {
    for (const s of channelSummary(ex)) {
      const k = s.channel.replace(/[^\w.]/g, '_');
      row[`${k}|bias`] = s.biasMean;
      row[`${k}|biasWorst`] = s.biasWorst;
      row[`${k}|errStd`] = s.errStdMean;
      row[`${k}|settleMax`] = s.settleMax;
      row[`${k}|overshootMax`] = s.overshootMax;
    }
    return row;
  }

  const focus = focusChannels(ex, groups);
  const tracked = new Set(focus.tracked.map((c) => c.name));
  for (const s of channelSummary(ex)) {
    if (!tracked.has(s.channel)) continue;
    const k = s.channel.replace(/[^\w.]/g, '_');
    row[`${k}|bias`] = s.biasMean;          // 系統性偏高／偏低
    row[`${k}|errStd`] = s.errStdMean;      // 穩態抖動
    row[`${k}|settleMax`] = s.settleMax;    // 最久整定：加熱器或流量計退化的早期訊號
  }
  // dp 這族沒有 SP 可比，看的是水位與爐內漂移
  for (const ch of focus.level) {
    const st = levelStats(ex, ch);
    if (!st) continue;
    const k = ch.name.replace(/[^\w.]/g, '_');
    row[`${k}|level`] = st.mean;
    row[`${k}|drift`] = st.drift;
    row[`${k}|max`] = st.max;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────
// 配方一致性：SP 是 recipe 的設定值，MV 是機台實際跑出來的
// ─────────────────────────────────────────────────────────────
// 這兩件事要分開比，因為對應到完全不同的失效與不同的負責人：
//   SP vs SP（跨爐）＝配方被改過或載錯配方  → 製程
//   MV vs SP（同爐）＝配方對但機台沒跟上    → 設備
// 同一個產品的不同爐，SP 時間軸本來就該一模一樣，任何差異都值得問一句。

// 有些通道的 SP 欄逐列等於 MV 欄——那不是設定值，只是把量測值鏡射一份。
// 實測 dP_Filter、dT_Exhaust、Ptrap.press、Control 都是 100% 相同。
// 它們不屬於配方，拿來比會製造大量假差異；追隨誤差也恆為 0，放進偏差排名只是雜訊。
function mirrorChannels(ex) {
  const out = new Set();
  for (const ch of ex.channels) {
    let same = 0, n = 0;
    for (const seg of ex.segments) {
      for (const r of seg.rows) {
        const a = r[ch.sp], b = r[ch.mv];
        if (a != null && b != null) { n++; if (a === b) same++; }
      }
    }
    if (n && same / n > 0.999) out.add(ch.name);
  }
  return out;
}

function recipeOf(ex) {
  const mirrors = mirrorChannels(ex);
  const steps = new Map();
  for (const seg of ex.segments) {
    const chans = {};
    for (const ch of ex.channels) {
      if (mirrors.has(ch.name)) continue;
      const sp = seg.rows.map((r) => num(r[ch.sp])).filter((v) => v != null);
      if (!sp.length) continue;
      const start = sp[0], end = sp[sp.length - 1];
      const span = Math.max(...sp) - Math.min(...sp);
      const isRamp = span > Math.max(1e-9, Math.abs(start) * 1e-4);
      // 只有一個取樣點的 step 分不出平台或斜坡——那只是轉態途中的一張快照，
      // 不是配方寫的平台值。實測 step 28（1 秒）兩爐差 46°C，就是這樣被誤報的。
      const tooShort = sp.length < 2;
      // 平台：配方指定的就是那個值。
      // 斜坡：起點是「上一步結束在哪」，不是配方寫的；配方寫的是速率與終點，
      //       所以只比速率（每秒變化量），終點會受 1 秒取樣量化影響。
      chans[ch.name] = { start, end, isRamp, tooShort, n: sp.length,
        rate: isRamp && sp.length > 1 ? (end - start) / (sp.length - 1) : null };
    }
    // 同一個 label 若出現多段，各段分開記，避免把兩段的設定值混在一起
    let key = seg.label, i = 2;
    while (steps.has(key)) key = `${seg.label}#${i++}`;
    steps.set(key, { label: seg.label, n: seg.rows.length, channels: chans });
  }
  return { runNo: ex.runNo, structure: ex.structure, product: ex.product, steps, mirrors: [...mirrors] };
}

function compareRecipe(exA, exB, opt = {}) {
  const tol = opt.spTol == null ? 1e-9 : opt.spTol;
  const A = recipeOf(exA), B = recipeOf(exB);
  const ka = [...A.steps.keys()], kb = [...B.steps.keys()];
  const onlyInA = ka.filter((k) => !B.steps.has(k));
  const onlyInB = kb.filter((k) => !A.steps.has(k));
  const shared = ka.filter((k) => B.steps.has(k));

  const rateTol = opt.rateTol == null ? 0.05 : opt.rateTol;   // 斜坡速率的相對容差
  const spDiffs = [], rampDiffs = [], durationDiffs = [], codeDiffs = [];
  let shortSteps = 0;
  for (const k of shared) {
    const a = A.steps.get(k), b = B.steps.get(k);
    if (a.n !== b.n) durationDiffs.push({ step: k, aN: a.n, bN: b.n, delta: b.n - a.n });
    const chans = new Set([...Object.keys(a.channels), ...Object.keys(b.channels)]);
    for (const c of chans) {
      const x = a.channels[c], y = b.channels[c];
      if (!x || !y) { spDiffs.push({ step: k, channel: c, missing: !x ? 'A' : 'B' }); continue; }
      // StepCode 是步驟代碼（值像 18、1、3），不是製程設定值；差 1 代表流程編號不同，
      // 不是「參數被改」。單獨列出來，不要混進設定值差異裡。
      if (/^StepCode$/i.test(c)) {
        if (Math.abs(y.start - x.start) > tol) codeDiffs.push({ step: k, a: x.start, b: y.start });
        continue;
      }
      if (x.tooShort || y.tooShort) { shortSteps++; continue; }
      if (x.isRamp || y.isRamp) {
        // 斜坡只比速率；起點是繼承來的、終點受每秒取樣的量化影響，都不能直接比
        if (x.isRamp !== y.isRamp) {
          rampDiffs.push({ step: k, channel: c, kind: '一邊是斜坡一邊是平台', aRamp: x.isRamp, bRamp: y.isRamp });
          continue;
        }
        const ra = x.rate, rb = y.rate;
        if (ra != null && rb != null) {
          const scale = Math.max(Math.abs(ra), Math.abs(rb));
          if (scale > 0 && Math.abs(rb - ra) / scale > rateTol) {
            rampDiffs.push({ step: k, channel: c, kind: '速率不同', aRate: ra, bRate: rb });
          }
        }
        continue;
      }
      // 平台：配方寫的就是這個值，應該完全一致
      const d = y.start - x.start;
      if (Math.abs(d) > tol) {
        spDiffs.push({ step: k, channel: c, aStart: x.start, bStart: y.start, aEnd: x.end, bEnd: y.end, dStart: d, dEnd: y.end - x.end });
      }
    }
  }
  return {
    a: A.runNo, b: B.runNo,
    productA: A.product, productB: B.product,
    sameProduct: A.product === B.product && A.structure === B.structure,
    stepsA: ka.length, stepsB: kb.length,
    mirrors: A.mirrors,
    onlyInA, onlyInB, spDiffs, rampDiffs, durationDiffs, codeDiffs, shortSteps,
    // 平台設定值與斜坡速率都一致才算同一份配方；
    // 步長單獨看（有些 step 是條件結束不是時間結束）
    sameRecipe: onlyInA.length === 0 && onlyInB.length === 0 && spDiffs.length === 0 && rampDiffs.length === 0,
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows, cols) {
  const header = cols || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [header.join(',')].concat(rows.map((r) => header.map((c) => csvCell(r[c])).join(','))).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────
// 自我測試：用合成資料，答案都是手算得出來的
// ─────────────────────────────────────────────────────────────
function selfTest() {
  const os = require('os');
  let pass = 0, fail = 0;
  const is = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); cond ? pass++ : fail++; };
  const near = (name, got, want, tol = 1e-9) => {
    const ok = got != null && Math.abs(got - want) <= tol;
    console.log(`  ${ok ? '✓' : '✗'} ${name}：算出 ${got == null ? 'null' : +got.toFixed(6)}，預期 ${want} ±${tol}`);
    ok ? pass++ : fail++;
  };

  // 合成一爐：兩個平台 step + 一個斜坡 step，前後各夾 Control=0 的空檔
  const rows = [];
  const push = (t, label, ctrl, sp, mv) =>
    rows.push([`2026-07-06 0${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
      label, ctrl, sp.toFixed(4), mv.toFixed(4)]);
  let t = 0;
  for (let i = 0; i < 5; i++) push(t++, '', 0, 100, 100);              // 空檔 5 秒
  for (let i = 0; i < 20; i++) push(t++, 'S1', 1, 100, 100.5);         // 平台：MV 固定高 0.5
  for (let i = 0; i < 20; i++) push(t++, 'S2', 1, 200, 200 - (i < 6 ? 20 - i * 4 : 0)); // 跳到 200，前 5 秒沒到位
  for (let i = 0; i < 20; i++) push(t++, 'S3', 1, 200 + i * 5, 200 + i * 5 - 3);        // 斜坡：MV 落後 3
  for (let i = 0; i < 3; i++) push(t++, 'S4', 0, 300, 300);            // 空檔 3 秒

  const csv = ['Timestamp,StepLabel,Control_MV,X_SP,X_MV'].concat(rows.map((r) => r.join(','))).join('\n');
  const f = path.join(os.tmpdir(), 'P06336_M06_P_MAT06261314_17351.csv');
  fs.writeFileSync(f, csv);

  console.log('\n── 檔名解析 ──');
  const nm = parseRunName(f);
  is('抽出 RUN_NO 261314', nm.runNo === '261314');
  is('抽出機台 MAT06', nm.reactor === 'MAT06');
  is('抽出 log 流水號 17351', nm.logSeq === '17351');
  is('不符格式時 runNo 為 null', parseRunName('/tmp/隨便.csv').runNo === null);
  // 兩批真實檔名的樣式不同（_P_ vs _PUHGR_、.csv vs .txt、PRODUCT vs TECN2602001），
  // 第一版寫死 _P_ 導致第二批整個抽不到。兩種都釘住，避免再退化。
  const alt = parseRunName('H01A4N.TECN2602001.A4N.TECN090_M06_PUHGR_MAT06261042_17004.txt');
  is('另一種檔名樣式也抽得到 RUN_NO 261042', alt.runNo === '261042');
  is('另一種樣式的機台是 MAT06', alt.reactor === 'MAT06');
  is('另一種樣式的結構是 H01A4N', alt.structure === 'H01A4N');
  is('另一種樣式的產品是 A4N', alt.product === 'A4N');
  is('不會把 TECN2602001 誤認成機台碼＋爐號', alt.reactor !== 'TECN26');

  console.log('\n── Control 過濾與分段 ──');
  const ex = extractRun(f, {});
  is('只留 Control==1 的 60 秒', ex.validRows === 60);
  is('空檔 8 秒被排除', ex.droppedRows === 8);
  is('切出 3 個 step 區段', ex.segments.length === 3);
  is('認出 1 組 SP/MV 通道', ex.channels.length === 1);

  console.log('\n── 平台：穩態偏差 ──');
  const s1 = ex.features.find((x) => x.step === 'S1');
  near('MV 固定高 0.5 → bias = 0.5', s1.bias, 0.5, 1e-9);
  near('完全不抖 → errStd = 0', s1.errStd, 0, 1e-12);
  is('SP 不動 → 不是斜坡', s1.isRamp === false);
  is('一開始就在帶內 → kind = static', s1.kind === 'static');

  console.log('\n── 平台：跳變後整定 ──');
  const s2 = ex.features.find((x) => x.step === 'S2');
  near('相對前一步跳了 +100', s2.dSP, 100, 1e-9);
  is('中途進帶並待住 → kind = settled', s2.kind === 'settled');
  is(`整定時間為正（算出 ${s2.settle_s}s）`, s2.settle_s > 0 && s2.settle_s <= 6);
  // 穩態視窗從「進帶那一刻」起算，所以會含進帶當下那一筆（誤差 -4，剛好在 ±5 帶內）。
  // 16 筆裡有一筆 -4 → 平均 -0.25，這是定義上正確的值，不是誤差。
  // 真實資料裡可以忽略（step 72 是 116 秒進帶、534 筆穩態），小樣本才看得出來。
  near('整定後 bias ≈ 0（含進帶當下那一筆）', s2.bias, -0.25, 1e-9);
  is('進帶後的誤差確實都是 0', s2.errMaxAbs === 4);

  console.log('\n── 斜坡：追隨延遲不該被當成偏差 ──');
  const s3 = ex.features.find((x) => x.step === 'S3');
  is('SP 在動 → isRamp', s3.isRamp === true);
  is('分類為 ramp', s3.kind === 'ramp');
  near('MV 落後 3 → bias = -3', s3.bias, -3, 1e-9);
  const sum = channelSummary(ex);
  is('斜坡不併進穩態偏差的統計', Math.abs(sum[0].biasMean - 0.25) < 0.3);
  near('斜坡落後單獨報', sum[0].rampLagWorst, -3, 1e-9);

  console.log('\n── 未到位：step 太短來不及 ──');
  // 跳 +1000 但只有 8 秒，且 MV 幾乎沒動
  const rows2 = [['Timestamp,StepLabel,Control_MV,X_SP,X_MV']];
  for (let i = 0; i < 10; i++) rows2.push([`2026-07-06 00:00:${String(i).padStart(2, '0')},A,1,100.0000,100.0000`]);
  for (let i = 0; i < 8; i++) rows2.push([`2026-07-06 00:00:${String(10 + i).padStart(2, '0')},B,1,1100.0000,${(100 + i * 2).toFixed(4)}`]);
  const f2 = path.join(os.tmpdir(), 'P1_M06_P_MAT06261315_17352.csv');
  fs.writeFileSync(f2, rows2.map((r) => r.join('')).join('\n'));
  const ex2 = extractRun(f2, { minSteady: 3 });
  const b = ex2.features.find((x) => x.step === 'B');
  is('整段沒進帶 → kind = incomplete', b.kind === 'incomplete');
  is('settle_s 為 null（沒整定）', b.settle_s === null);
  is('殘差被記錄下來', Math.abs(b.endErr + 986) < 1);

  console.log('\n── 配方一致性（SP vs SP）──');
  const same = compareRecipe(ex, extractRun(f, {}));
  is('同一份 log 跟自己比 → 完全一致', same.sameRecipe === true);
  is('沒有 SP 差異', same.spDiffs.length === 0);
  // 改一個設定值：S2 的 SP 從 200 變 205
  const mutated = csv.replace(/,200\.0000,/g, ',205.0000,');
  const f3 = path.join(os.tmpdir(), 'P2_M06_P_MAT06261316_17353.csv');
  fs.writeFileSync(f3, mutated);
  const diff = compareRecipe(ex, extractRun(f3, {}));
  is('改過設定值 → 判為不同配方', diff.sameRecipe === false);
  is('指出是哪一步哪個通道', diff.spDiffs.some((d) => d.step === 'S2' && d.channel === 'X'));
  near('差異量正確（+5）', diff.spDiffs.find((d) => d.step === 'S2').dStart, 5, 1e-9);
  // 少一個 step
  const shortCsv = csv.split('\n').filter((l) => !l.includes(',S3,')).join('\n');
  const f4 = path.join(os.tmpdir(), 'P3_M06_P_MAT06261317_17354.csv');
  fs.writeFileSync(f4, shortCsv);
  const miss = compareRecipe(ex, extractRun(f4, {}));
  is('少一個 step 會被指出來', miss.onlyInA.includes('S3'));

  console.log('\n── 通道分族 ──');
  is('X 歸到 other（不屬於三族）', groupOf('X') === 'other');
  is('AsH3_1.source → source', groupOf('AsH3_1.source') === 'source');
  is('Reactor.temp → temp', groupOf('Reactor.temp') === 'temp');
  is('dP_Filter → dp', groupOf('dP_Filter') === 'dp');
  is('dT_Exhaust → dp', groupOf('dT_Exhaust') === 'dp');
  is('Ptrap.press → dp（不能被 .press 規則搶走）', groupOf('Ptrap.press') === 'dp');
  is('TMGa_2.press → press 而不是 dp', groupOf('TMGa_2.press') === 'press');
  is('AsH3_1.push → push', groupOf('AsH3_1.push') === 'push');

  // 整爐 SP 沒動過＝這個產品沒用到，要排除
  const rows3 = ['Timestamp,StepLabel,Control_MV,A.source_SP,A.source_MV,B.source_SP,B.source_MV'];
  for (let i = 0; i < 12; i++) {
    rows3.push(`2026-07-06 00:00:${String(i).padStart(2, '0')},S,1,${10 + i}.0000,${10 + i}.0000,5.0000,5.0000`);
  }
  const f5 = path.join(os.tmpdir(), 'P5_M06_P_MAT06261320_17360.csv');
  fs.writeFileSync(f5, rows3.join('\n'));
  const ex5 = extractRun(f5, { minSteady: 3 });
  const fo = focusChannels(ex5, ['source']);
  is('SP 有動的通道留下', fo.tracked.concat(fo.level).some((c) => c.name === 'A.source'));
  is('SP 整爐沒動的通道被排除', fo.skippedInactive.includes('B.source'));

  console.log('\n── 一爐一列 ──');
  const row = runRow(ex);
  is('帶著 RUN_NO', row.RUN_NO === '261314');
  is('帶著機台', row.REACTOR === 'MAT06');
  is('有效秒數正確', row.VALID_S === 60);

  [f, f2, f3, f4, f5].forEach((p2) => { try { fs.unlinkSync(p2); } catch { /* 已刪就算了 */ } });
  console.log(`\n${fail === 0 ? '全部通過' : '有失敗項目'}：${pass} 通過，${fail} 失敗\n`);
  return fail === 0;
}

module.exports = { parseRunName, loadRun, extractRun, channelSummary, runRow, stepFeatures,
                   recipeOf, compareRecipe, mirrorChannels, groupOf, isActive, levelStats,
                   focusChannels, CHANNEL_GROUPS, toCsv, selfTest, NAME_PATTERN };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const files = argv.filter((a, i) => !a.startsWith('-') &&
    !['-o', '--channel', '--rel-band', '--min-steady', '--level-frac'].includes(argv[i - 1]));

  if (flag('--test')) process.exit(selfTest() ? 0 : 1);

  if (!files.length) {
    console.log(`用法：node epi_log.js <機台log.csv...> [選項]

  --channel <名稱>     只看單一通道（例如 Reactor.temp），逐 step 列出
  --compare            比對兩爐的配方（SP vs SP），找出配方被改過或載錯
  --rel-band <比例>    穩態帶＝SP 跳變量的幾成，預設 0.05
  --level-frac <比例>  穩態帶的地板＝SP 量級的幾成，預設 0.005
  --min-steady <秒>    穩態至少要幾秒才納入統計，預設 5
  --run-row            輸出「一爐一列」的寬表（接 RUN_NO 用）
  --groups <族...>     只留這幾族通道，預設 source,temp,dp；給 all 就是全部 44 個
  --focus              列出這一爐該盯哪些通道（分族 + 濾掉這產品沒用到的）
  -o <檔名>            寫出 CSV
  --test               自我測試

SP 是 recipe 的設定值，MV 是機台實際記錄值，兩者要分開比：
  SP vs SP（跨爐，--compare）＝配方被改過或載錯　→ 製程
  MV vs SP（同爐，預設）      ＝配方對但機台沒跟上 → 設備

Control == 1 的區間才算有效；以 StepLabel 分段；每段的整定期會被切掉再算穩態。`);
    process.exit(0);
  }

  const opt = {
    relBand: parseFloat(val('--rel-band', '0.05')),
    levelFrac: parseFloat(val('--level-frac', '0.005')),
    minSteady: parseInt(val('--min-steady', '5'), 10),
    channels: val('--channel', '') ? [val('--channel', '')] : null,
  };
  const groupsArg = val('--groups', 'source,temp,dp');
  const groups = groupsArg === 'all' ? null : groupsArg.split(',').map((x) => x.trim()).filter(Boolean);

  if (flag('--compare')) {
    if (files.length !== 2) { console.error('--compare 需要剛好兩個檔案。'); process.exit(1); }
    const [A, B] = files.map((f) => extractRun(f, { ...opt, channels: null }));
    const r = compareRecipe(A, B);
    console.log(`\n${'═'.repeat(76)}`);
    console.log(`配方比對：RUN ${r.a || '?'}（${r.productA || '?'}）  vs  RUN ${r.b || '?'}（${r.productB || '?'}）`);
    if (!r.sameProduct) console.log('⚠ 這兩爐的結構／產品代號不同，配方本來就會不一樣，比對意義有限。');
    console.log('─'.repeat(76));
    console.log(`step 數：${r.stepsA} vs ${r.stepsB}`);
    if (r.onlyInA.length) console.log(`只有 A 有的 step（${r.onlyInA.length}）：${r.onlyInA.slice(0, 12).join(', ')}${r.onlyInA.length > 12 ? ' …' : ''}`);
    if (r.onlyInB.length) console.log(`只有 B 有的 step（${r.onlyInB.length}）：${r.onlyInB.slice(0, 12).join(', ')}${r.onlyInB.length > 12 ? ' …' : ''}`);

    if (r.mirrors.length) {
      console.log(`\n（${r.mirrors.join('、')} 的 SP 逐列等於 MV，那不是設定值而是量測值的鏡射，已排除）`);
    }
    if (r.rampDiffs.length) {
      console.log(`\n斜坡速率有 ${r.rampDiffs.length} 處不同（斜坡只比速率：起點是上一步結束的位置，終點受每秒取樣量化）：`);
      for (const d of r.rampDiffs.slice(0, 12)) {
        if (d.kind === '速率不同') {
          console.log(`  step ${String(d.step).padEnd(10)} ${d.channel.padEnd(18)} ${d.aRate.toFixed(4)} → ${d.bRate.toFixed(4)} /秒`);
        } else {
          console.log(`  step ${String(d.step).padEnd(10)} ${d.channel.padEnd(18)} ${d.kind}`);
        }
      }
      if (r.rampDiffs.length > 12) console.log(`  …還有 ${r.rampDiffs.length - 12} 處`);
    }
    if (r.shortSteps) {
      console.log(`（${r.shortSteps} 個 step×通道只有 1 秒，分不出平台或斜坡，已排除）`);
    }
    if (r.codeDiffs.length) {
      console.log(`\nStepCode 有 ${r.codeDiffs.length} 處不同（那是步驟代碼不是製程參數，代表流程編號有出入）：`);
      console.log('  ' + r.codeDiffs.slice(0, 10).map((d) => `step ${d.step}: ${d.a}→${d.b}`).join('　'));
    }
    if (!r.spDiffs.length && !r.onlyInA.length && !r.onlyInB.length) {
      console.log('\n✓ 平台設定值完全一致。');
    } else {
      console.log(`\n平台設定值有 ${r.spDiffs.length} 處不同：`);
      for (const d of r.spDiffs.slice(0, 25)) {
        if (d.missing) { console.log(`  step ${String(d.step).padEnd(10)} ${d.channel.padEnd(18)} 只有 ${d.missing === 'A' ? 'B' : 'A'} 有這個通道`); continue; }
        console.log(`  step ${String(d.step).padEnd(10)} ${d.channel.padEnd(18)} ` +
          `${d.aStart} → ${d.bStart}` + (Math.abs(d.dEnd - d.dStart) > 1e-9 ? `（結束值 ${d.aEnd} → ${d.bEnd}）` : '') +
          `　差 ${d.dStart > 0 ? '+' : ''}${+d.dStart.toFixed(6)}`);
      }
      if (r.spDiffs.length > 25) console.log(`  …還有 ${r.spDiffs.length - 25} 處`);
    }

    if (r.durationDiffs.length) {
      const big = r.durationDiffs.filter((d) => Math.abs(d.delta) >= 2).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      console.log(`\n步長不同的 step：${r.durationDiffs.length} 個（差 2 秒以上的 ${big.length} 個）`);
      for (const d of big.slice(0, 10)) console.log(`  step ${String(d.step).padEnd(10)} ${d.aN}s → ${d.bN}s　${d.delta > 0 ? '+' : ''}${d.delta}s`);
      console.log('  步長差異單獨看：有些 step 是條件結束而不是時間結束，差幾秒不一定代表配方被改。');
    }
    console.log(`\n結論：${r.sameRecipe ? '同一份配方' : '配方不同——開爐前要先確認是不是載錯或被改過'}`);
    process.exit(0);
  }

  if (flag('--focus')) {
    for (const f of files) {
      const ex = extractRun(f, { ...opt, channels: null });
      const fo = focusChannels(ex, groups || ['source', 'temp', 'dp']);
      console.log(`\n${'═'.repeat(72)}`);
      console.log(`RUN_NO ${ex.runNo}　產品 ${ex.product}　該盯的通道`);
      console.log('─'.repeat(72));
      const byGroup = new Map();
      for (const c of fo.tracked) {
        const g = groupOf(c.name);
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(c.name);
      }
      for (const [g, list] of byGroup) {
        console.log(`【${g}】${list.length} 個　看 SP/MV 追隨（偏差、抖動、整定）`);
        console.log('  ' + list.join(', '));
      }
      if (fo.level.length) {
        console.log(`【dp／鏡射】${fo.level.length} 個　SP 逐列等於 MV，沒有追隨誤差可談，看水位與爐內漂移`);
        for (const c of fo.level) {
          const st = levelStats(ex, c);
          console.log(`  ${c.name.padEnd(16)} 水位 ${st.mean.toFixed(3)}　爐內漂移 ${st.drift > 0 ? '+' : ''}${st.drift.toFixed(3)}　範圍 ${st.min.toFixed(2)}~${st.max.toFixed(2)}`);
        }
      }
      if (fo.skippedInactive.length) {
        console.log(`\n這一爐整爐 SP 沒動過，代表這個產品沒用到（${fo.skippedInactive.length} 個，已排除）：`);
        console.log('  ' + fo.skippedInactive.join(', '));
      }
      console.log(`\n合計要盯 ${fo.tracked.length + fo.level.length} 個通道（全部 SP/MV 通道有 ${ex.channels.length} 個）`);
    }
    process.exit(0);
  }

  const exs = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`找不到檔案：${f}`); process.exit(1); }
    let ex;
    try { ex = extractRun(f, opt); }
    catch (e) { console.error(`${path.basename(f)}：${e.message}`); process.exit(1); }
    exs.push(ex);

    console.log(`\n${'═'.repeat(76)}`);
    console.log(`RUN_NO ${ex.runNo || '(檔名解不出來)'}　機台 ${ex.reactor || '?'}　結構 ${ex.structure || '?'}　產品 ${ex.product || '?'}`);
    if (!ex.runNo) {
      console.log('⚠ 檔名不符合預期格式，抽不出 RUN_NO——沒有 RUN_NO 就接不上量測資料。');
      console.log(`  目前的比對樣式：${NAME_PATTERN}`);
    }
    console.log(`${ex.startTime} ~ ${ex.endTime}`);
    console.log(`有效 ${ex.validRows.toLocaleString()} 秒　空檔 ${ex.droppedRows} 秒` +
      (ex.hasControl ? '（依 Control==1 過濾）' : '　⚠ 找不到 Control 欄，沒有過濾'));
    console.log(`${ex.segments.length} 個 step 區段　${ex.channels.length} 組 SP/MV 通道`);

    const short = ex.features.filter((f) => f.tooShort).length;
    if (short) console.log(`（其中 ${short} 筆因為 step 太短（< ${opt.minSteady + 2} 秒）算不出穩態，已排除）`);

    if (opt.channels) {
      const rows = ex.features.filter((f) => !f.error);
      console.log('\nstep        n    SP起→SP終            偏差    抖動   整定  過衝%');
      console.log('─'.repeat(76));
      for (const f of rows) {
        if (f.tooShort) continue;
        console.log(
          String(f.step).padEnd(11) + String(f.n).padStart(5) + '  ' +
          `${(f.spStart ?? 0).toFixed(1)}→${(f.spEnd ?? 0).toFixed(1)}`.padEnd(20) +
          (f.bias == null ? '' : f.bias.toFixed(3)).padStart(8) +
          (f.errStd == null ? '' : f.errStd.toFixed(3)).padStart(8) +
          (f.settle_s == null ? '  —' : String(f.settle_s) + 's').padStart(7) +
          (f.overshootPct == null ? '  —' : f.overshootPct.toFixed(1)).padStart(8) +
          (f.isRamp ? '  [斜坡]' : '')
        );
      }
    } else {
      const sum = channelSummary(ex);
      const n3 = (v) => (v == null ? '—' : v.toFixed(3));
      console.log('\n穩態偏差（只算平台且已到位的 step——這才是「偏掉了」的意思）');
      console.log('─'.repeat(76));
      console.log('通道                平台步  平均偏差    最大偏差 @step       抖動   最久整定');
      for (const s of sum.slice(0, 15)) {
        console.log(
          s.channel.padEnd(20) + String(s.steadySteps).padStart(5) +
          n3(s.biasMean).padStart(11) +
          (s.biasWorst == null ? '—' : n3(s.biasWorst) + ' @' + s.biasWorstStep).padStart(19) +
          n3(s.errStdMean).padStart(10) +
          (s.settleMax == null ? '—' : s.settleMax + 's').padStart(10)
        );
      }

      const inc = sum.filter((s) => s.incompleteSteps).sort((a, b) => Math.abs(b.endErrWorst) - Math.abs(a.endErrWorst));
      if (inc.length) {
        console.log('\n未到位：SP 跳變後整段都沒進到誤差帶（step 太短、或跟不上）');
        console.log('─'.repeat(76));
        for (const s of inc.slice(0, 8)) {
          console.log(`  ${s.channel.padEnd(20)} ${String(s.incompleteSteps).padStart(3)} 個 step　` +
            `最大殘差 ${n3(s.endErrWorst)} @${s.endErrWorstStep}`);
        }
      }

      const rmp = sum.filter((s) => s.rampSteps).sort((a, b) => Math.abs(b.rampLagWorst) - Math.abs(a.rampLagWorst));
      if (rmp.length) {
        console.log('\n斜坡追隨延遲：SP 在動，MV 落後多少（不是偏差，是跟不跟得上）');
        console.log('─'.repeat(76));
        for (const s of rmp.slice(0, 6)) {
          console.log(`  ${s.channel.padEnd(20)} ${String(s.rampSteps).padStart(3)} 個斜坡　` +
            `最大落後 ${n3(s.rampLagWorst)} @${s.rampLagWorstStep}`);
        }
      }
      console.log('\n這三張表刻意分開：斜坡的落後與未降到位都是物理上正常的，');
      console.log('混進「偏差」一起排序，會把它們排到真正的控制異常前面。');
    }
  }

  const out = val('-o', '');
  if (out) {
    if (flag('--run-row')) {
      const rows = exs.map((e) => runRow(e, groups));
      fs.writeFileSync(out, toCsv(rows));
      console.log(`\n寫出一爐一列的寬表：${out}（${rows.length} 爐 × ${Object.keys(rows[0]).length} 欄）` +
        (groups ? `　只含 ${groups.join('／')} 族` : '　含全部通道'));
      console.log('這張表的 RUN_NO 可以直接對上量測資料的 RUN_NO。');
    } else {
      const rows = exs.flatMap((ex) => ex.features.filter((f) => !f.error && !f.tooShort).map((f) => ({
        RUN_NO: f.runNo, REACTOR: f.reactor, step: f.step, channel: f.channel,
        n: f.n, spStart: f.spStart, spEnd: f.spEnd, isRamp: f.isRamp ? 1 : 0,
        dSP: f.dSP, band: f.band, settle_s: f.settle_s, overshootPct: f.overshootPct,
        bias: f.bias, errStd: f.errStd, errMaxAbs: f.errMaxAbs, mvMean: f.mvMean, mvStd: f.mvStd,
      })));
      fs.writeFileSync(out, toCsv(rows));
      console.log(`\n寫出特徵表：${out}（${rows.length.toLocaleString()} 列 = step × 通道）`);
    }
  }
}
