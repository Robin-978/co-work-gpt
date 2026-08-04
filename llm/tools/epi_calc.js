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
  // 閃鋅礦（zinc-blende）III/V
  GaAs: { a: 5.65325, Eg: 1.424, gap: '直接', struct: 'zb' },
  AlAs: { a: 5.6611,  Eg: 3.003, gap: '間接(X)，此處取 Γ 谷', struct: 'zb' },
  InAs: { a: 6.0583,  Eg: 0.354, gap: '直接', struct: 'zb' },
  InP:  { a: 5.8687,  Eg: 1.344, gap: '直接', struct: 'zb' },
  GaP:  { a: 5.4505,  Eg: 2.780, gap: '間接(X)，此處取 Γ 谷', struct: 'zb' },
  AlP:  { a: 5.4672,  Eg: 3.630, gap: '間接(X)，此處取 Γ 谷', struct: 'zb' },
  GaSb: { a: 6.0959,  Eg: 0.726, gap: '直接', struct: 'zb' },
  AlSb: { a: 6.1355,  Eg: 2.386, gap: '間接(X)，此處取 Γ 谷', struct: 'zb' },
  InSb: { a: 6.4794,  Eg: 0.170, gap: '直接', struct: 'zb' },
  // 纖鋅礦（wurtzite）III/N —— a 為基面晶格常數
  GaN:  { a: 3.189, c: 5.185, Eg: 3.44, gap: '直接', struct: 'wz' },
  AlN:  { a: 3.112, c: 4.982, Eg: 6.20, gap: '直接', struct: 'wz' },
  InN:  { a: 3.545, c: 5.703, Eg: 0.64, gap: '直接', struct: 'wz' },
  // 基板用的四族（鑽石結構），拿來比較晶格用
  Si:   { a: 5.4310, Eg: 1.12, gap: '間接', struct: 'dia' },
  Ge:   { a: 5.6579, Eg: 0.66, gap: '間接', struct: 'dia' },
  // 常見的異質基板
  Sapphire: { a: 4.758, c: 12.991, Eg: null, gap: '絕緣體', struct: 'corundum' },
};

// Varshni 參數：Eg(T) = Eg(0) − αT²/(T+β)　（α 單位 eV/K，β 單位 K）
const VARSHNI = {
  GaAs: { Eg0: 1.519, alpha: 5.405e-4, beta: 204 },
  InP:  { Eg0: 1.4236, alpha: 3.63e-4, beta: 162 },
  InAs: { Eg0: 0.417, alpha: 2.76e-4, beta: 93 },
  GaN:  { Eg0: 3.507, alpha: 9.09e-4, beta: 830 },
  AlAs: { Eg0: 3.099, alpha: 8.85e-4, beta: 530 },
};

// X 光源波長 [Å]
const XRAY = { CuKa1: 1.540562, CuKa: 1.5418, CoKa1: 1.788965 };

// 物理常數
const Q = 1.602176634e-19;             // 基本電荷 [C]
const QW_CONST = 0.376035;             // h²/(8·m_e) [eV·nm²]，無限深井用

// 三元合金的能隙彎曲參數 b [eV]：Eg(x) = x·EgA + (1-x)·EgB - b·x(1-x)
const BOWING = {
  'AlAs-GaAs': 0.37,   // AlxGa1-xAs
  'InAs-GaAs': 0.477,  // InxGa1-xAs
  'InAs-InP':  0.10,   // InAsxP1-x（近似）
  'GaP-GaAs':  0.19,   // GaAsxP1-x（近似）
  'InN-GaN':   1.40,   // InxGa1-xN
  'AlN-GaN':   0.70,   // AlxGa1-xN
  'AlSb-GaSb': 0.47,   // AlxGa1-xSb
  'InSb-InAs': 0.58,   // InAsxSb1-x（近似）
};

// 前驅物蒸氣壓：log10(P[Torr]) = A - B/T[K]
const PRECURSORS = {
  TMGa: { A: 8.07,  B: 1703,    group: 'III', name: '三甲基鎵' },
  TMIn: { A: 10.52, B: 3014,    group: 'III', name: '三甲基銦' },
  TMAl: { A: 8.224, B: 2134.83, group: 'III', name: '三甲基鋁' },
  TEGa: { A: 8.083, B: 2162,    group: 'III', name: '三乙基鎵' },
  TMSb: { A: 7.7068, B: 1697,   group: 'V',   name: '三甲基銻' },
  DMZn: { A: 7.802, B: 1560,    group: '摻雜', name: '二甲基鋅（p 型）' },
  DEZn: { A: 8.28,  B: 2109,    group: '摻雜', name: '二乙基鋅（p 型）' },
  CBr4: { A: 7.83,  B: 1900,    group: '摻雜', name: '四溴化碳（碳摻雜）' },
};

const PLANCK_EV_NM = 1239.84;  // hc [eV·nm]

/* ==========================================================
   1. Vegard 定律：三元合金的晶格常數
   ========================================================== */
