'use strict';
// 把這個專案裡的知識匯出成 RAGFlow 可以直接上傳的 Markdown 知識庫。
//
//   node ragflow_kb.js [輸出資料夾]      預設 ../../ragflow-kb
//
// 為什麼用產生的、不是手寫的：知識的真相在 corpus.js（語料）、epi_calc.js（材料常數）、
// expert.js（工具目錄）裡。手抄一份到知識庫，第一次改動就會兩邊不一致，
// 而 RAG 最糟的失敗就是「檢索回來的是過期的內容，而且看起來很像真的」。
//
// 切塊策略：RAGFlow 預設會照標題切。所以每個檔案第一段先寫「這份文件涵蓋什麼」
// （讓摘要那一塊自己就能被檢索到），底下每個 `##` 是一個語意完整的小節。
const fs = require('fs');
const path = require('path');
const { GROUPS, PARAGRAPHS } = require('./corpus.js');
const { MATERIALS, PRECURSORS, BOWING, XRAY, MACHINES } = require('./epi_calc.js');
const expert = require('./expert.js');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'ragflow-kb'));
fs.mkdirSync(out, { recursive: true });

const files = [];
function write(name, body) {
  const full = path.join(out, name);
  fs.writeFileSync(full, body.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  files.push({ name, bytes: Buffer.byteLength(body, 'utf8') });
}

const SRC = (f) => `\n---\n\n*來源：\`llm/tools/${f}\`，由 \`ragflow_kb.js\` 產生。要改內容請改原始檔再重新產生，不要直接編輯這份文件。*\n`;

/* ── 1. 主題文件：語料分組 ───────────────────────────────── */
for (const g of GROUPS) {
  const all = g.items.flat();
  const lines = [`# ${g.title}`, '',
    `這份文件收錄 ${g.title}的基礎敘述，共 ${all.length} 條，用於一般性的名詞解釋與原理說明。`,
    '涉及實際數值的問題（本廠規格、某一爐的量測值、某個月的統計）不在這裡，見「不要放進向量庫的東西」。', ''];
  // 每 12 條切一個小節，讓 RAGFlow 依標題切出來的塊大小接近
  for (let i = 0; i < all.length; i += 12) {
    lines.push(`## ${g.title} ${Math.floor(i / 12) + 1}`, '');
    for (const s of all.slice(i, i + 12)) lines.push(`- ${s}`);
    lines.push('');
  }
  write(`${g.id}-${g.title.replace(/[：:\/]/g, '-')}.md`, lines.join('\n') + SRC('corpus.js'));
}

/* ── 2. 診斷案例：段落本來就是一個個完整的推理，最適合當檢索單位 ── */
{
  const lines = ['# 診斷案例集', '',
    `${PARAGRAPHS.length} 個完整的排查案例，每一個都是「現象 → 查什麼 → 為什麼 → 結論」的完整推理。`,
    '這類文件在 RAG 裡特別有價值：使用者問的通常是現象，而答案需要的是整段推理，不是單一句定義。', ''];
  PARAGRAPHS.forEach((p, i) => {
    lines.push(`## 案例 ${String(i + 1).padStart(2, '0')}：${p[0].replace(/。$/, '')}`, '');
    for (const s of p) lines.push(s);
    lines.push('');
  });
  write('20-診斷案例集.md', lines.join('\n') + SRC('corpus.js'));
}

/* ── 3. 材料常數表：這些是可查的事實，適合放進知識庫 ────────── */
{
  const lines = ['# III/V 材料常數表', '',
    '二元化合物半導體的晶格常數與能隙（300 K）。三元合金請用 Vegard 定律加上 bowing 參數計算，不要內插這張表以外的值。', '',
    '## 二元材料', '', '| 材料 | 晶格常數 a [Å] | 能隙 Eg [eV] | 直接／間接 | 結構 |', '|---|---:|---:|---|---|'];
  for (const [k, v] of Object.entries(MATERIALS)) {
    const STRUCT = { zb: '閃鋅礦', wz: '纖鋅礦', dia: '金剛石' };
    lines.push(`| ${k} | ${v.a} | ${v.Eg} | ${v.gap} | ${STRUCT[v.struct] || v.struct} |`);
  }
  lines.push('', '> 閃鋅礦與纖鋅礦不能混在同一條 Vegard 公式裡計算，`epi_calc.js` 會擋下來。', '');
  lines.push('## 三元合金的 bowing 參數', '', '| 系統 | bowing [eV] |', '|---|---:|');
  for (const [k, v] of Object.entries(BOWING)) lines.push(`| ${k} | ${v} |`);
  lines.push('', '## X 光波長', '', '| 射線 | 波長 [Å] |', '|---|---:|');
  for (const [k, v] of Object.entries(XRAY)) lines.push(`| ${k} | ${v} |`);
  lines.push('', '## 前驅物', '', `已建立蒸氣壓參數的前驅物：${Object.keys(PRECURSORS).join('、')}。`,
    '起泡器的莫爾流量由蒸氣壓、起泡器溫度、起泡器壓力與載氣流量決定，用 `bubblerMolarFlow` 計算。', '');
  if (!Object.keys(MACHINES).length) {
    lines.push('## 機台參數', '',
      '**這一節是空的，而且是刻意留空的。** Aixtron G3/G4 之類的機台參數沒有填入，因為那需要現場的實機資料。',
      '模型或工具被問到機台參數時應該回答「不在參數表裡，請填入實機資料」，而不是給一個看起來合理的數字。', '');
  }
  write('30-材料常數表.md', lines.join('\n') + SRC('epi_calc.js'));
}

/* ── 4. 工具目錄：讓檢索端知道「這題不該用檢索，該去算」 ────── */
{
  const schemas = expert.toolSchemas();
  const byDomain = new Map();
  for (const s of schemas) {
    const m = /^\[([^\]]+)\]/.exec(s.description);
    const d = m ? m[1] : '其他';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(s);
  }
  const lines = ['# 可計算與可查詢的項目（不要用檢索回答這些）', '',
    `系統另外提供 ${schemas.length} 個函式，涵蓋磊晶計算、金融計算與生產資料查詢。`,
    '**下列問題應該呼叫函式，不應該從文件裡檢索答案**——檢索只會找回「看起來像」的段落，',
    '而這些問題要的是把使用者給的數字代進公式算出來的結果，或是對整批資料做統計得到的值。', ''];
  for (const [domain, list] of byDomain) {
    lines.push(`## ${domain}（${list.length} 個）`, '', '| 函式 | 做什麼 | 必填參數 |', '|---|---|---|');
    for (const s of list) {
      const req = (s.parameters && s.parameters.required) || [];
      lines.push(`| \`${s.name}\` | ${s.description.replace(/^\[[^\]]+\]\s*/, '')} | ${req.length ? req.map((r) => '`' + r + '`').join('、') : '—'} |`);
    }
    lines.push('');
  }
  lines.push('## 判斷準則', '',
    '- 使用者給了數字要你算 → 呼叫函式（例如「Al 三成的 AlGaAs 能隙是多少」）。',
    '- 要對一批資料做統計 → 呼叫查詢函式（例如「上個月 3 號機波長的 Cpk」）。平均值不存在於任何一列資料裡，檢索不可能找到它。',
    '- 問的是原理或名詞解釋 → 用檢索。',
    '- 要判定退不退貨 → 交給規則引擎，不要交給模型生成。', '');
  write('40-可計算與可查詢的項目.md', lines.join('\n') + SRC('expert.js'));
}

