'use strict';
// 金融／財經的「專家系統」核心：確定性計算，不是生成。
//
// 和 epi_calc.js 同一個哲學：
//   凡是「算得出來」的東西，就不該讓模型用背的。
//   複利、房貸月付、IRR、債券價格、選擇權定價——這些都是函數，不是可以記憶的事實。
//
// 用法：node fin_calc.js       （自我測試 + 範例）

/* ==========================================================
   基礎工具
   ========================================================== */
// 標準常態累積分布（Abramowitz & Stegun 26.2.17，誤差 < 7.5e-8）
function normCdf(x) {
  if (x < 0) return 1 - normCdf(-x);
  const b = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const p = 0.2316419, c = 0.3989422804014327;   // 1/sqrt(2π)
  const t = 1 / (1 + p * x);
  let poly = 0;
  for (let i = b.length - 1; i >= 0; i--) poly = (poly + b[i]) * t;
  return 1 - c * Math.exp(-x * x / 2) * poly;
}

// 通用二分求根：在 [lo, hi] 找 f(x)=0
function bisect(f, lo, hi, tol, maxIter) {
  tol = tol || 1e-10; maxIter = maxIter || 200;
  let flo = f(lo), fhi = f(hi);
  if (flo * fhi > 0) return null;                 // 區間內沒有根
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < tol || (hi - lo) / 2 < tol) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/* ==========================================================
   1. 貨幣的時間價值
   ========================================================== */
const futureValue = (pv, rate, periods) => pv * Math.pow(1 + rate, periods);
const presentValue = (fv, rate, periods) => fv / Math.pow(1 + rate, periods);

// 年金現值：每期收付 pmt，共 n 期
function annuityPV(pmt, rate, periods) {
  if (rate === 0) return pmt * periods;
  return pmt * (1 - Math.pow(1 + rate, -periods)) / rate;
}
// 年金終值
function annuityFV(pmt, rate, periods) {
  if (rate === 0) return pmt * periods;
  return pmt * (Math.pow(1 + rate, periods) - 1) / rate;
}

// 名目年利率 → 有效年利率（每年複利 m 次）
const effectiveAnnualRate = (nominal, m) => Math.pow(1 + nominal / m, m) - 1;

// 實質利率（Fisher 精確式，不是 i − π 的近似）
const realRate = (nominal, inflation) => (1 + nominal) / (1 + inflation) - 1;

// 本金翻倍要幾年：72 法則 vs 精確解
function doublingTime(rate) {
  return { rule72: 72 / (rate * 100), exact: Math.log(2) / Math.log(1 + rate) };
}

// 年化報酬率 CAGR
const cagr = (begin, end, years) => Math.pow(end / begin, 1 / years) - 1;

/* ==========================================================
   2. 貸款／攤還
   ========================================================== */
// 等額本息月付金
function loanPayment(principal, annualRate, years, perYear) {
  perYear = perYear || 12;
  const r = annualRate / perYear, n = years * perYear;
  if (r === 0) return principal / n;
  return principal * r / (1 - Math.pow(1 + r, -n));
}

// 攤還摘要：付了 k 期之後的剩餘本金、已付利息
function amortize(principal, annualRate, years, paidPeriods, perYear) {
  perYear = perYear || 12;
  const r = annualRate / perYear, n = years * perYear;
  const pmt = loanPayment(principal, annualRate, years, perYear);
  let bal = principal, interestPaid = 0, principalPaid = 0;
  for (let i = 0; i < Math.min(paidPeriods, n); i++) {
    const interest = bal * r;
    const princ = pmt - interest;
    interestPaid += interest; principalPaid += princ; bal -= princ;
  }
  return {
    payment: pmt, remaining: Math.max(0, bal),
    interestPaid, principalPaid,
    totalInterest: pmt * n - principal,
  };
}

/* ==========================================================
   3. 投資評估
   ========================================================== */
