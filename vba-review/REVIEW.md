# VBA 程式碼檢查報告（邏輯 / 語法 / 優化）

檢查對象（5 個檔案）：

| 檔案 | 內容 |
|------|------|
| `Mainflow.txt` | 模組 `MainFlowOutput`：GetNumber / replaceandsplityA / FindDataCollection / CopyToDaily / CopyMOsource / EpiCodeV1 / EpiCode2 / EpiCodeAll / EpiCode |
| `Moduel2.txt` | 模組 `Module2`：SyncSheetToCSV（Daily → CSV 匯出） |
| `Pmform.txt` | 表單 `PMForm`：PM Track In / Track Out |
| `Trackinout.txt` | 表單 `TrackINOUT`：Track In / Out / Abort / No-Mdb + Glove Box 判斷 |
| `Thisbook.txt` | `ThisWorkbook` + `Sheet5` + 模組 `Module_AuditEnterprise`（稽核系統） |

---

## A. 編譯錯誤（專案按下執行就會停）

### A1. `Sheet5.cmdRunCode_Click`：`Call EpiCode` 缺少必要參數
`EpiCode` 的簽章是 `Sub EpiCode(ByVal cellRunIDrow As Long)`，參數**不是 Optional**，
`Call EpiCode` 會直接編譯錯誤「Argument not optional」。

```vba
' 修正
Private Sub cmdRunCode_Click()
    Dim wsD As Worksheet, lastRow As Long
    Set wsD = ThisWorkbook.Worksheets("Daily")
    lastRow = wsD.Cells(wsD.Rows.Count, 9).End(xlUp).Row
    Call EpiCode(lastRow)
    cmdRunCode.Enabled = False
End Sub
```

### A2. `Sheet5.cmdRunTime_Click`：變數 `i` 未宣告
`Sheet5` 模組有 `Option Explicit`，但 `For i = 7 To lastRow` 的 `i` 沒有宣告
→ 編譯錯誤「Variable not defined」。補上 `Dim i As Long`。

### A3. `Sheet5.CommandButton2_Click`：變數 `i`、`j` 未宣告
同上，補 `Dim i As Long, j As Long`。

### A4. `Sheet5.SaveUndoSnapshot`：`OldAddress`、`UndoStack` 未宣告
若專案其他模組沒有宣告這兩個全域變數，這個 Sub 在 `Option Explicit` 下無法編譯。
目前也沒有任何地方呼叫它——若是尚未完成的功能，建議先整段移除或補齊全域宣告：

```vba
Public OldAddress As String
Public UndoStack As New Collection
```

---

## B. 執行期必炸 / 會寫壞資料的錯誤

### B1. `TrackINOUT.ExtractNumbers`：`regEx.Global = Truedsff`（打字錯誤）
表單模組沒有 `Option Explicit`，`Truedsff` 被當成未宣告變數（值為 Empty → False），
所以 `Global = False`，**只會取到字串中的第一段數字**。
Coating 厚度 `thx` 因此算錯。修正：`regEx.Global = True`（見 `optimized/TrackINOUT_patches.bas`）。

### B2. `MainFlowOutput.GetNumber`：`numPart * 0.5` 型別錯誤
B3 儲存格若不含任何數字，`numPart = ""`，`"" * 0.5` → Type mismatch (13)。
另外 `IsNumeric` 會把 `.`、`-`、`+` 也判成數字，改用 `Like "[0-9]"` 逐字判斷更精準。

### B3. `MainFlowOutput.CopyToDaily`：`Resize Range(...)` 未限定工作表
```vba
wst.ListObjects("表格1").Resize Range("$A$2:$U" & lastRowL)   ' 錯
```
未限定的 `Range` 以**作用中工作表**為準；當 LOG 不是作用頁時會 Resize 到錯的範圍或直接 1004。
修正：`wst.ListObjects("表格1").Resize wst.Range("$A$2:$U$" & lastRowL)`。

### B4. `MainFlowOutput.EpiCode2`：AR1 為空時產生非法範圍
`i = ws.Cells(1, "AR").Value` 若 AR1 是空的，`i = 0`，
`ws.Range("I0:I" & lastRow)` → 執行期錯誤 1004。需加防呆：`If i < 1 Then i = 1`。

### B5. `PMForm.cmbSubmit_Click`：`lastRow1` 是未宣告變數（應為 `lastRow`）
```vba
If ws.Cells(lastRow1, 3).Value >= ws.Cells(lastRow, 2).Value Then   ' lastRow1 = Empty → Cells(0,3) → 1004
```
表單沒有 `Option Explicit`，`lastRow1` 恆為 Empty，`Cells(0, 3)` 觸發 1004，
又被 `On Error GoTo ErrorDate → Resume Next` 吃掉——**整段工時計算被靜默跳過**，完全不會報錯。