/* ── 5. 這一份是手寫的：它講的是這套系統的邊界，不在任何原始檔裡 ── */
write('99-不要放進向量庫的東西.md', `# 不要放進向量庫的東西

這份文件講的是**建置這個知識庫時的取捨**，讀的人是維護者，不是終端使用者。

## 生產資料不要進向量庫

把機台 log、量測結果、爐次紀錄整批丟進向量檢索庫是常見的直覺，但它會失敗，原因有兩個：

1. **要的答案不在任何一列裡。** 「這個月三號機波長的平均值」是 GROUP BY 加 AVG 算出來的，
   任何一筆原始紀錄裡都沒有這個數字。檢索最多找回幾筆長得比較像的紀錄。
2. **embedding 分不出數字的大小。** 600.2 和 620.5 哪一個離規格中心比較近，是數學問題不是語意問題。
   向量相似度對這件事沒有意義。

正確做法是把生產資料留在資料庫或 CSV，用參數化的查詢函式取數（見「可計算與可查詢的項目」）。

## 會變動的規格不要進向量庫

本廠的 Cpk 標準、成長溫度設定、波長規格這些數字會改。放進向量庫以後，
舊版本仍然會被檢索回來，而且看起來跟正確答案一模一樣——**這是 RAG 最糟的失效模式：
不是找不到，是找回了過期的內容而沒有人察覺。**

規格應該放在單一來源（設定檔或資料庫）並附上生效日期，由函式讀取。

## 資料不出廠

製程參數、良率、機台資料全部不能離開廠內網路。所以：

- RAGFlow 要用本機部署，embedding 模型與 LLM 都要選可以離線跑的。
- 不要使用任何雲端的 embedding API——那等於把文件內容送出去。
- 要對外請教問題時，用 \`inspect.js --redact\` 產生只有結構、沒有數值的樣本。

## 這個知識庫沒有涵蓋的

- **機台參數表**是空的，因為需要實機資料。被問到就要說不知道。
- **成長速率與厚度的計算式**沒有實作，因為需要現場的模型與校正係數。
- 日常對話的句子沒有匯出——那些在訓練語料裡是用來給模型文法感覺的，不是知識。
`);