// 淨現值：cashflows[0] 是第 0 期（通常為負的投資額）
function npv(rate, cashflows) {
  let s = 0;
  for (let t = 0; t < cashflows.length; t++) s += cashflows[t] / Math.pow(1 + rate, t);
  return s;
}
// 內部報酬率：讓 NPV = 0 的折現率
function irr(cashflows) {
  return bisect((r) => npv(r, cashflows), -0.9999, 10);
}
// 回收期（線性內插）
function paybackPeriod(cashflows) {
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const prev = cum; cum += cashflows[t];
    if (prev < 0 && cum >= 0) return t - 1 + (-prev) / cashflows[t];
  }
  return null;                                    // 期間內回收不了
}

// DCF 估值：預測期現金流 + Gordon 成長永續價值
function dcfValue(cashflows, discountRate, terminalGrowth) {
  if (terminalGrowth >= discountRate) throw new Error('永續成長率必須小於折現率，否則估值發散');
  const n = cashflows.length;
  const last = cashflows[n - 1];
  const terminal = last * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  let pv = 0;
  for (let t = 0; t < n; t++) pv += cashflows[t] / Math.pow(1 + discountRate, t + 1);
  const pvTerminal = terminal / Math.pow(1 + discountRate, n);
  return { pvExplicit: pv, terminalValue: terminal, pvTerminal, total: pv + pvTerminal };
}

// 加權平均資金成本
function wacc(equity, debt, costEquity, costDebt, taxRate) {
  const v = equity + debt;
  return (equity / v) * costEquity + (debt / v) * costDebt * (1 - taxRate);
}

/* ==========================================================
   4. 債券
   ========================================================== */
// 債券價格（每年付息 freq 次）
function bondPrice(face, couponRate, years, ytm, freq) {
  freq = freq || 1;
  const n = Math.round(years * freq), c = face * couponRate / freq, y = ytm / freq;
  let p = 0;
  for (let t = 1; t <= n; t++) p += c / Math.pow(1 + y, t);
  return p + face / Math.pow(1 + y, n);
}
// 到期殖利率：由價格反推
function bondYTM(price, face, couponRate, years, freq) {
  freq = freq || 1;
  return bisect((y) => bondPrice(face, couponRate, years, y, freq) - price, -0.99, 5);
}
// 存續期間與凸性
function bondDuration(face, couponRate, years, ytm, freq) {
  freq = freq || 1;
  const n = Math.round(years * freq), c = face * couponRate / freq, y = ytm / freq;
  let price = 0, wSum = 0, cSum = 0;
  for (let t = 1; t <= n; t++) {
    const cf = t === n ? c + face : c;
    const pv = cf / Math.pow(1 + y, t);
    price += pv; wSum += (t / freq) * pv;
    cSum += pv * (t / freq) * (t / freq + 1 / freq);
  }
  const macaulay = wSum / price;
  return {
    price, macaulay,
    modified: macaulay / (1 + y),
    convexity: cSum / (price * Math.pow(1 + y, 2)),
  };
}

/* ==========================================================
   5. 風險與績效
   ========================================================== */
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function stdev(a, sample) {
  const m = mean(a);
  const denom = (sample === false ? a.length : a.length - 1);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / denom);
}
// 夏普比率（periodsPerYear 用來年化，例如日資料 252、月資料 12）
function sharpe(returns, riskFreeAnnual, periodsPerYear) {
  const rf = riskFreeAnnual / periodsPerYear;
  const excess = returns.map((r) => r - rf);
  return (mean(excess) / stdev(excess)) * Math.sqrt(periodsPerYear);
}
// 年化波動度
const annualVol = (returns, periodsPerYear) => stdev(returns) * Math.sqrt(periodsPerYear);

// 最大回撤（吃價格序列）
function maxDrawdown(prices) {
  let peak = prices[0], mdd = 0, peakAt = 0, troughAt = 0, curPeakAt = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > peak) { peak = prices[i]; curPeakAt = i; }
    const dd = (peak - prices[i]) / peak;
    if (dd > mdd) { mdd = dd; peakAt = curPeakAt; troughAt = i; }
  }
  return { maxDrawdown: mdd, peakIndex: peakAt, troughIndex: troughAt };
}