### B6. `TrackINOUT.cmbNomdb_Click`：`lastRow5` 區塊混用 `lastRow`（跨列污染）
狀況 A（空白 Run ID）整段以 `lastRow5`（B 欄基準）為基準列，但工時計算卻讀 `lastRow`（H 欄基準）：

```vba
ws.Cells(lastRow5, 6).Value = Format(ws.Cells(lastRow, 3).Value - ws.Cells(lastRow, 2).Value, "hh:mm")   ' 錯列
ws.Cells(lastRow5, 7).Value = Format((ws.Cells(lastRow, 3).Value - ws.Cells(lastRow, 2).Value) * 24, ...)
' 以及 lastRow5-1 列卻讀 lastRow-1 列、lastRow5+1 列卻寫 lastRow 列的值
```
兩個基準列不同時，工時會抓到別列的時間。應全部統一用 `lastRow5`。
另外此分支中 `ws.Cells(lastRow5, 3).Value = ws.Cells(lastRow5, 2).Value` 之後**立刻被 `= Now` 覆寫**，前一行是無效碼。

---

## C. 邏輯錯誤（不會報錯，但結果是錯的）

### C1. `replaceandsplityA`：`Or` 恆真（經典布林錯誤）
```vba
If Left(rng.Value, 1) <> "C" Or Left(rng.Value, 1) <> "B" Then   ' 永遠 True
```
任何字元都不可能「同時等於 C 又等於 B」，所以此條件恆真，
B/C 開頭的 Run ID 永遠走 6 欄分支，**4 欄分支是死碼**。應改為 `And`。
（此判斷也放錯位置——它與 `j` 無關，應移到迴圈外。）

### C2. `EpiCodeV1`：同樣的 `Or` 恆真
```vba
If ws.Cells(i, 9).Value <> "Baking" Or ws.Cells(i, 9) <> "Coating" Then ws.Cells(i, "L").Value = "T3"   ' 永遠 True
```
連 Baking/Coating 也會先被寫成 T3。應改為 `And`。

### C3. `EpiCodeV1`：CountIfs 範圍只有單一儲存格
```vba
result = ...CountIfs(ws.Range("I" & i & ":I" & i), ws.Cells(i, 9))   ' 只數自己，恆為 1
```
`result > 1` 的分支（C / CT / T3）全部是死碼。原意應是「從上次 PM Reset 列（AR1）累計到現在」：
```vba
Dim resetRow As Long
resetRow = Val(ws.Cells(1, "AR").Value): If resetRow < 1 Then resetRow = 1
result = Application.WorksheetFunction.CountIf(ws.Range("I" & resetRow & ":I" & i), ws.Cells(i, 9).Value)
```
（新版 `EpiCode` 已改成 `I1:I`，但從第 1 列算會把 PM 前的舊 Run 也算進去，仍應從 AR1 起算。）

### C4. `TrackINOUT.cmboxTrackIn_Click`：「製程分支 C 續」區塊越界執行
結構上，`If InStr(...,"B"...) / ElseIf "C" / ElseIf 分支C` 的 `End If` 收在「分支 C 續」**之前**，
導致 1444 行以後的整段（覆寫第 10 欄 / AM / Q、零件計數 j 迴圈 +1、OOC/OOS 檢查）
**對 Baking、Coating 分支也會執行**——零件壽命被重複累加、剛寫好的欄位被覆蓋。

修正：把該 `End If` 移到「分支 C 續」的 `Next j`（含 `On Error GoTo 0`）之後，
讓整段只屬於分支 C。詳見 `optimized/TrackINOUT_patches.bas` 的說明。

另外此表單內殘留多段 AI 對話文字被貼進註解（例如
「由於您的程式碼尚未貼完，請提供後續 2-2 的程式碼」「未完待續…」），
表示這支程式是分段拼接產生的——**強烈建議在 VBE 中執行 Debug → Compile 全案檢查一次**，並刪除這些對話殘留。

### C5. `Module2.SyncSheetToCSV`：月份過濾跨年失效
```vba
If Month(ws.Cells(r, 2).Value) >= Month(Now) - 1 Then   ' 錯
```
- 1 月時 `Month(Now) - 1 = 0` → 所有月份都 ≥ 0，**整年資料全部匯出**；
- 12 月時，同年 1~10 月被排除，但「去年 11、12 月」反而會被匯入。

修正（以「上個月 1 日」為界，正確處理跨年）：
```vba
Dim cutoffDate As Date
cutoffDate = DateSerial(Year(Now), Month(Now) - 1, 1)   ' DateSerial 會自動處理 0 月 → 去年 12 月
If IsDate(ws.Cells(r, 2).Value) Then
    If ws.Cells(r, 2).Value >= cutoffDate Then ...
```