/* ── 5b. 啟動指南（Windows）──────────────────────────────
   這一份是手寫的，內容查自 infiniflow/ragflow 的 README 與 docker/.env、docker-compose.yml。
   凡是查證來的都標了出處；WSL 那幾條是通用做法、RAGFlow 官方沒有寫細節，所以一律附驗證指令，
   讓人可以自己確認，而不是相信我。 */
write('00-啟動 RAGFlow（Windows）.md', `# 啟動 RAGFlow（Windows）

先講一件會直接卡住的事：**\`ragflow-main\` 這份原始碼的 \`docker-compose.yml\` 用了 profiles，
所以官方 README 上那句 \`docker compose up -d\` 在這份樹上不會啟動主服務。** 要加 \`--profile cpu\`。
下面第 4 步有驗證方法。

## 0. 先確認機器夠

官方要求（infiniflow/ragflow README）：

| 項目 | 最低 |
|---|---|
| CPU | 4 核以上 |
| 記憶體 | **16 GB 以上** |
| 磁碟 | 50 GB 以上 |
| Docker | ≥ 24.0.0，Docker Compose ≥ v2.26.1 |

記憶體是硬門檻。\`docker/.env\` 裡 \`MEM_LIMIT=8073741824\`（約 8 GB）是給 Elasticsearch 一個容器用的，
主機／WSL 能用的記憶體要明顯比這個大，否則 Elasticsearch 會反覆重啟。

## 1. 裝 Docker

### 先確認是不是「裝了、但這個視窗看不到」

\`\`\`powershell
Get-Command docker -ErrorAction SilentlyContinue
Test-Path "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
\`\`\`

- 第二行是 \`True\` → **已經裝了**。多半是兩種情況：安裝之後沒有重開 PowerShell（舊視窗的 PATH 不會更新），
  或 Docker Desktop 沒在執行。**開一個新的 PowerShell**，並確認工作列的鯨魚圖示顯示 Engine running。
- 兩行都沒有東西 → 還沒裝，往下走。

### 安裝（以系統管理員身分開 PowerShell）

1. **開啟 WSL2**：

   \`\`\`powershell
   wsl --install
   \`\`\`

   然後**重開機**。已經有 WSL 的話改用 \`wsl --update\` 與 \`wsl --set-default-version 2\`。

2. **確認虛擬化有開**：工作管理員 → 效能 → CPU → 右下角「虛擬化」要是「已啟用」。
   顯示已停用的話得進 BIOS 開 Intel VT-x／AMD-V，這一關過不了後面都免談。

3. **下載安裝 Docker Desktop for Windows**（docker.com），安裝精靈裡勾 **Use WSL 2 instead of Hyper-V**。

4. 安裝完啟動 Docker Desktop，等鯨魚圖示變成 **Engine running**。

5. **開新的 PowerShell** 確認：

   \`\`\`powershell
   docker version
   docker compose version
   \`\`\`

   要 Docker ≥ 24.0.0、Compose ≥ v2.26.1。

### 公司環境請先確認授權

**Docker Desktop 用於商業用途有付費授權的條件**（跟公司規模有關）。廠內要用的話，
先跟 IT／法務確認，條款以 Docker 官網的 Docker Desktop license 頁為準 —— 這裡不列數字，
以免過期或記錯害你踩到。

不想處理授權的話，這些替代方案跑 RAGFlow 都可以，因為它只需要 \`docker\` 與 \`docker compose\`：

- **在 WSL2 的 Ubuntu 裡直接裝 Docker Engine**（不裝 Docker Desktop）。這條最乾淨，
  但 \`vm.max_map_count\` 要在那個發行版裡設，專案路徑則變成 \`/mnt/e/LLM/ragflow-main\`。
- **Rancher Desktop** 或 **Podman Desktop**。

## 2. 設定 WSL 的記憶體與 vm.max_map_count

Elasticsearch 需要 \`vm.max_map_count\` ≥ 262144。Windows 上這個值屬於 WSL 的 Linux 核心，
不是 Windows 本身。RAGFlow 的 README 只說「Windows 請改 \`.wslconfig\`」，沒有寫細節，
所以下面是 WSL2 的通用做法 —— **做完一定要用第 3 步的指令驗證，不要假設它生效了。**

用記事本建立或編輯 \`C:\\Users\\<你的帳號>\\.wslconfig\`：

\`\`\`ini
[wsl2]
memory=12GB
processors=4
kernelCommandLine=sysctl.vm.max_map_count=262144
\`\`\`

存檔後在 PowerShell：

\`\`\`powershell
wsl --shutdown
\`\`\`

然後重新啟動 Docker Desktop。

## 3. 驗證真的生效了

\`\`\`powershell
wsl -d docker-desktop sysctl vm.max_map_count
\`\`\`

要看到 \`vm.max_map_count = 262144\`（或更大）。**如果還是 65530，就是 \`.wslconfig\` 沒吃到** ——
檢查檔名沒有被記事本加上 \`.txt\`、路徑是不是在你的使用者資料夾底下、以及有沒有真的 \`wsl --shutdown\` 過。

暫時的替代做法（重開機後會失效，但可以先讓你跑起來）：

\`\`\`powershell
wsl -d docker-desktop sysctl -w vm.max_map_count=262144
\`\`\`

## 4. 啟動

\`\`\`powershell
cd E:\\LLM\\ragflow-main\\docker
findstr /C:"profiles" docker-compose.yml
\`\`\`

- **有找到 \`profiles:\`**（\`ragflow-main\` 目前是這樣）：

  \`\`\`powershell
  docker compose -f docker-compose.yml --profile cpu up -d
  \`\`\`

- **沒找到**（舊版）：

  \`\`\`powershell
  docker compose -f docker-compose.yml up -d
  \`\`\`

第一次會下載映像檔，好幾 GB，會跑一陣子。\`docker/.env\` 裡的 \`RAGFLOW_IMAGE\` 已經釘在
\`infiniflow/ragflow:v0.26.4\`。拉不動的話，同一個檔案裡有註解掉的阿里雲與華為雲鏡像位址可以換。

## 5. 等它起來

\`\`\`powershell
docker compose -f docker-compose.yml ps
docker logs -f docker-ragflow-cpu-1
\`\`\`

看到 **\`Running on all addresses (0.0.0.0)\`** 就是好了（這行出自官方 README 的說明）。
按 Ctrl+C 離開 log 不會關掉服務。

## 6. 開網頁、註冊帳號

\`\`\`
http://localhost
\`\`\`

\`.env\` 裡 \`SVR_WEB_HTTP_PORT=80\`，所以不用加埠號。**沒有預設帳密，第一次進去要自己註冊一個帳號**
（官方 README：「On first visit, create an account or register」）。這個帳號是建在你本機的資料庫裡。

## 7. 設定模型 —— 這一步決定資料會不會出廠

左上角頭像 → **Model providers**。

**這是整個安裝過程最重要的一步。** 選雲端供應商並填 API key，等於把你上傳的每一份文件內容
送到對方伺服器（embedding 要把全文送出去，不只是問題）。製程參數、良率、機台資料不能出廠的話：

- **LLM 與 embedding 都要選可以本機跑的**，例如 Ollama（另外裝，在同一台或廠內另一台機器）。
- 在 Model providers 裡新增 Ollama，Base URL 指向你的 Ollama 位址。
- 從 Docker 容器連本機的 Ollama，位址要用 \`http://host.docker.internal:11434\`，不是 \`localhost\`。

沒有本機模型可用之前，**先不要上傳真實的廠內資料**。可以先用這個知識庫（都是一般性的原理說明，
沒有廠內數值）把流程跑通。

## 8. 建知識庫、上傳文件

到這裡才輪到這個資料夾裡的東西 —— 步驟見 \`README.md\`。

## 卡住的時候

| 現象 | 多半是 |
|---|---|
| \`無法辨識 'docker' 詞彙\` / \`command not found\` | Docker 還沒裝，或裝完沒開新的 PowerShell（見第 1 步）|
| \`docker compose up\` 跑完卻沒有 ragflow 容器 | 沒加 \`--profile cpu\`（見第 4 步）|
| \`error during connect\` / \`pipe/dockerDesktopLinuxEngine\` | Docker Desktop 沒在跑。啟動它，等鯨魚圖示變 Engine running |
| Elasticsearch 一直重啟 | \`vm.max_map_count\` 沒設好（第 3 步），或 WSL 記憶體不足 |
| 網頁打不開 | 80 埠被佔用（IIS、其他服務）。改 \`.env\` 的 \`SVR_WEB_HTTP_PORT\`，重新 \`up -d\` |
| 映像檔下載很慢或失敗 | 換 \`.env\` 裡註解掉的國內鏡像位址 |
| 想整組重來 | \`docker compose -f docker-compose.yml --profile cpu down -v\`（\`-v\` 會一併刪掉資料）|

**關於這份原始碼：** \`ragflow-main\` 是 main 分支的 zip，沒有 \`.git\`，所以官方 README 那句
\`git checkout v0.26.4\` 做不到。\`.env\` 已經釘住 v0.26.4 的映像，一般情況可以直接用；
萬一 compose 檔跟映像檔版本對不上而起不來，就去 GitHub 的 Releases 下載 **v0.26.4 的原始碼 zip**，
讓設定檔與映像檔同一版。

---

*本文的指令與數值查自 infiniflow/ragflow 的 \`README.md\`、\`docker/.env\`、\`docker/docker-compose.yml\`（main 分支）。
你手上那份如果版本不同，以你資料夾裡的檔案為準 —— 第 4 步的 \`findstr\` 就是為此而設。*
`);

