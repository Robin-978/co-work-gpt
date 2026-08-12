# 技術手冊 — 「看得見的 LLM」動態演示頁

對象：要修改、重建、或把這一頁換成別的模型的人。
原始碼：`llm/tools/page.template.html`（模板，約 55 KB）。**不要直接改 `llm/index.html`** — 那是建置產物，下次 `build.js` 會整個覆蓋掉。

---

## 1. 架構總覽

```
tools/corpus.js  ──┐
                   ├─→ run_train.js ─→ tools/weights.json ─┐
tools/train.js  ───┘                                        │
                                                            ├─→ build.js ─→ index.html
tools/page.template.html ───────────────────────────────────┘
```

`index.html` 是**單一自足檔案**：沒有外部 CSS、JS、字型、圖片，也沒有任何網路請求。權重以 JSON 內嵌在 `<script type="application/json" id="wdata">` 裡，頁面載入時解析並反量化，之後所有推論都在瀏覽器裡跑。

模板內只有兩個佔位符，由 `build.js` 置換：

| 佔位符 | 內容 |
|---|---|
| `__WEIGHTS__` | `weights.json` 全文 |
| `__CORPUS_CHARS__` | `buildCorpus().length` 的千分位字串 |

整份 JS 包在一個 IIFE 裡（`'use strict'`），不污染全域。

---

## 2. 模型規格

從 `weights.json` 的 `cfg` 讀出：

| 欄位 | 值 | 意義 |
|---|---|---|
| `V` | 755 | 字典大小（字元數） |
| `C` | 64 | 向量維度 |
| `L` | 2 | 層數 |
| `H` | 4 | 每層的注意力頭數 |
| `F` | 192 | FFN 隱藏層維度 |
| `B` | 48 | 上下文長度（tokens） |

`HD = C / H = 16`（每個頭的維度）。

**參數量公式：**

```
V·C  +  B·C  +  L·(4C² + 2C·F + 9C + F)  +  2C
```

代入：`48,320 + 3,072 + 2×41,728 + 128 = 134,976`。

各項對應：詞向量表 `V·C`、位置向量表 `B·C`、每層的 QKV＋輸出投影 `4C²`、FFN 兩個矩陣 `2C·F`、兩組 LayerNorm 的 γ/β 與三組 bias `9C + F`、最後的 LayerNorm `2C`。

**注意 `H` 不在公式裡** — 改頭數不會改變參數量，只是把同樣的 `C` 維切成不同份數。這一點在頁面上有八個切換按鈕（`L × H`），講解時值得指出來。

輸出頭是 **weight-tied** 的：logits 直接用 `wte` 算，沒有獨立的輸出矩陣。

---

## 3. 權重檔格式

`weights.json` 結構：

```jsonc
{
  "cfg":   { "V":755, "C":64, "L":2, "H":4, "F":192, "B":48 },
  "vocab": ["\n", " ", "!", …],          // 長度 V，index 即 token id
  "tensors": {
    "wte":  { "s": 0.0123, "d": "<base64>" },   // s = scale，d = int8 資料
    "wpe":  { … },
    "layers.0.ln1g": { … }, "layers.0.ln1b": { … },
    "layers.0.wqkv": { … }, "layers.0.bqkv": { … },
    "layers.0.wo":   { … }, "layers.0.bo":   { … },
    "layers.0.ln2g": { … }, "layers.0.ln2b": { … },
    "layers.0.w1":   { … }, "layers.0.b1":   { … },
    "layers.0.w2":   { … }, "layers.0.b2":   { … },
    "layers.1.…":    { … },
    "lnfg": { … }, "lnfb": { … }
  }
}
```

共 28 個張量（2 + 12×2 + 2）。

**量化：int8 對稱量化。** 每個張量存一個 scale `s` 與一串 int8。反量化就是 `value = int8 × s`：

```js
function deq(t) {
  const bin = atob(t.d), n = bin.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let b = bin.charCodeAt(i);
    if (b > 127) b -= 256;        // base64 解出來是 0..255，要還原成有號
    out[i] = b * t.s;
  }
  return out;
}
```

因為一個參數剛好一個位元組，**參數量就等於所有 base64 解碼後的總長度** — 頁面上的「參數量」規格就是這樣算出來的，不是寫死的數字：

```js
const N_PARAMS = Object.keys(RAW.tensors)
  .reduce((a, k) => a + atob(RAW.tensors[k].d).length, 0);
```