function requirePair(matA, matB) {
  const A = MATERIALS[matA], B = MATERIALS[matB];
  if (!A) throw new Error(`未知材料：${matA}（可用：${Object.keys(MATERIALS).join(', ')}）`);
  if (!B) throw new Error(`未知材料：${matB}（可用：${Object.keys(MATERIALS).join(', ')}）`);
  // 不同晶體結構不能用 Vegard 內插——這種組合根本不成合金，直接擋掉
  if (A.struct !== B.struct) {
    throw new Error(`${matA}(${A.struct}) 與 ${matB}(${B.struct}) 晶體結構不同，不能用 Vegard 內插`);
  }
  return [A, B];
}

function latticeConstant(matA, matB, x) {
  const [A, B] = requirePair(matA, matB);
  if (x < 0 || x > 1) throw new Error('組成 x 必須介於 0 和 1');
  return x * A.a + (1 - x) * B.a;
}

/* ==========================================================
   2. 能隙（含彎曲參數）
   ========================================================== */
function bandgap(matA, matB, x) {
  const [A, B] = requirePair(matA, matB);
  const b = BOWING[`${matA}-${matB}`] ?? BOWING[`${matB}-${matA}`] ?? 0;
  return x * A.Eg + (1 - x) * B.Eg - b * x * (1 - x);
}

/* ==========================================================
   2b. 能隙的溫度相依（Varshni）
       Eg(T) = Eg(0) − αT² / (T + β)
       磊晶是在 600~750 °C 成長、在室溫量測的，這條式子解釋了
       「為什麼成長溫度飄一點，室溫量到的波長就跟著變」。
   ========================================================== */
function bandgapAtTemperature(mat, tempK) {
  const v = VARSHNI[mat];
  if (!v) throw new Error(`${mat} 沒有 Varshni 參數（目前有：${Object.keys(VARSHNI).join(', ')}）`);
  return v.Eg0 - v.alpha * tempK * tempK / (tempK + v.beta);
}

/* ==========================================================
   2c. 四元合金 A(x)B(1-x)C(y)D(1-y) 的晶格常數（雙線性 Vegard）
       典型用途：InGaAsP 要長在 InP 上，Ga 組成該配多少
   ========================================================== */
function quaternaryLattice(binaries, x, y) {
  // binaries = { AC, AD, BC, BD }，都是 MATERIALS 裡的鍵名
  const g = (k) => {
    const m = MATERIALS[binaries[k]];
    if (!m) throw new Error(`未知材料：${binaries[k]}`);
    return m.a;
  };
  return (1 - x) * y * g('AC') + (1 - x) * (1 - y) * g('AD')
       + x * y * g('BC') + x * (1 - y) * g('BD');
}

