'use strict';
// 專家系統的「工具目錄」——LLM 與確定性計算之間的那道介面。
//
// 真實系統裡 LLM 拿到的不是知識，而是一份像下面這樣的函式清單（function calling / tool use）。
// 模型的工作只有兩件：挑對函式、填對參數。數字一律由程式算，模型只負責轉述。
//
// 用法：
//   node expert.js                      列出所有工具
//   node expert.js --schema             印出可直接餵給 LLM 的 JSON 函式定義
//   node expert.js bandgap AlAs GaAs 0.3
//   node expert.js loanPayment 1000000 0.02 30
//   node expert.js --json bondPrice '{"face":100,"couponRate":0.05,"years":3,"ytm":0.06}'

const epi = require('./epi_calc.js');
const fin = require('./fin_calc.js');

const N = (d) => ({ type: 'number', description: d });
const S = (d) => ({ type: 'string', description: d });
const A = (d) => ({ type: 'array', items: { type: 'number' }, description: d });

/* ==========================================================
   工具目錄：每個項目就是一個「模型可以呼叫，但不能自己編答案」的函式
   ========================================================== */
const TOOLS = [
  // ── III/V 磊晶 ──────────────────────────────────────────
  { name: 'latticeConstant', domain: '磊晶', fn: epi.latticeConstant,
    desc: '用 Vegard 定律算三元合金的晶格常數 [Å]',
    params: { matA: S('端點材料 A，如 AlAs'), matB: S('端點材料 B，如 GaAs'), x: N('A 的莫耳比例 0~1') },
    order: ['matA', 'matB', 'x'] },
  { name: 'bandgap', domain: '磊晶', fn: epi.bandgap,
    desc: '算三元合金的能隙 [eV]（含彎曲參數）',
    params: { matA: S('端點材料 A'), matB: S('端點材料 B'), x: N('A 的莫耳比例 0~1') },
    order: ['matA', 'matB', 'x'] },
  { name: 'bandgapAtTemperature', domain: '磊晶', fn: epi.bandgapAtTemperature,
    desc: '用 Varshni 公式算能隙的溫度相依 [eV]',
    params: { mat: S('材料，如 GaAs'), tempK: N('溫度 [K]') },
    order: ['mat', 'tempK'] },
  { name: 'egToWavelength', domain: '磊晶', fn: epi.egToWavelength,
    desc: '能隙換算成發光波長 [nm]',
    params: { Eg: N('能隙 [eV]') }, order: ['Eg'] },
  { name: 'mismatch', domain: '磊晶', fn: epi.mismatch,
    desc: '晶格不匹配度（比例，×100 為 %）',
    params: { aEpi: N('磊晶層晶格常數 [Å]'), aSub: N('基板晶格常數 [Å]') },
    order: ['aEpi', 'aSub'] },
  { name: 'latticeMatchedComposition', domain: '磊晶', fn: epi.latticeMatchedComposition,
    desc: '找出與某基板晶格匹配的三元組成',
    params: { matA: S('端點 A'), matB: S('端點 B'), substrate: S('基板，如 InP') },
    order: ['matA', 'matB', 'substrate'] },
  { name: 'criticalThickness', domain: '磊晶', fn: epi.criticalThickness,
    desc: 'Matthews-Blakeslee 應變層臨界厚度 [Å]',
    params: { f: N('晶格不匹配度（比例）'), aEpi: N('磊晶層晶格常數 [Å]') },
    order: ['f', 'aEpi'] },
  { name: 'quantumWellEnergy', domain: '磊晶', fn: epi.quantumWellEnergy,
    desc: '量子井基態能階 [eV]（無限深井近似）',
    params: { widthNm: N('井寬 [nm]'), effectiveMass: N('相對有效質量，GaAs 電子約 0.067') },
    order: ['widthNm', 'effectiveMass'] },
  { name: 'braggAngle', domain: '磊晶', fn: (d, w) => epi.braggAngle(d, w),
    desc: 'XRD 的 Bragg 角與 2θ [度]',
    params: { dSpacing: N('晶面間距 [Å]'), wavelengthA: N('X 光波長 [Å]，預設 Cu Kα1 1.5406') },
    order: ['dSpacing', 'wavelengthA'] },
  { name: 'vaporPressure', domain: '磊晶', fn: epi.vaporPressure,
    desc: '前驅物在指定溫度的蒸氣壓 [Torr]',
    params: { precursor: S('前驅物，如 TMGa'), tempC: N('bubbler 溫度 [°C]') },
    order: ['precursor', 'tempC'] },
  { name: 'bubblerMolarFlow', domain: '磊晶', fn: epi.bubblerMolarFlow,
    desc: 'Bubbler 的前驅物莫耳流量 [µmol/min]',
    params: { precursor: S('前驅物'), tempC: N('bubbler 溫度 [°C]'),
              bubblerPressureTorr: N('bubbler 壓力 [Torr]'), carrierSccm: N('載氣流量 [sccm]') },
    order: ['precursor', 'tempC', 'bubblerPressureTorr', 'carrierSccm'] },
  { name: 'vIIIRatio', domain: '磊晶', fn: epi.vIIIRatio,
    desc: 'V/III 比',
    params: { groupVumol: N('五族 [µmol/min]'), groupIIIumol: N('三族 [µmol/min]') },
    order: ['groupVumol', 'groupIIIumol'] },
  { name: 'growthRate', domain: '磊晶', fn: epi.growthRate,
    desc: '成長速率（nm/min、µm/hr、Å/s）',
    params: { thicknessNm: N('厚度 [nm]'), minutes: N('時間 [min]') },
    order: ['thicknessNm', 'minutes'] },
  { name: 'hallCarrierConcentration', domain: '磊晶', fn: epi.hallCarrierConcentration,
    desc: '霍爾量測換算載子濃度 [cm^-3]',
    params: { currentA: N('電流 [A]'), fieldT: N('磁場 [T]'),
              hallVoltageV: N('霍爾電壓 [V]'), thicknessM: N('厚度 [m]') },
    order: ['currentA', 'fieldT', 'hallVoltageV', 'thicknessM'] },
  { name: 'fourPointSheetResistance', domain: '磊晶', fn: epi.fourPointSheetResistance,
    desc: '四點探針片電阻 [Ω/sq]',
    params: { voltageV: N('量到的電壓 [V]'), currentA: N('通入的電流 [A]') },
    order: ['voltageV', 'currentA'] },

  // ── 金融財經 ────────────────────────────────────────────
  { name: 'futureValue', domain: '金融', fn: fin.futureValue,
    desc: '複利終值',
    params: { pv: N('現值'), rate: N('每期利率，5% 填 0.05'), periods: N('期數') },
    order: ['pv', 'rate', 'periods'] },
  { name: 'presentValue', domain: '金融', fn: fin.presentValue,
    desc: '折現現值',
    params: { fv: N('終值'), rate: N('每期折現率'), periods: N('期數') },
    order: ['fv', 'rate', 'periods'] },
  { name: 'cagr', domain: '金融', fn: fin.cagr,
    desc: '年化報酬率 CAGR',
    params: { begin: N('期初值'), end: N('期末值'), years: N('年數') },
    order: ['begin', 'end', 'years'] },
  { name: 'effectiveAnnualRate', domain: '金融', fn: fin.effectiveAnnualRate,
    desc: '名目年利率換算有效年利率',
    params: { nominal: N('名目年利率'), m: N('每年複利次數') },
    order: ['nominal', 'm'] },
  { name: 'realRate', domain: '金融', fn: fin.realRate,
    desc: '實質利率（Fisher 精確式）',
    params: { nominal: N('名目利率'), inflation: N('通膨率') },
    order: ['nominal', 'inflation'] },
  { name: 'loanPayment', domain: '金融', fn: fin.loanPayment,
    desc: '等額本息的每期付款金額',
    params: { principal: N('本金'), annualRate: N('年利率'), years: N('年數'),
              perYear: N('每年期數，預設 12') },
    order: ['principal', 'annualRate', 'years', 'perYear'] },
  { name: 'amortize', domain: '金融', fn: fin.amortize,
    desc: '攤還摘要：月付、已付利息、剩餘本金、總利息',
    params: { principal: N('本金'), annualRate: N('年利率'), years: N('年數'),
              paidPeriods: N('已繳期數'), perYear: N('每年期數，預設 12') },
    order: ['principal', 'annualRate', 'years', 'paidPeriods', 'perYear'] },
  { name: 'npv', domain: '金融', fn: fin.npv,
    desc: '淨現值',
    params: { rate: N('折現率'), cashflows: A('現金流陣列，第 0 期通常為負') },
    order: ['rate', 'cashflows'] },
  { name: 'irr', domain: '金融', fn: fin.irr,
    desc: '內部報酬率',
    params: { cashflows: A('現金流陣列') }, order: ['cashflows'] },
  { name: 'dcfValue', domain: '金融', fn: fin.dcfValue,
    desc: 'DCF 估值（預測期 + Gordon 永續價值）',
    params: { cashflows: A('預測期現金流'), discountRate: N('折現率'), terminalGrowth: N('永續成長率') },
    order: ['cashflows', 'discountRate', 'terminalGrowth'] },
  { name: 'wacc', domain: '金融', fn: fin.wacc,
    desc: '加權平均資金成本',
    params: { equity: N('股權市值'), debt: N('負債'), costEquity: N('股權成本'),
              costDebt: N('負債成本'), taxRate: N('稅率') },
    order: ['equity', 'debt', 'costEquity', 'costDebt', 'taxRate'] },
  { name: 'bondPrice', domain: '金融', fn: fin.bondPrice,
    desc: '債券價格',
    params: { face: N('面額'), couponRate: N('票面利率'), years: N('年限'),
              ytm: N('到期殖利率'), freq: N('每年付息次數，預設 1') },
    order: ['face', 'couponRate', 'years', 'ytm', 'freq'] },
  { name: 'bondYTM', domain: '金融', fn: fin.bondYTM,
    desc: '由債券價格反推到期殖利率',
    params: { price: N('市價'), face: N('面額'), couponRate: N('票面利率'), years: N('年限') },
    order: ['price', 'face', 'couponRate', 'years'] },
  { name: 'bondDuration', domain: '金融', fn: fin.bondDuration,
    desc: '債券的存續期間與凸性',
    params: { face: N('面額'), couponRate: N('票面利率'), years: N('年限'), ytm: N('殖利率') },
    order: ['face', 'couponRate', 'years', 'ytm'] },
  { name: 'blackScholes', domain: '金融', fn: fin.blackScholes,
    desc: 'Black-Scholes 歐式選擇權定價（買權、賣權、Delta）',
    params: { S: N('標的價'), K: N('履約價'), r: N('無風險利率'),
              sigma: N('年化波動度'), T: N('到期年數'), q: N('連續股利率，預設 0') },
    order: ['S', 'K', 'r', 'sigma', 'T', 'q'] },
  { name: 'impliedVol', domain: '金融', fn: fin.impliedVol,
    desc: '由選擇權市價反推隱含波動度',
    params: { marketPrice: N('選擇權市價'), S: N('標的價'), K: N('履約價'),
              r: N('無風險利率'), T: N('到期年數'), isCall: N('買權填 1、賣權填 0') },
    order: ['marketPrice', 'S', 'K', 'r', 'T', 'isCall'] },
  { name: 'sharpe', domain: '金融', fn: fin.sharpe,
    desc: '夏普比率（年化）',
    params: { returns: A('各期報酬率'), riskFreeAnnual: N('年化無風險利率'),
              periodsPerYear: N('每年期數，月資料填 12') },
    order: ['returns', 'riskFreeAnnual', 'periodsPerYear'] },
  { name: 'maxDrawdown', domain: '金融', fn: fin.maxDrawdown,
    desc: '最大回撤',
    params: { prices: A('價格序列') }, order: ['prices'] },
  { name: 'breakEvenUnits', domain: '金融', fn: fin.breakEvenUnits,
    desc: '損益兩平銷量與貢獻邊際',
    params: { fixedCost: N('固定成本'), pricePerUnit: N('單價'), variableCostPerUnit: N('單位變動成本') },
    order: ['fixedCost', 'pricePerUnit', 'variableCostPerUnit'] },
  { name: 'dupontROE', domain: '金融', fn: fin.dupontROE,
    desc: '杜邦分析：ROE 拆成淨利率 × 資產週轉 × 權益乘數',
    params: { netIncome: N('淨利'), revenue: N('營收'), assets: N('總資產'), equity: N('股東權益') },
    order: ['netIncome', 'revenue', 'assets', 'equity'] },
  { name: 'purchasingPower', domain: '金融', fn: fin.purchasingPower,
    desc: '通膨後的實質購買力',
    params: { amount: N('金額'), inflation: N('年通膨率'), years: N('年數') },
    order: ['amount', 'inflation', 'years'] },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/* ==========================================================
   給 LLM 用的 JSON 函式定義（function calling 的標準格式）
   ========================================================== */
function toolSchemas() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: `[${t.domain}] ${t.desc}`,
    parameters: {
      type: 'object',
      properties: t.params,
      required: t.order.filter((k) => !/預設/.test(t.params[k].description || '')),
    },
  }));
}