### C6. `Module_AuditEnterprise.AppendHiddenComment`：歷史合併是死碼
開頭先把舊註解刪掉，之後再判斷 `If tgt.Comment Is Nothing`——永遠成立，
`Else` 分支（合併歷史 + `KeepLastNCommentEntries` 保留最近 N 筆）**永遠不會執行**，
稽核註解永遠只剩最新一筆。修正：先取出舊文字再刪除，且只合併「本系統寫入」的註解
（以「流水號：」開頭判斷），貼上帶來的外部註解仍照原意丟棄：

```vba
Dim existingText As String
If Not tgt.Comment Is Nothing Then
    existingText = tgt.Comment.Text
    If Left$(existingText, 4) <> "流水號：" Then existingText = ""   ' 外部貼上的註解不保留
    tgt.Comment.Delete
End If
If tgt.CommentThreaded.Count > 0 Then tgt.CommentThreaded.Delete
'（組 newEntry 同原碼）
If existingText = "" Then
    tgt.AddComment newEntry
Else
    tgt.AddComment KeepLastNCommentEntries(newEntry & vbCrLf & String(40, "-") & vbCrLf & existingText, keepN)
End If
```

### C7. `PMForm.cmbSubmit_Click`：先寫入、後驗證
第 156–158 行先把 `PM-ing`、OPID 寫進工作表，**之後**才檢查 PM Item / PM Group 有沒有勾。
驗證失敗 `GoTo EmptyEnd` 時已經留下半筆資料，而且 `EmptyEnd` 還把 Submit 按鈕
`Enabled = False / Visible = False`——使用者**連重試的機會都沒有**。
修正：驗證移到最前面，失敗直接 `Exit Sub`（保留按鈕）。已完整重寫，見 `optimized/PMForm_code.bas`。

### C8. `PMForm.cmbFinished_Click`：`Date2:` 空的錯誤處理
`On Error GoTo Date2` 而 `Date2:` 標籤底下是空的、直接掉出 `End Sub`——
時間區塊一出錯，後面所有回寫（點檢項目、PM 序號、狀態重置）**全部靜默跳過**，
工作表停在不一致狀態。另外 `result` 未宣告（表單無 Option Explicit，僥倖可跑）。

### C9. `ThisWorkbook.Workbook_Activate`：事件可能被永久關閉
```vba
Call Function_OFF
If Application.CutCopyMode <> False Then Exit Sub   ' 從這裡離開時 Function_On 沒被呼叫
Call Function_On
```
複製狀態下切回活頁簿，`EnableEvents / ScreenUpdating` 就停在關閉狀態。
修正：先判斷再關，或干脆整段移除（OFF 完馬上 ON 本來就沒有實際作用）：
```vba
If Application.CutCopyMode <> False Then Exit Sub
```

### C10. `CopyToDaily`：迴圈內重複執行不變的計算
`For i = 1 To lastCol` 內的 T / V / U 欄寫入與 i 完全無關，卻被重複執行 lastCol 次。移到迴圈外。
另 `lastRow` 與 `lastRowH` 是同一個值，重複宣告。

### C11. `CopyMOsource`：總結備註在雙迴圈內重複執行
「低於 Warning / 差值異常 / 需By Pass」的 8 分支總結，放在 `For i / For j` 內層，
每一組 (i, j) 都重寫一次 note 與 AQ 欄（數十次）。應在雙迴圈結束後只做一次。
另有：空的 `ElseIf ... Then`（死碼）、內圈找到對應欄位後未 `Exit For` 繼續空掃、
`lastRow2` 未宣告。

### C12. `TrackINOUT.txtHO_Change / txtO_Change`：`Case Is >= GBC, Is <= GBP` 恆真
`Case` 內以逗號分隔是 **OR** 關係，`Is <= GBP` 幾乎涵蓋所有值，此 Case 恆真。
目前只因前兩個 `Case Is > GBP`、`Case Is < GBC` 先攔截而僥倖正確。
語意應寫 `Case GBC To GBP` 或直接 `Case Else`。
此外兩支 handler 是近 400 行的複製貼上，且存在互相矛盾的子分支
（例如 H2O 超標但 O2 在範圍內時什麼都不提示）；已抽成共用副程式，見
`optimized/TrackINOUT_patches.bas`。

### C13. `Module2.SyncSheetToCSV` 其他問題
- `On Error GoTo ErrHandler` 之後兩行又 `On Error Resume Next` → ErrHandler 幾乎是死碼；
  且 ErrHandler 內 `fs.Close` 在 stream 未開啟時會**在錯誤處理器內再度出錯**（未受保護）。
- 宣告了 30 個 `cellValue1..30`，實際只用 12 個；`fileNum = FreeFile`、`ts` 完全沒用到。
- 空表檢查 `lastRow = 1 And lastCol = 1 And IsEmpty(Cells(1,1))` 與實際取值
  （B 欄 / 第 5 列）不一致，永遠測不到。