// 給定 y（例如 As 的比例），解出讓四元與基板匹配的 x
function quaternaryMatchedX(binaries, y, substrate) {
  const aSub = MATERIALS[substrate].a;
  const f = (x) => quaternaryLattice(binaries, x, y) - aSub;
  const f0 = f(0), f1 = f(1);
  if (f0 * f1 > 0) return null;
  return f0 / (f0 - f1);            // 對 x 是線性的，可以直接解
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
   8b. XRD：Bragg 條件與晶面間距
   ========================================================== */
const dSpacingCubic = (a, h, k, l) => a / Math.sqrt(h * h + k * k + l * l);

function braggAngle(dSpacing, wavelengthA, order) {
  const n = order || 1;
  const sinT = n * (wavelengthA || XRAY.CuKa1) / (2 * dSpacing);
  if (Math.abs(sinT) > 1) throw new Error('sinθ > 1，這個晶面在這個波長下量不到');
  const th = Math.asin(sinT);
  return { thetaDeg: th * 180 / Math.PI, twoThetaDeg: 2 * th * 180 / Math.PI };
}

/* ==========================================================
   8c. 量子井的基態能階（無限深井近似）
       E_n = n²·h²/(8·m*·L²)，用來估「井做多薄，波長會藍移多少」
   ========================================================== */
function quantumWellEnergy(widthNm, effectiveMass, level) {
  const n = level || 1;
  if (widthNm <= 0 || effectiveMass <= 0) throw new Error('井寬與有效質量必須大於 0');
  return n * n * QW_CONST / (effectiveMass * widthNm * widthNm);   // [eV]
}

/* ==========================================================
   8d. 電性量測
   ========================================================== */
// 霍爾量測 → 載子濃度 [cm^-3]（厚度 m、電流 A、磁場 T、霍爾電壓 V）
function hallCarrierConcentration(currentA, fieldT, hallVoltageV, thicknessM) {
  if (hallVoltageV === 0) throw new Error('霍爾電壓不能為 0');
  const nSI = (currentA * fieldT) / (Q * thicknessM * Math.abs(hallVoltageV));  // m^-3
  return nSI / 1e6;                                                            // cm^-3
}
// 霍爾係數與電阻率 → 遷移率 [cm²/V·s]
const mobilityFromHall = (hallCoeffCm3PerC, resistivityOhmCm) => hallCoeffCm3PerC / resistivityOhmCm;

// 四點探針（薄片近似）：Rs = (π/ln2)·(V/I)
const fourPointSheetResistance = (voltageV, currentA) => (Math.PI / Math.LN2) * (voltageV / currentA);
// 片電阻 ↔ 電阻率
const sheetResistance = (resistivityOhmCm, thicknessCm) => resistivityOhmCm / thicknessCm;
const resistivityFromSheet = (sheetOhmSq, thicknessCm) => sheetOhmSq * thicknessCm;

/* ==========================================================
   8e. 成長速率
   ========================================================== */
function growthRate(thicknessNm, minutes) {
  if (minutes <= 0) throw new Error('時間必須大於 0');
  const nmPerMin = thicknessNm / minutes;
  return { nmPerMin, umPerHour: nmPerMin * 60 / 1000, aPerSec: nmPerMin * 10 / 60 };
}

// 應變層的面內應變（磊晶被基板拉/壓）
const inPlaneStrain = (aEpi, aSub) => (aSub - aEpi) / aEpi;

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
  MATERIALS, BOWING, PRECURSORS, MACHINES, VARSHNI, XRAY,
  latticeConstant, bandgap, bandgapAtTemperature, egToWavelength, wavelengthToEg, mismatch,
  latticeMatchedComposition, criticalThickness, inPlaneStrain,
  quaternaryLattice, quaternaryMatchedX,
  vaporPressure, bubblerMolarFlow, vIIIRatio, gasUmolPerMin, machineParam,
  dSpacingCubic, braggAngle, quantumWellEnergy,
  hallCarrierConcentration, mobilityFromHall, fourPointSheetResistance,
  sheetResistance, resistivityFromSheet, growthRate,
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
  check('Varshni：GaAs 在 300 K 的能隙（表值 1.424）', bandgapAtTemperature('GaAs', 300), 1.424, 0.01);
  check('Varshni：GaN 在 300 K 的能隙（表值 3.44）', bandgapAtTemperature('GaN', 300), 3.44, 0.01);
  check('InGaAsP(y=1) 匹配 InP 的 Ga 組成應等於 0.47',
        quaternaryMatchedX({ AC: 'InAs', AD: 'InP', BC: 'GaAs', BD: 'GaP' }, 1, 'InP'), 0.468, 0.005);
  check('GaAs (004) 的 2θ [度]（Cu Kα1，文獻約 66.05）',
        braggAngle(dSpacingCubic(MATERIALS.GaAs.a, 0, 0, 4)).twoThetaDeg, 66.05, 0.1);
  check('10 nm GaAs 量子井的電子基態 [eV]（m*=0.067，課本約 0.056）',
        quantumWellEnergy(10, 0.067), 0.056, 0.001);
  check('四點探針修正係數 π/ln2（V/I = 1 Ω）', fourPointSheetResistance(1, 1), 4.5324, 0.001);
  check('成長 2 µm 費時 60 分 → µm/hr', growthRate(2000, 60).umPerHour, 2.0, 1e-9);
  // 這一項測的是「該擋的要擋下來」：閃鋅礦和纖鋅礦不能混
  let blocked = false;
  try { latticeConstant('GaAs', 'GaN', 0.5); } catch (e) { blocked = true; }
  console.log(`  ${blocked ? '✓' : '✗'} GaAs(閃鋅礦) 與 GaN(纖鋅礦) 混用應被擋下`);
  blocked ? pass++ : fail++;
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

  console.log('\n=== 範例 4：成長溫度飄移對室溫波長的影響（Varshni）===');
  for (const T of [293, 300, 350]) {
    const eg = bandgapAtTemperature('GaAs', T);
    console.log(`  GaAs @ ${T} K：能隙 ${round(eg, 4)} eV　波長 ${round(egToWavelength(eg), 1)} nm`);
  }

  console.log('\n=== 範例 5：InGaAsP 長在 InP 上（四元匹配）===');
  const QB = { AC: 'InAs', AD: 'InP', BC: 'GaAs', BD: 'GaP' };
  for (const y of [0.4, 0.7, 1.0]) {
    const x = quaternaryMatchedX(QB, y, 'InP');
    console.log(`  As 比例 y=${y}：Ga 組成 x=${round(x, 4)}　晶格 ${round(quaternaryLattice(QB, x, y), 5)} Å（InP 為 5.8687）`);
  }

  console.log('\n=== 範例 6：XRD 與量子井 ===');
  for (const m of ['GaAs', 'InP', 'Ge']) {
    const d = dSpacingCubic(MATERIALS[m].a, 0, 0, 4);
    console.log(`  ${m} (004)：d = ${round(d, 5)} Å　2θ = ${round(braggAngle(d).twoThetaDeg, 3)}°`);
  }
  for (const w of [3, 5, 10]) {
    const e = quantumWellEnergy(w, 0.067);
    console.log(`  ${w} nm GaAs 井：電子基態 ${round(e * 1000, 1)} meV　→ 相對塊材藍移 ${round(egToWavelength(1.424) - egToWavelength(1.424 + e), 1)} nm`);
  }

  console.log('\n=== 範例 7：機台參數（刻意沒有預設值）===');
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