---

## 4. 推論實作

`forward(tokens)` 是純 JS 的前向傳播，**與 `train.js` 的實作等價**，差別只在它把所有中間值留在 `cache` 裡供繪圖使用。

架構是 **pre-LN Transformer decoder**：

```
emb = wte[token] + wpe[position]
for each layer:
    ln1  = LayerNorm(x)
    qkv  = ln1 @ Wqkv + bqkv                       # 一次算出 Q/K/V
    for each head:
        scores = (Q·K) / √HD,  只算 s ≤ t          # 因果遮罩：直接不算未來
        att    = softmax(scores)                   # 減去最大值再取 exp
        out    = Σ att·V
    res1 = x + (attout @ Wo) + bo                  # 殘差
    ln2  = LayerNorm(res1)
    fc   = ln2 @ W1 + b1
    act  = GELU(fc)
    res2 = res1 + (act @ W2) + b2                  # 殘差
    x    = res2
lnf    = LayerNorm(x)
logits = lnf[最後一個 token] · wteᵀ                # weight-tied
```

實作細節：

- **LayerNorm** 用 `eps = 1e-5`，逐 token 算均值與變異數。
- **GELU** 用 tanh 近似：`0.5x(1 + tanh(√(2/π)(x + 0.044715x³)))`。
- **因果遮罩不是乘 0**，而是內層迴圈只跑到 `s <= t` — 未來的位置根本沒被計算，所以熱圖右上角是真的空白。
- **softmax 先減最大值**再取 exp，避免溢位。
- **logits 只算最後一個 token**（生成只需要這一格），這是主要的省時處。
- `matmul` 是樸素三層迴圈，但跳過 `a === 0` 的項。序列最長 48、`C=64`，這個規模不需要分塊或 SIMD。

`cache` 保留的東西（繪圖層直接讀）：

| 欄位 | 內容 |
|---|---|
| `tokv` / `posv` / `emb` | Step 2 的三張熱圖 |
| `blocks[l].scores` / `.att` | Step 3 的注意力（softmax 前 / 後） |
| `blocks[l].ln2` / `.fc` / `.act` / `.fo` | Step 4 的 FFN 輸入、線性輸出、激活、輸出 |
| `logits` | Step 5 的候選分數 |

Step 4 固定畫**最後一層**（`L = CFG.L - 1`）最後一個 token。

---

## 5. 取樣

```js
function softmaxTopK(logits, temperature, K) {
  const idx = [...].sort((a, b) => logits[b] - logits[a]);   // 對全字典排序
  const keep = idx.slice(0, K);
  // 只對留下的 K 個做 softmax(logit / temperature)
}
```

兩點值得知道：

1. **Top-K 是對原始 logits 選的**，不是對溫度縮放後選的 — 正溫度不改變排序，所以兩者等價，但實作上先選再縮放比較省。
2. **回傳的機率是「在 K 個候選之內」的機率**，加總為 1。所以 Top-K 從 8 改成 3，同一個字的百分比會變大 — 那是重新歸一化，不是模型變有把握了。

**熵**另外算，而且是對**整個字典**算的（不是只算 Top-K），單位 bits：

```js
H = -Σ p·log₂(p)     // p = softmax(logits / temperature) over all V
```

這是頁面上唯一能反映「模型對整體有多猶豫」的數字；只看 Top-K 的長條會嚴重低估不確定性。

### 停止條件

```js
const STOP_CHARS = new Set(['。', '\n']);
```

語料是 437 句、每句以「。」結尾、用 `\n` 串起來（`corpus.js` 的 `buildCorpus()`），所以這兩個字元就是這個模型學到的句尾。產生迴圈在 `tokens.push(next)` 之後檢查，命中就 `break`：

```js
if (stopAtEos && STOP_CHARS.has(VOCAB[next])) { hitEos = true; break; }
```

因此 `len` 滑桿是**上限**而不是目標值。實測六個範例的產出落在 9–20 字，上限設 120 也一樣。

**為什麼不需要另外加一個 `<eos>` token：** 大模型會在字典裡放一個專門的結束符號，訓練時擺在每個樣本結尾。這裡「。」本來就在字典裡、而且在語料裡永遠出現在句子結尾，這個位置的統計已經足夠 — 加一個新符號只是多一個 embedding 要學。若日後語料改成句尾不一定是「。」（例如加入問句、條列），就得回頭改 `STOP_CHARS`，或真的加一個結束符號並重訓。

