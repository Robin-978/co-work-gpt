# 看得見的 LLM — 動態演示語言模型怎麼運作

`llm/index.html` 是一個**單檔、零後端、離線可跑**的網頁，用動畫一步一步演示一個語言模型
從輸入到輸出的完整過程：

1. **Tokenization 分詞** — 文字切成 token，查表換成 id
2. **Embedding 詞向量** — token 向量 ＋ 位置向量
3. **Self-Attention 注意力** — Q·K → softmax → 加權混合 V（含因果遮罩）
4. **Feed-Forward 前饋網路** — 48 維放大到 128 維、GELU、再壓回 48 維
5. **Generation 產生** — logits → 溫度 → softmax → Top-K → 抽樣
6. **Output 輸出** — 新字接回輸入，回到第 1 步（自迴歸）

畫面上的每一個色塊、每一條長條，都是模型**當下在瀏覽器裡算出來的真實數值**，不是預錄的示意動畫。

## 模型

不是呼叫任何 API，而是一個從零訓練的 char-level GPT，權重以 int8 量化後直接內嵌在 HTML 裡：

| 項目 | 值 |
|---|---|
| 參數量 | 61,120 |
| 層數 / 注意力頭 | 2 layers / 3 heads |
| 向量維度 | d = 48（head_dim 16）|
| 前饋層 | 128 |
| 上下文長度 | 48 tokens |
| 字典 | 304 個中文字元 |
| 訓練語料 | 68 句中文短句，約 7,000 字 |

架構跟 GPT 完全一樣（pre-LN Transformer decoder、causal self-attention、weight-tied 輸出頭），
差別只在規模。因為語料極小，它只會講很像訓練資料的簡單句子——這正好讓「模型在背下來的分布裡取樣」
這件事變得看得見。

## 重新訓練 / 重新打包

```bash
cd llm/tools
node train.js gradcheck      # 反向傳播的數值梯度檢查
STEPS=3000 node run_train.js # 訓練，過程中會定期寫出 weights.json
node build.js ../index.html  # 把 weights.json 內嵌進 page.template.html
```

- `corpus.js` — 訓練語料（改這裡就能換模型會講的話）
- `train.js` — 純 JS 的 forward / backward / 梯度檢查
- `run_train.js` — AdamW 訓練迴圈 + int8 量化輸出
- `page.template.html` — 網頁模板，`__WEIGHTS__` 會被換成權重
- `build.js` — 打包成單一 HTML

只改網頁不重訓的話，編輯 `page.template.html` 後跑 `node build.js ../index.html` 即可。

## 操作

- **開始演示 / 暫停 / 停止**（空白鍵 = 開始或暫停，Esc = 停止）
- **溫度**：越低越保守，越高越有創意也越容易亂講
- **Top-K**：只從機率最高的 K 個字裡抽
- **動畫速度**：0.5×–4×
- **每個字都完整演示 / 只完整演示第一個字**：後者會加快後續的字
- 注意力那一段可以切換**第幾層、第幾個頭**，看不同的頭在看什麼關係
