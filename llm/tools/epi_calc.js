'use strict';
// III/V 磊晶製程的「專家系統」核心：確定性計算，不是生成。
//
// 這裡每一個數字都是「算出來的」或「查表查到的」，不是模型講出來的。
// 這就是它和 LLM 的分工：
//   LLM      負責聽懂問題、決定要算什麼、把結果講成人話
//   這支程式  負責把數字算對
//
// 所有物性常數集中在下面的表裡，可以驗證、可以版本控制、可以用貴廠的校正值覆寫。
// 用法：node epi_calc.js        （跑內建的自我測試 + 範例）

/* ==========================================================
   材料常數（300 K 的典型文獻值）
   a: 晶格常數 [Å]　Eg: 能隙 [eV]　gap: 直接/間接
   ⚠ 這是一張「可以被修正的表」——這正是專家系統相對於 LLM 的優點。
      各廠若有自己的校正值，改這裡即可，不必重訓任何東西。
   ========================================================== */
const MATERIALS = {
  GaAs: { a: 5.65325, Eg: 1.424, gap: '直接' },
  AlAs: { a: 5.6611, Eg: 3.003, gap: '直接(Γ)，實際為間接，此處取 Γ 谷' },
  InAs: { a: 6.0583, Eg: 0.354, gap: '直接' },
  InP:  { a: 5.8687, Eg: 1.344, gap: '直接' },
  GaP:  { a: 5.4505, Eg: 2.780, gap: '直接(Γ)，實際為間接，此處取 Γ 谷' },
};

// 三元合金的能隙彎曲參數 b [eV]：Eg(x) = x·EgA + (1-x)·EgB - b·x(1-x)
const BOWING = {
  'AlAs-GaAs': 0.37,   // AlxGa1-xAs
  'InAs-GaAs': 0.477,  // InxGa1-xAs
  'InAs-InP':  0.10,   // InAsxP1-x（近似）
  'GaP-GaAs':  0.19,   // GaAsxP1-x（近似）
};

// 前驅物蒸氣壓：log10(P[Torr]) = A - B/T[K]
const PRECURSORS = {
  TMGa: { A: 8.07,  B: 1703,    group: 'III', name: '三甲基鎵' },
  TMIn: { A: 10.52, B: 3014,    group: 'III', name: '三甲基銦' },
  TMAl: { A: 8.224, B: 2134.83, group: 'III', name: '三甲基鋁' },
  TEGa: { A: 8.083, B: 2162,    group: 'III', name: '三乙基鎵' },
};

const PLANCK_EV_NM = 1239.84;  // hc [eV·nm]

/* ==========================================================
   1. Vegard 定律：三元合金的晶格常數
   ========================================================== */
function latticeConstant(matA, matB, x) {
  const A = MATERIALS[matA], B = MATERIALS[matB];
  if (!A || !B) throw new Error(`未知材料：${matA} / ${matB}`);
  if (x < 0 || x > 1) throw new Error('組成 x 必須介於 0 和 1');
  return x * A.a + (1 - x) * B.a;
}

/* ==========================================================
   2. 能隙（含彎曲參數）
   ========================================================== */
function bandgap(matA, matB, x) {
  const A = MATERIALS[matA], B = MATERIALS[matB];
  if (!A || !B) throw new Error(`未知材料：${matA} / ${matB}`);
  const b = BOWING[`${matA}-${matB}`] ?? BOWING[`${matB}-${matA}`] ?? 0;
  return x * A.Eg + (1 - x) * B.Eg - b * x * (1 - x);
}

/* ==========================================================
   3. 能隙 ↔ 發光波長
   ========================================================== */
const egToWavelength = (Eg) => PLANCK_EV_NM / Eg;      // eV → nm
const wavelengthToEg = (nm) => PLANCK_EV_NM / nm;      // nm → eV

/* ==========================================================
   4. 晶格不匹配度
   ========================================================== */
function mismatch(aEpi, aSub) {
  return (aEpi - aSub) / aSub;   // 回傳比例，×100 就是 %
}

/* ==========================================================
   5. 找出與某基板晶格匹配的組成（二分搜尋，不用解析解）
   ========================================================== */
