'==============================================================
' TrackINOUT 表單修正片段
' 此表單超過 2200 行且與多個外部程序（RunList / InRecipeSplit /
' SearchData1 / XChartGenerater / PtrCheckList / GetMDBfilePath）耦合，
' 不做整支重寫，以下為必須套用的修正與可直接取代的片段。
'
' 套用前請先在表單模組最上方加入：Option Explicit
' 並補宣告原本缺漏的變數（cmbNomdb_Click / cmboxTrackIn_Click 內的
' lastRow, lastRow2, OPID, thx, cellRunIDrow, cellValueRunId,
' PartscellRow, PartscellValue, result, j 等）。
'==============================================================
Option Explicit

'--------------------------------------------------------------
'【修正 1】ExtractNumbers：regEx.Global = Truedsff → True
' 原碼 Truedsff 是未宣告變數（= Empty = False），Global 因此為 False，
' 只會取得第一段數字，Coating 厚度 thx 會算錯。
' → 建議直接改用 Module_Common.ExtractNumbers（同名共用版本），
'   並刪除表單內的這個 Function，避免兩份不同步。
'--------------------------------------------------------------

'--------------------------------------------------------------
'【修正 2】txtHO_Change / txtO_Change 共用邏輯
' 原兩支 handler 各約 200 行，內容互為鏡像複製，且有：
' - Case Is >= GBC, Is <= GBP 恆真（逗號是 OR），僅因前面 Case 先攔截而僥倖正確
' - H2O 超標但 O2 在範圍內時，介面完全不提示的矛盾子分支
' 統一規則（與原意一致且補上原本矛盾的洞）：
'   任一值 > GBP  → 強制 Purge 模式（亮藍、Circle 停用）
'   兩值皆 < GBC  → 建議 Circulation 模式
'   其他（區間內）→ 中性狀態，等待人工選擇
' 兩個 handler 都改為只呼叫 UpdateGloveBoxState 即可：
'
'   Private Sub txtHO_Change(): UpdateGloveBoxState: End Sub
'   Private Sub txtO_Change():  UpdateGloveBoxState: End Sub
'--------------------------------------------------------------
Private Sub UpdateGloveBoxState()
    Dim GBType As String
    Dim GBP As Double, GBC As Double
    Dim vHO As Double, vO As Double
    Dim msg As String

    GBType = Me.GBType.Caption

    ' B 型 Glove Box：不做管制，僅開放操作
    If GBType = "B" Then
        SetGloveBoxUI purgeHighlight:=False, circleHighlight:=False, _
                      circleEnabled:=True, trackInEnabled:=True, labelMsg:=""
        Exit Sub
    End If

    GBP = Val(Me.GBP.Caption)     ' Purge 上限（如 8）
    GBC = Val(Me.GBC.Caption)     ' Circulation 下限（如 1）
    vHO = Val(Me.txtHO.Value)
    vO = Val(Me.txtO.Value)

    If vHO > GBP Or vO > GBP Then
        ' 任一超標 → 必須切 Purge
        If vHO > GBP And vO > GBP Then
            msg = "H2O,O2 > " & GBP & ",切purge mode"
        ElseIf vHO > GBP Then
            msg = "H2O > " & GBP & ",切purge mode"
        Else
            msg = "O2 > " & GBP & ",切purge mode"
        End If
        SetGloveBoxUI True, False, False, False, msg

    ElseIf vHO < GBC And vO < GBC Then
        ' 兩者皆低於下限 → 切 Circulation
        SetGloveBoxUI False, True, True, False, "H2O,O2 < " & GBC & ",切circulation mode"

    Else
        ' 區間內 → 中性狀態，兩個選項開放、Track In 尚未解鎖
        SetGloveBoxUI False, False, True, False, ""
    End If
End Sub

Private Sub SetGloveBoxUI(ByVal purgeHighlight As Boolean, ByVal circleHighlight As Boolean, _
                          ByVal circleEnabled As Boolean, ByVal trackInEnabled As Boolean, _
                          ByVal labelMsg As String)
    Const clrHighlight As Long = &HFFFF00      ' RGB(0, 255, 255) 青色
    Const clrNeutral As Long = &HF0F0F0        ' RGB(240, 240, 240) 灰

    With Me.labPurge
        .Enabled = True
        .Visible = (labelMsg <> "")
        .Caption = labelMsg
        .ForeColor = RGB(255, 0, 0)
    End With

    With Me.optPurge
        .BackColor = IIf(purgeHighlight, clrHighlight, clrNeutral)
        .Enabled = True
    End With

    With Me.optCircle
        .BackColor = IIf(circleHighlight, clrHighlight, clrNeutral)
        .Enabled = circleEnabled
    End With

    Me.cmboxTrackIn.Enabled = trackInEnabled