`stopAtEos` 由 `#stopEosBtn` 切換，關掉之後會一路跑到上限 — 保留這個開關是為了能演示「不停下來會變成什麼樣」。

**抽樣**是累積機率法：`r = Math.random()`，沿著 `probs` 累加，第一個超過 `r` 的就是選中的字。轉盤上指針的位置直接就是 `r`，所以畫面顯示的是真的抽籤過程，不是事後補畫。

---

## 6. 動畫執行器

三個機制撐起整個播放控制：

**取消用 `runId`。** 全域一個遞增的 `runId`，每次 `start()` / `stop()` 都 `runId++`。所有 `await wait(...)` 每一幀檢查 `runId` 有沒有變，變了就 `throw CANCEL`，整個 async 呼叫鏈自然拆掉。`start()` 的 `catch` 吞掉 `CANCEL`、其他錯誤照拋。

```js
async function wait(ms) {
  const my = runId;
  let remain = ms, last = performance.now();
  while (remain > 0) {
    await raf();
    if (runId !== my) throw CANCEL;
    const now = performance.now(), dt = Math.min(80, now - last); last = now;
    if (!paused) remain -= dt * speed;      // 暫停 = 不扣時間
  }
}
```

**暫停靠不扣時間**，不是 `clearTimeout` — 所以暫停期間畫面完全凍住，繼續之後接得回去。`dt` 上限 80ms 是為了分頁切回來時不要一次跳完。

**速度是乘在時間上的。** 滑桿 5–40 → `speed = 0.5 – 4.0`，`remain -= dt * speed`。

**詳細模式是一個係數。** `runOnce(tokens, nPrompt, isFirst)` 開頭算出 `d`：

```js
const d = isFirst || detail ? 1 : 0.34;
```

之後所有 `await wait(x * d)`。第一個字永遠完整演示；關掉 `detail` 之後其餘的字約三倍速帶過。逐格揭露的動畫（Step 1 的 chip、Step 2 的逐行、Step 3 的逐列）則是用 `isFirst` 完全跳過。

---

## 7. 繪圖層

全部是 `canvas` 2D，沒有任何繪圖函式庫。

**色標分兩種，依用途分工：**

| 用途 | 色標 | 函式 |
|---|---|---|
| 有正負的向量（Step 2、Step 4 的輸入輸出） | 發散：藍 ← 暗灰 → 橘 | `diverging(v, max)` |
| 只有非負的量（Step 3 注意力、Step 4 激活） | 單色階：暗 → 亮 | `seqBlue` / 綠色階 |

熱圖旁邊一律附上等價的數字長條，不能只靠顏色判讀（色覺無障礙）。

**顯示視窗：** `const DISP = 14;` — 熱圖與向量圖最多畫 14 個 token，序列更長時 `attWindow(T)` 回傳 `{off, n}` 只取最後 14 個。改這個常數會直接改變三張熱圖的密度。

**縮放：** 所有 canvas 都是 `max-width:100%`；`resize` 事件只重畫 Step 4（其他幾張在下一輪 `runOnce` 會自然重畫）。

---

## 8. UI 狀態

沒有框架，就是幾個模組層級變數：

```js
let runId = 0, paused = false, speed = 1, detail = true, autoscroll = true, stopAtEos = true;
let running = false;
```

- `setStage(n)` 切換六個 `<section>` 的 `on` / `visited` class 與步驟列的 `active` / `done`，並在 `autoscroll` 開啟時捲到該區塊（偏移 76px 讓開置頂步驟列）。
- `syncCtrl()` 把主要按鈕的狀態同步到步驟列的迷你按鈕。
- `syncLenHint()` 在產生長度、提示、或 `stopAtEos` / `detail` 改變時重算提示文字：`stopAtEos` 開著就說明這是上限、超過 `CFG.B` 就警告視窗會滑動、`detail && n > 40` 就警告會跑很久。
- 鍵盤：`Space` = 開始／暫停、`Escape` = 停止；`e.target.tagName === 'INPUT'` 時直接 return（否則輸入框打不了空白）。

**所有維度文案都從 `cfg` 填入**，不是寫死的：規格列（`specs`）、`.dimC` / `.dimF` 這些 span、頁尾的參數量與語料字數。換一個不同規模的模型重新 build，頁面不會說錯自己的規格。