/* ==========================================================
   6. 選擇權（Black-Scholes，歐式，含連續股利率 q）
   ========================================================== */
function blackScholes(S, K, r, sigma, T, q) {
  q = q || 0;
  if (T <= 0 || sigma <= 0) throw new Error('到期時間與波動度必須大於 0');
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / sq;
  const d2 = d1 - sq;
  const call = S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  const put = K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
  return {
    call, put, d1, d2,
    deltaCall: Math.exp(-q * T) * normCdf(d1),
    deltaPut: Math.exp(-q * T) * (normCdf(d1) - 1),
  };
}
// 隱含波動度：由市價反推
function impliedVol(marketPrice, S, K, r, T, isCall) {
  const f = (s) => (isCall === false ? blackScholes(S, K, r, s, T).put : blackScholes(S, K, r, s, T).call) - marketPrice;
  return bisect(f, 1e-6, 5);
}

/* ==========================================================
   7. 營運財務
   ========================================================== */
// 損益兩平銷量
function breakEvenUnits(fixedCost, pricePerUnit, variableCostPerUnit) {
  const cm = pricePerUnit - variableCostPerUnit;
  if (cm <= 0) throw new Error('單位貢獻邊際必須大於 0（售價要高於變動成本）');
  return { units: fixedCost / cm, contributionMargin: cm, marginRatio: cm / pricePerUnit };
}
// 杜邦分析：ROE = 淨利率 × 總資產週轉率 × 權益乘數
function dupontROE(netIncome, revenue, assets, equity) {
  const netMargin = netIncome / revenue;
  const assetTurnover = revenue / assets;
  const leverage = assets / equity;
  return { netMargin, assetTurnover, leverage, roe: netMargin * assetTurnover * leverage };
}
// 稅後報酬
const afterTaxReturn = (grossReturn, taxRate) => grossReturn * (1 - taxRate);
// 通膨後的購買力
const purchasingPower = (amount, inflation, years) => amount / Math.pow(1 + inflation, years);
// 交叉匯率：已知 A/B 與 C/B，求 A/C
const crossRate = (aPerB, cPerB) => aPerB / cPerB;