End Sub

'--------------------------------------------------------------
'【修正 3】cmbNomdb_Click 狀況 A（空白 Run ID）：lastRow / lastRow5 混用
' 原碼以 lastRow5（B 欄基準）為寫入列，但工時卻讀 lastRow（H 欄基準），
' 兩者不同列時工時抓到別列的時間。下段為對齊後的正確寫法，
' 直接取代原「If Controls("txtboxid")... 」分支中對應的計算區塊：
'--------------------------------------------------------------
' Dim currentNow As Date
' currentNow = Now
'
' ws.Cells(lastRow5, 3).Value = Format$(currentNow, "YYYY/MM/DD hh:mm")
' If ws.Cells(lastRow5, 3).Value < ws.Cells(lastRow5, 2).Value Then
'     ws.Cells(lastRow5, 3).Value = ws.Cells(lastRow5, 2).Value
' End If
' Call WriteRunDuration(ws, lastRow5)          ' 原碼讀成 lastRow 列 → 跨列污染
'
' If ws.Cells(lastRow5 - 1, 3).Value < ws.Cells(lastRow5 - 1, 2).Value Then
'     ws.Cells(lastRow5 - 1, 3).Value = ws.Cells(lastRow5 - 1, 2).Value
' End If
' Call WriteRunDuration(ws, lastRow5 - 1)      ' 原碼讀成 lastRow - 1 列
'
' ws.Cells(lastRow5 + 1, 2).Value = Format$(ws.Cells(lastRow5, 3).Value, "YYYY/MM/DD hh:mm")
'                                              ' 原碼讀成 lastRow 列
' ws.Cells(lastRow5, 5).Value = OPID
'
' 註：原碼中「ws.Cells(lastRow5, 3).Value = ws.Cells(lastRow5, 2).Value」
'     之後立刻被 = Now 覆寫，是無效碼，上面已移除。

'--------------------------------------------------------------
'【修正 4】cmboxTrackIn_Click：「製程分支 C 續」區塊越界執行
' 現況結構：
'   If InStr(cellValueRunId, "B") ... Then        ' 分支 A: Baking
'   ElseIf InStr(cellValueRunId, "C") ... Then    ' 分支 B: Coating
'   ElseIf Not IsEmpty(...) ... Then              ' 分支 C: 一般製程
'       ...
'   End If                    ' ← (1) 這個 End If 收太早
'   '=== 製程分支 C 續 ===
'   ws.Cells(cellRunIDrow, 10).Value = ...        ' ← 對 A/B 分支也會執行！
'   ...零件計數 For j 迴圈（+1）與 OOC/OOS 檢查...
'   On Error GoTo 0
'   End If                    ' ← (2) 收外層 OPTSTB 的 If
'
' 影響：Baking / Coating Track In 之後，「分支 C 續」整段照樣執行，
' 造成第 10 欄 / AM / Q 被覆寫、零件壽命計數被重複 +1。
'
' 修法：把 (1) 的 End If 往下移到「分支 C 續」的 Next j 與 On Error GoTo 0 之後，
' 使整段只屬於分支 C。移動後結構：
'
'   ElseIf Not IsEmpty(...) ... Then              ' 分支 C
'       ...
'       '=== 製程分支 C 續 ===
'       ...For j = startCol To 38 ... Next j
'       On Error GoTo 0
'   End If                    ' ← 移到這裡（原 (1) 位置刪除）
'   End If                    ' 收外層 OPTSTB 的 If（原 (2) 不動）
'
' 另請刪除表單中殘留的 AI 對話註解（「請提供後續 2-2 的程式碼」、
' 「未完待續」等），並在 VBE 執行 Debug → Compile 確認結構平衡。
'--------------------------------------------------------------

'--------------------------------------------------------------
'【修正 5】UserForm_Initialize：Function_On 呼叫時機
' 原碼在 Set ws 之後立刻 Call Function_On，後續又繼續大量寫入控制項，
' 事件與畫面更新在初始化途中就被打開，既慢又可能觸發不必要的事件。
' 建議移除中段那一次 Function_On，只保留結尾的
'   Call Protect_1
'   Call Function_On
'--------------------------------------------------------------