/* ── 6. README ─────────────────────────────────────────── */
write('README.md', `# EPI / SPC 知識庫（給 RAGFlow 用）

${files.length} 份 Markdown，涵蓋 III/V 磊晶、MOCVD 製程與設備、量測分析、SPC、製程能力、
可靠度、安全環保、統計方法、品質與生產管理、金融財經與經濟，另有 ${PARAGRAPHS.length} 個完整的診斷案例。

由 \`llm/tools/ragflow_kb.js\` 從專案的原始檔產生。**要改內容請改原始檔再重新產生**，
直接編輯這裡的檔案，下次重新產生就會被蓋掉。

## 怎麼灌進 RAGFlow

**RAGFlow 還沒跑起來的話，先看 \`00-啟動 RAGFlow（Windows）.md\`** —— 那份有完整的 Windows 步驟，
包含官方 README 沒寫、但在這份原始碼上一定會踩到的 \`--profile cpu\`。

跑起來之後：

1. 開瀏覽器進 RAGFlow 的介面，建立一個新的 **Knowledge Base**。
2. **Embedding 模型選可以離線跑的**（資料不能出廠，不要用雲端 API）。
3. 把這個資料夾裡的 \`.md\` 全部上傳。
4. Chunk method 選 **General / Markdown 這一類會照標題切**的方式。
   這些文件是照 \`##\` 標題組織的，每個小節本身就是一個語意完整的塊。
5. 解析完成後在 Retrieval testing 裡試幾個問題，確認找回來的是對的小節。

## 建議的測試問題

| 問題 | 應該找回 | 這題在測什麼 |
|---|---|---|
| 搖擺曲線的半高寬代表什麼 | 03-量測與分析 | 一般名詞解釋 |
| 連續七點同方向代表什麼 | 04-SPC | 規則類知識 |
| 波長偏長要從哪裡查起 | 20-診斷案例集 | 需要整段推理，不是單句 |
| GaAs 的晶格常數 | 30-材料常數表 | 可查的常數 |
| Al 三成的 AlGaAs 能隙是多少 | 40-可計算與可查詢的項目 | **應該去算，不是檢索** |
| 上個月三號機的 Cpk | 40 或 99 | **應該去查詢函式** |

最後兩題是重點：如果模型直接從檢索到的段落編一個數字出來，那就是這個知識庫沒設計好。
\`40-可計算與可查詢的項目.md\` 就是為了讓檢索端知道「這題不該用我」而存在的。

## 檔案清單

${files.map((f) => `- \`${f.name}\``).join('\n')}
`);

console.log('輸出到 ' + out);
for (const f of files) console.log('  ' + f.name.padEnd(38) + (f.bytes / 1024).toFixed(1) + ' KB');
console.log(files.length + ' 個檔案，合計 ' + (files.reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(1) + ' KB');