module.exports = {
  normCdf, bisect,
  futureValue, presentValue, annuityPV, annuityFV, effectiveAnnualRate, realRate, doublingTime, cagr,
  loanPayment, amortize,
  npv, irr, paybackPeriod, dcfValue, wacc,
  bondPrice, bondYTM, bondDuration,
  mean, stdev, sharpe, annualVol, maxDrawdown,
  blackScholes, impliedVol,
  breakEvenUnits, dupontROE, afterTaxReturn, purchasingPower, crossRate,
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

  console.log('=== 自我測試（拿課本上的標準答案當基準）===');
  check('1000 元以 5% 複利 10 年', futureValue(1000, 0.05, 10), 1628.8946, 0.001);
  check('CAGR：100 → 200 歷時 5 年', cagr(100, 200, 5), 0.148698, 1e-5);
  check('名目 12%、每月複利的有效年利率', effectiveAnnualRate(0.12, 12), 0.126825, 1e-5);
  check('名目 5%、通膨 2% 的實質利率', realRate(0.05, 0.02), 0.029412, 1e-5);
  check('8% 本金翻倍所需年數（精確）', doublingTime(0.08).exact, 9.0065, 0.001);
  check('房貸 100 萬、年利 2%、30 年的月付金', loanPayment(1e6, 0.02, 30), 3696.19, 0.05);
  check('IRR：[-1000, 400, 400, 400]', irr([-1000, 400, 400, 400]), 0.09701, 1e-4);
  check('債券價格：面額 100、票息 5%、3 年、YTM 6%', bondPrice(100, 0.05, 3, 0.06), 97.3270, 0.001);
  check('該債券的 Macaulay 存續期間', bondDuration(100, 0.05, 3, 0.06).macaulay, 2.8573, 0.001);
  check('該債券的修正存續期間', bondDuration(100, 0.05, 3, 0.06).modified, 2.6956, 0.001);
  check('由價格反推 YTM 應回到 6%', bondYTM(97.3270, 100, 0.05, 3), 0.06, 1e-5);
  check('Black-Scholes 買權 S=K=100 r=5% σ=20% T=1', blackScholes(100, 100, 0.05, 0.2, 1).call, 10.4506, 0.001);
  check('同上的賣權（買賣權平價）', blackScholes(100, 100, 0.05, 0.2, 1).put, 5.5735, 0.001);
  check('由買權市價反推隱含波動度應回到 20%', impliedVol(10.4506, 100, 100, 0.05, 1, true), 0.20, 1e-4);
  check('常態 CDF：N(0)', normCdf(0), 0.5, 1e-9);
  check('常態 CDF：N(1.96)', normCdf(1.96), 0.975, 1e-4);
  console.log(`  → ${pass} 過 / ${fail} 失敗\n`);

  console.log('=== 範例 1：房貸 ===');
  const a = amortize(1e6, 0.02, 30, 60);
  console.log(`  100 萬、年利 2%、30 年：月付 ${round(a.payment, 2)} 元`);
  console.log(`  繳滿 5 年（60 期）後：已還本金 ${round(a.principalPaid, 0)}、已付利息 ${round(a.interestPaid, 0)}、剩餘本金 ${round(a.remaining, 0)}`);
  console.log(`  整段期間的總利息 ${round(a.totalInterest, 0)} 元（本金的 ${round(a.totalInterest / 1e6 * 100, 1)}%）`);

  console.log('\n=== 範例 2：投資案評估 ===');
  const cf = [-5000, 1500, 1800, 2000, 2200];
  console.log(`  現金流 ${JSON.stringify(cf)}`);
  console.log(`  折現率 8% 的 NPV = ${round(npv(0.08, cf), 2)}　IRR = ${round(irr(cf) * 100, 2)}%　回收期 ${round(paybackPeriod(cf), 2)} 年`);

  console.log('\n=== 範例 3：利率變動對債券的衝擊 ===');
  const d = bondDuration(100, 0.05, 10, 0.04);
  console.log(`  面額 100、票息 5%、10 年、YTM 4%：價格 ${round(d.price, 3)}`);
  console.log(`  修正存續期間 ${round(d.modified, 3)}　凸性 ${round(d.convexity, 2)}`);
  const dy = 0.01;
  const approx = -d.modified * dy + 0.5 * d.convexity * dy * dy;
  const actual = (bondPrice(100, 0.05, 10, 0.05) - d.price) / d.price;
  console.log(`  殖利率上升 1%：存續期間+凸性估計 ${round(approx * 100, 3)}%，實際 ${round(actual * 100, 3)}%`);

  console.log('\n=== 範例 4：選擇權與績效 ===');
  const bs = blackScholes(100, 105, 0.03, 0.25, 0.5);
  console.log(`  S=100 K=105 r=3% σ=25% T=0.5：買權 ${round(bs.call, 4)}　賣權 ${round(bs.put, 4)}　Delta ${round(bs.deltaCall, 4)}`);
  const rets = [0.012, -0.008, 0.021, -0.015, 0.009, 0.004, -0.003, 0.017, -0.011, 0.006, 0.002, 0.013];
  console.log(`  12 期月報酬：年化波動 ${round(annualVol(rets, 12) * 100, 2)}%　夏普（rf=2%）${round(sharpe(rets, 0.02, 12), 3)}`);
  const px = [100, 108, 103, 96, 91, 99, 112, 105];
  const md = maxDrawdown(px);
  console.log(`  價格序列最大回撤 ${round(md.maxDrawdown * 100, 2)}%（第 ${md.peakIndex} 期高點跌到第 ${md.troughIndex} 期）`);

  console.log(`
──────────────────────────────────────────────────────────────
和 epi_calc.js 一樣：上面沒有一個數字是「生成」的。
複利、IRR、債券價格、Black-Scholes——都是函數，模型背不起來也不該背。
LLM 的工作是聽懂「我這筆房貸提前五年還掉能省多少利息」該呼叫哪個函式，
數字交給這支程式算。
──────────────────────────────────────────────────────────────`);
}