/* ==========================================================
   依名字呼叫：模型只給名字和參數，執行由這裡負責
   ========================================================== */
function call(name, args) {
  const t = byName.get(name);
  if (!t) {
    return { ok: false, error: `沒有這個工具：${name}。可用的有 ${TOOLS.length} 個，用 node expert.js 列出。` };
  }
  const missing = t.order.filter((k) => args[k] === undefined && !/預設/.test(t.params[k].description || ''));
  if (missing.length) {
    // 這一條很重要：參數不齊時要「問回去」，不是自己填一個看起來合理的數字
    return { ok: false, error: `缺少參數：${missing.join('、')}。請補齊後再算，不要用猜的。` };
  }
  try {
    return { ok: true, tool: name, args, result: t.fn(...t.order.map((k) => args[k])) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { TOOLS, toolSchemas, call };

/* ==========================================================
   CLI
   ========================================================== */
if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv[0] === '--schema') {
    console.log(JSON.stringify(toolSchemas(), null, 2));
    process.exit(0);
  }

  if (!argv.length) {
    const domains = [...new Set(TOOLS.map((t) => t.domain))];
    console.log(`專家系統工具目錄：共 ${TOOLS.length} 個確定性函式\n`);
    for (const d of domains) {
      const list = TOOLS.filter((t) => t.domain === d);
      console.log(`── ${d}（${list.length} 個）` + '─'.repeat(Math.max(0, 46 - d.length * 2)));
      for (const t of list) {
        console.log(`  ${t.name.padEnd(28)} ${t.desc}`);
        console.log(`  ${' '.repeat(28)} 參數：${t.order.join(', ')}`);
      }
      console.log('');
    }
    console.log('用法：node expert.js <工具名> <參數...>');
    console.log('      node expert.js --json <工具名> \'{"參數":值}\'');
    console.log('      node expert.js --schema      （印出給 LLM 的 JSON 函式定義）');
    console.log(`
這份清單就是要交給 LLM 的東西。模型不需要「知道」Black-Scholes 或 Vegard 定律，
它只需要看懂問題、挑對函式、填對參數——算，是程式的事。`);
    process.exit(0);
  }

  let name, args = {};
  if (argv[0] === '--json') {
    name = argv[1];
    args = JSON.parse(argv[2] || '{}');
  } else {
    name = argv[0];
    const t = byName.get(name);
    if (!t) { console.log(`沒有這個工具：${name}`); process.exit(1); }
    // 位置參數：數字就轉成數字，開頭是 [ 的當成陣列
    t.order.forEach((k, i) => {
      const raw = argv[i + 1];
      if (raw === undefined) return;
      if (raw.trim().startsWith('[')) args[k] = JSON.parse(raw);
      else if (raw !== '' && !isNaN(Number(raw))) args[k] = Number(raw);
      else args[k] = raw;
    });
  }

  const out = call(name, args);
  if (!out.ok) { console.log('✗ ' + out.error); process.exit(1); }
  console.log(`${out.tool}(${JSON.stringify(out.args)})`);
  console.log('→ ' + (typeof out.result === 'object'
    ? JSON.stringify(out.result, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v), 2)
    : out.result));
}