function latticeMatchedComposition(matA, matB, substrate) {
  const aSub = MATERIALS[substrate].a;
  let lo = 0, hi = 1;
  const f = (x) => latticeConstant(matA, matB, x) - aSub;
  if (f(0) * f(1) > 0) return null;             // 這個組合湊不出匹配
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/* ==========================================================
   6. Matthews-Blakeslee 臨界厚度（60° 差排，閃鋅礦結構）
      h_c = b(1-ν·cos²α) / (8π·f·(1+ν)·cosλ) × (ln(h_c/b)+1)   ← 隱式，迭代解
   ========================================================== */
function criticalThickness(f, aEpi, opts) {
  const nu = (opts && opts.nu) || 0.33;          // 帕松比
  const absF = Math.abs(f);
  if (absF < 1e-6) return Infinity;              // 完全匹配
  const b = aEpi / Math.SQRT2;                   // Burgers 向量 a/2<110>
  const cos2a = 0.25, cosL = 0.5;                // α = λ = 60°
  const pre = b * (1 - nu * cos2a) / (8 * Math.PI * absF * (1 + nu) * cosL);
  let h = b * 2;
  for (let i = 0; i < 200; i++) {
    const next = pre * (Math.log(h / b) + 1);
    if (next <= 0) return 0;
    if (Math.abs(next - h) < 1e-9) break;
    h = next;
  }
  return h;                                      // [Å]
}

/* ==========================================================
   7. Bubbler 的莫耳流量
      P_v(T) = 10^(A - B/T)  [Torr]
      F = P_v/(P_bub - P_v) × F_carrier  [sccm] → mol/min
   ========================================================== */
function vaporPressure(precursor, tempC) {
  const p = PRECURSORS[precursor];
  if (!p) throw new Error(`未知前驅物：${precursor}`);
  return Math.pow(10, p.A - p.B / (tempC + 273.15));   // Torr
}

function bubblerMolarFlow(precursor, tempC, bubblerPressureTorr, carrierSccm) {
  const Pv = vaporPressure(precursor, tempC);
  if (Pv >= bubblerPressureTorr) {
    throw new Error(`蒸氣壓 ${Pv.toFixed(1)} Torr 已達或超過 bubbler 壓力 ${bubblerPressureTorr} Torr——設定不合理`);
  }
  const sccm = (Pv / (bubblerPressureTorr - Pv)) * carrierSccm;
  return { vaporPressureTorr: Pv, precursorSccm: sccm, umolPerMin: (sccm / 22414) * 1e6 };
}

/* ==========================================================
   8. V/III 比
   ========================================================== */
function vIIIRatio(groupVumol, groupIIIumol) {
  if (groupIIIumol <= 0) throw new Error('三族流量必須大於 0');
  return groupVumol / groupIIIumol;
}

// 氣體（AsH3 / PH3）直接由 sccm 換算，可含稀釋濃度
const gasUmolPerMin = (sccm, concentration) => (sccm * (concentration === undefined ? 1 : concentration) / 22414) * 1e6;

/* ==========================================================
   9. 機台參數表
      ⚠ 這裡刻意留空。Aixtron G3/G4 之類的機台參數，各廠的配置、
        recipe 與校正值都不同，而且多屬廠商／製程機密——由模型「生成」
        這些數字正是最危險的用法。請填入貴廠自己量到的值。
        填好之後，它就從「模型可能記錯的東西」變成「查表查得到的事實」。
   ========================================================== */
const MACHINES = {
  // 範例格式（數值請自行以實機填寫，以下為佔位）：
  // 'AIX-G4-01': {
  //   reactorType: 'planetary',
  //   waferConfig: '',           // 例：'8×4 吋'
  //   susceptorRpmRange: [null, null],
  //   pressureRangeMbar: [null, null],
  //   tempRangeC: [null, null],
  //   bubblers: { TMGa: { tempC: null, pressureTorr: null } },
  //   lastCalibration: '',
  // },
};

function machineParam(id, path) {
  const m = MACHINES[id];
  if (!m) return { ok: false, reason: `機台 ${id} 不在參數表裡。請先在 epi_calc.js 的 MACHINES 填入實機資料——不要用猜的。` };
  const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), m);
  if (val === undefined || val === null) return { ok: false, reason: `機台 ${id} 的 ${path} 尚未填寫。` };
  return { ok: true, value: val };
}

module.exports = {
  MATERIALS, BOWING, PRECURSORS, MACHINES,
  latticeConstant, bandgap, egToWavelength, wavelengthToEg, mismatch,
  latticeMatchedComposition, criticalThickness,
  vaporPressure, bubblerMolarFlow, vIIIRatio, gasUmolPerMin, machineParam,
};

/* ==========================================================
   自我測試 + 範例
   ========================================================== */