- Note 欄含逗號、雙引號、換行時 CSV 會壞——需將內文的 `"` 轉義為 `""`。

已全部修正，見 `optimized/Module2.bas`。

### C14. `Sheet5.CommandButton3_Click`：`cmdResetRunCode.Enabled = True` 重複兩行
刪一行即可（無害，但屬冗餘）。

### C15. `MainFlowOutput.FindDataCollection` 細節
- `ElseIf SelectedCell Is Nothing Then` 應為 `Else`（前面已判斷過 Not ... Is Nothing）。
- 第一個 `Set SheetRange = ws.Range("C12:C...")` 設完沒有用到就被覆蓋。
- `i`、`j` 未宣告（模組無 Option Explicit）。

---

## D. 結構性 / 維護性優化建議

### D1. 同一段「工時計算 + 負值歸零 + 上色」複製了 10+ 份
TrackINOUT（TrackIn / TrackOut / Abort / NoMdb）、PMForm、Sheet5.cmdRunTime、CopyToDaily
全都各自複製同一段 F/G 欄計算與格式化。已抽成共用副程式
`WriteRunDuration(ws, r)`（見 `optimized/Module_Common.bas`），一處修改、全案生效。

### D2. EpiCode 有四個版本並存（EpiCodeV1 / EpiCode2 / EpiCodeAll / EpiCode）
- `EpiCode`（最新、含變數快取）已是最完整的單列版本 → **保留（已修正 CountIf 起算列）**；
- `EpiCodeAll` 是全表重算版 → 保留（已重構，抽出 `IsPMCode` 共用判斷）；
- `EpiCodeV1`、`EpiCode2` 是含 C2/C3 錯誤的舊版，且已無按鈕呼叫 → **建議刪除**。

### D3. 密碼明碼散落各處
`"57732"`（Daily 保護）、`"WU1974"`（稽核系統）直接寫死在多個 Sub。
至少集中成模組常數；若要真的保護，VBA 專案本身也要上密碼（否則任何人 Alt+F11 就能看到）。

### D4. 全面加上 `Option Explicit`
`MainFlowOutput`、`TrackINOUT`、`PMForm` 都沒有 `Option Explicit`，
本次找到的 `Truedsff`、`lastRow1`、`lastRow5/lastRow` 混用等 bug，全部都是它能在編譯期抓到的。
（VBE → 工具 → 選項 → 勾選「要求變數宣告」。）

### D5. 錯誤出口需成對恢復環境
多個錯誤處理出口只呼叫 `Function_On` 沒有 `Protect_1`（或相反），
例如 `cmbNomdb_Click` 的 `SaveError:` 兩者都沒有。建議統一的離開範式：

```vba
CleanExit:
    Call Protect_1
    Call Function_On
    Exit Sub
EH:
    MsgBox ...
    Resume CleanExit
```

### D6. 效能
- 逐格 `ws.Cells(...).Value` 讀寫非常多；高頻區塊（EpiCodeAll、CopyMOsource、SyncSheetToCSV）
  建議一次讀入 Variant 陣列處理後一次寫回。
- `EpiCode` 新版已示範「先快取常用儲存格值再判斷」，其餘模組可比照。
- `Workbook_BeforeSave` 每次存檔都寫網路磁碟 CSV（`\\tycba6\...`），網路慢時存檔會卡住；
  建議加上開關（例如 audit_global 加一個 `SyncCsvOnSave` 旗標）或改為手動/定時匯出。

---

## 交付內容

| 檔案 | 說明 |
|------|------|
| `optimized/Module_Common.bas` | 新增共用模組：`WriteRunDuration`、`ExtractNumbers`（修正版）、`IsPMCode` |
| `optimized/MainFlowOutput.bas` | 完整修正版（A/B/C 各項已修；EpiCodeV1/EpiCode2 已移除） |
| `optimized/Module2.bas` | `SyncSheetToCSV` 完整重寫（跨年、CSV 轉義、錯誤處理） |
| `optimized/PMForm_code.bas` | PMForm 三個事件完整修正版（先驗證後寫入、lastRow1、Date2） |
| `optimized/TrackINOUT_patches.bas` | TrackINOUT 修正片段（ExtractNumbers、GloveBox 共用邏輯、cmbNomdb 對列修正、分支 C 範圍修正說明） |
| `optimized/Sheet5_ThisWorkbook_patches.bas` | Sheet5 / ThisWorkbook / 稽核模組修正片段 |

> 匯入方式：`.bas` 檔內容即模組程式碼，可直接在 VBE 中取代對應模組內容；
> 表單（PMForm / TrackINOUT）僅取代程式碼區，不要動 `.frx` 版面定義。
> **匯入後請務必 Debug → Compile VBAProject 並在測試檔上跑一輪 Track In/Out 流程。**