首屏會先靜態畫一次預覽（用 `MOCVD 的成長溫度`），Step 5 的預覽也讀控制列上的溫度滑桿 — 改預設溫度不會讓首屏跟實際演示對不起來。

---

## 9. 建置

```bash
cd llm/tools
node build.js ../index.html
```

`build.js` 做的事：

1. 讀 `weights.json` 與 `page.template.html`，用 `corpus.js` 算語料字數。
2. **先檢查** `weights.json` 裡沒有 `</script>`（有的話會提早關掉 `<script>` 標籤，整頁壞掉）。
3. 置換兩個佔位符（用函式形式的 `replace`，避免 `$&` 之類的替換樣式被誤解讀）。
4. **置換後再檢查一次**佔位符都不見了，沒有就丟錯。
5. 寫檔，印出大小。

改完模板一定要重跑這個指令，否則 `index.html` 還是舊的。驗證有沒有生效最快的方法：看規格列的數字，或用瀏覽器搜尋你剛加的文案。

---

## 10. 常見修改

| 想做什麼 | 怎麼做 |
|---|---|
| 改文案、改版面、加說明段落 | 改 `page.template.html`，重跑 `build.js` |
| 換一個不同規模的模型 | 重新訓練產生新的 `weights.json`，重跑 `build.js`。頁面會自動反映新的 `cfg`，不用改 HTML |
| 改預設溫度／長度／Top-K | 改 `<input>` 的 `value` 與旁邊 `<b>` 的顯示值（兩處都要改，否則首屏顯示會對不上） |
| 換語料，句尾不再是「。」 | 改 `STOP_CHARS`；若新語料的句尾沒有固定符號，就得在字典裡加一個結束符號並重訓 |
| 改熱圖顯示的 token 數 | 改 `DISP` |
| 改 Step 4 顯示哪一層 | `runOnce` 裡的 `const L = CFG.L - 1`（`resize` handler 裡也有一份，要一起改） |
| 加第七個步驟 | 新增 `<section id="s7">`、加進 `stageEls` / 步驟列、在 `runOnce` 裡插 `setStage(7)`。`setStage` 裡的 `1..6` 迴圈上限也要改 |
| 換配色 | CSS 的 `:root` 變數，以及 JS 裡的 `C_NEG` / `C_POS` / `C_MID` / `C_S*` / `C_G*` 常數 |

---

## 11. 效能與限制

- **推論成本**：每個字一次 forward。`T ≤ 48`、`C = 64`、`L = 2`，在一般筆電上單次 forward 遠低於一幀的時間；**畫面速度完全由動畫節奏決定，不是被計算拖慢的**。
- **檔案大小** 約 235 KB，其中權重 JSON 約 182 KB。int8 量化把浮點權重壓成四分之一；再往下壓（int4）會開始看得出生成品質變差。
- **記憶體**：`forward` 每次都配新的 `Float32Array`，沒有做緩衝池。以這個規模沒有必要，但如果把 `B` 或 `C` 放大一個數量級就得處理。
- **沒有 KV cache**：每產生一個字都重算整個序列。對演示反而是對的 — 要能畫出完整的注意力矩陣。真正的推論引擎不會這樣做。
- **量化誤差**：頁面顯示的數值是反量化之後的，與訓練時的浮點值有微小差異。不影響演示，但別拿頁面上的數字去驗證訓練程式。

---

## 12. 改完之後該驗什麼

Playwright 實跑過的項目，改動之後值得重跑一遍：

- 桌機與 390px 手機寬度都沒有 console error、沒有水平溢出。
- 產生流程能完整跑完；暫停真的凍住輸出；停止之後按鈕狀態正確復原。
- 注意力頭切換會同步重畫（包含停止之後）。
- 字典外的輸入會出現警告；全部都在字典外會拒絕開始。
- 空白與換行字元在 Step 1 的 chip 與 Step 6 的輸出框裡都渲染正確。
- 四個滑桿的上下限與提示條件（上限說明、超過上下文、詳細模式 > 40 字）。
- **提早停止**：開著 `stopAtEos` 時產出停在句尾符號且短於上限；關掉時剛好跑滿上限、句號不會中止。
- **實跑 60 字**，確認滑動視窗之下續寫仍然完整。

---

## 相關文件

- [使用者手冊](user-manual.md) — 怎麼操作、六個步驟在演示什麼
- [`../README.md`](../README.md) — 訓練、續訓、擴充字典、RAG、專家系統、生產資料工具鏈