if (require.main === module) {
  const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
  let pass = 0, fail = 0;
  function check(name, got, want, tol) {
    const ok = Math.abs(got - want) <= tol;
    console.log(`  ${ok ? '✓' : '✗'} ${name}：算出 ${round(got, 4)}，預期 ${want} ±${tol}`);
    ok ? pass++ : fail++;
  }

  console.log('=== 自我測試（拿已知的物理事實當基準）===');
  check('GaAs 晶格常數', latticeConstant('GaAs', 'GaAs', 1), 5.65325, 1e-5);
  check('InGaAs 與 InP 晶格匹配的 In 組成（課本值 0.53）',
        latticeMatchedComposition('InAs', 'GaAs', 'InP'), 0.532, 0.01);
  const xm = latticeMatchedComposition('InAs', 'GaAs', 'InP');
  check('該組成的能隙 [eV]（文獻約 0.75）', bandgap('InAs', 'GaAs', xm), 0.75, 0.03);
  check('該組成的發光波長 [nm]（文獻約 1650）',
        egToWavelength(bandgap('InAs', 'GaAs', xm)), 1650, 60);
  check('Al0.3Ga0.7As 能隙 [eV]（Vurgaftman 約 1.80）', bandgap('AlAs', 'GaAs', 0.3), 1.80, 0.04);
  check('TMGa 在 0 °C 的蒸氣壓 [Torr]（文獻約 65）', vaporPressure('TMGa', 0), 65, 5);
  console.log(`  → ${pass} 過 / ${fail} 失敗\n`);

  console.log('=== 範例 1：砷化鋁鎵（模型剛剛答錯的那一題）===');
  for (const x of [0, 0.1, 0.3, 0.5, 1]) {
    const a = latticeConstant('AlAs', 'GaAs', x);
    const eg = bandgap('AlAs', 'GaAs', x);
    const f = mismatch(a, MATERIALS.GaAs.a);
    console.log(`  Al${x}Ga${round(1 - x, 2)}As：晶格 ${round(a, 5)} Å　能隙 ${round(eg, 3)} eV　` +
      `波長 ${round(egToWavelength(eg), 1)} nm　與 GaAs 不匹配 ${round(f * 100, 4)}%`);
  }

  console.log('\n=== 範例 2：應變層的臨界厚度 ===');
  for (const x of [0.05, 0.1, 0.2]) {
    const a = latticeConstant('InAs', 'GaAs', x);
    const f = mismatch(a, MATERIALS.GaAs.a);
    const hc = criticalThickness(f, a);
    console.log(`  In${x}Ga${round(1 - x, 2)}As on GaAs：不匹配 ${round(f * 100, 3)}%　` +
      `臨界厚度 ≈ ${round(hc, 1)} Å（${round(hc / 10, 1)} nm）`);
  }

  console.log('\n=== 範例 3：Bubbler 與 V/III 比 ===');
  const tmga = bubblerMolarFlow('TMGa', -10, 760, 100);
  console.log(`  TMGa @ -10 °C、760 Torr、載氣 100 sccm`);
  console.log(`    蒸氣壓 ${round(tmga.vaporPressureTorr, 2)} Torr　前驅物 ${round(tmga.precursorSccm, 3)} sccm　` +
    `${round(tmga.umolPerMin, 2)} µmol/min`);
  const ash3 = gasUmolPerMin(50, 1);
  console.log(`  AsH3 50 sccm（純）= ${round(ash3, 1)} µmol/min`);
  console.log(`    → V/III = ${round(vIIIRatio(ash3, tmga.umolPerMin), 1)}`);

  console.log('\n=== 範例 4：機台參數（刻意沒有預設值）===');
  const q = machineParam('AIX-G4-01', 'susceptorRpmRange');
  console.log(`  ${q.ok ? q.value : q.reason}`);

  console.log(`
──────────────────────────────────────────────────────────────
上面每一個數字都是「算出來」或「查表查到」的，沒有一個是生成的。
所以它們可以被驗證（見最上面的自我測試），也可以被修正（改常數表即可）。

LLM 在這個架構裡的角色不是回答數字，而是：
  1. 聽懂「Al 三成的 AlGaAs 發光波長是多少」要呼叫哪個函式、參數是什麼
  2. 把 ${'`'}bandgap('AlAs','GaAs',0.3)${'`'} 的結果講成一句人話
  3. 缺參數時反問（例如沒說 bubbler 溫度就不能算 V/III）
數字由這支程式負責，模型不准自己編——這才是「更精準」的真正來源。
──────────────────────────────────────────────────────────────`);
}
