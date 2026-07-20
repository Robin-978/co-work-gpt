Attribute VB_Name = "MainFlowOutput"
Option Explicit

'==============================================================
' MainFlowOutput（修正版）
' - 已修正：GetNumber 空字串型別錯誤、replaceandsplityA 的 Or 恆真、
'   CopyToDaily 未限定 Range / 迴圈內不變式、CopyMOsource 總結重複執行、
'   EpiCode CountIf 起算列、EpiCodeAll 重構
' - 已移除：EpiCodeV1、EpiCode2（舊版且含錯誤，無按鈕呼叫；如仍有他處呼叫請改呼叫 EpiCode）
' - 相依：Module_Common（WriteRunDuration / IsPMCode / GetResetRow）
'==============================================================

' 將查詢頁 B3 的字串拆成數字與文字，分別放入 C4 / D4
Sub GetNumber()
    Dim ws As Worksheet
    Dim cellValue As String
    Dim ch As String
    Dim i As Long
    Dim numPart As String, textPart As String

    Call Function_OFF
    Call unProtect_1

    Set ws = ThisWorkbook.Worksheets("查詢頁")
    cellValue = CStr(ws.Cells(3, 2).Value)

    For i = 1 To Len(cellValue)
        ch = Mid$(cellValue, i, 1)
        If ch Like "[0-9]" Then      ' 原碼 IsNumeric 會把 "." "-" "+" 也當數字
            numPart = numPart & ch
        Else
            textPart = textPart & ch
        End If
    Next i

    ' 修正：numPart 為空時，原碼 numPart * 0.5 會 Type mismatch
    If Len(numPart) > 0 Then
        ws.Cells(4, 3).Value = CDbl(numPart) * 0.5
    Else
        ws.Cells(4, 3).ClearContents
    End If
    ws.Cells(4, 4).Value = textPart
End Sub

' 將查詢頁 B2 的 Run ID 以 _ 與 ( 切段，寫入查詢頁第 3 列與 Sheet4 第 2 列
Sub replaceandsplityA()
    Dim ws As Worksheet, ws2 As Worksheet
    Dim cellValue As String
    Dim splitValues() As String
    Dim j As Long
    Dim counter As Long
    Dim maxParts As Long

    Call Function_OFF

    Set ws = ThisWorkbook.Worksheets("查詢頁")
    Set ws2 = ThisWorkbook.Worksheets("Sheet4")

    cellValue = CStr(ws.Range("B2").Value)
    cellValue = Replace(cellValue, "_", ".")
    cellValue = Replace(cellValue, "(", ".")
    splitValues = Split(cellValue, ".")

    ws.Range("A3:G3").ClearContents

    ' 修正：原判斷 <> "C" Or <> "B" 恆為 True，4 欄分支永遠不會執行
    ' （此判斷與 j 無關，一併移出迴圈）
    If Left$(CStr(ws.Range("B2").Value), 1) = "C" Or Left$(CStr(ws.Range("B2").Value), 1) = "B" Then
        maxParts = 4
    Else
        maxParts = 6
    End If

    counter = 0
    For j = 0 To UBound(splitValues)
        If counter >= maxParts Then Exit For
        ws.Cells(3, counter + 1).Value = splitValues(j)
        ws2.Cells(2, counter + 7).Value = splitValues(j)
        counter = counter + 1
    Next j
End Sub

' 依查詢頁 B5 的 Structure 到 AF 欄查找，將對應 C 欄資料寫入 B6 / G2
Sub FindDataCollection()
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim StructureInput As String
    Dim SheetRange As Range, SelectedCell As Range
    Dim splitValues() As String
    Dim i As Long, j As Long, upperJ As Long
    Dim counter As Long

    Call Function_OFF

    Set ws = ThisWorkbook.Worksheets("查詢頁")
    lastRow = ws.Cells(ws.Rows.Count, 3).End(xlUp).Row

    ws.Cells(6, 2).ClearContents
    StructureInput = CStr(ws.Cells(5, 2).Value)

    ' 將 C 欄逗號分隔內容拆到 AE/AF/AG（第 31~33 欄）
    For i = 12 To lastRow
        If ws.Cells(i, 3).Value <> "" Then
            splitValues = Split(CStr(ws.Cells(i, 3).Value), ",")
            counter = 30
            upperJ = UBound(splitValues)
            If upperJ > 2 Then upperJ = 2
            For j = 0 To upperJ
                ws.Cells(i, counter + 1).Value = splitValues(j)
                counter = counter + 1
            Next j
        End If
    Next i

    Set SheetRange = ws.Range("AF12:AF" & lastRow)
    Set SelectedCell = SheetRange.Find(StructureInput, LookIn:=xlValues, LookAt:=xlWhole)

    If Not SelectedCell Is Nothing Then
        ws.Cells(6, 2).Value = ws.Cells(SelectedCell.Row, 3).Value
    Else                                  ' 原碼 ElseIf SelectedCell Is Nothing 為冗餘
        ws.Cells(6, 2).Value = ws.Cells(13, 3).Value
    End If

    ws.Cells(2, 7).Value = ws.Cells(6, 2).Value

    Call Function_On
End Sub

' Track Out 時：寫入 Daily 的起訖時間並複製查詢頁資料到 LOG
Sub CopyToDaily()
    Dim ws As Worksheet, wss As Worksheet, wst As Worksheet
    Dim lastRow As Long, lastRowL As Long
    Dim lastCol As Long
    Dim i As Long

    Call Function_OFF
    Call unProtect_1

    Set ws = ThisWorkbook.Worksheets("Daily")
    Set wss = ThisWorkbook.Worksheets("查詢頁")
    Set wst = ThisWorkbook.Worksheets("LOG")

    lastRow = ws.Cells(ws.Rows.Count, 8).End(xlUp).Row   ' 原 lastRowH 與 lastRow 相同，已合併

    '============= 代入各儲存格值 ===============
    ws.Cells(lastRow, 2).Value = wss.Cells(2, 4).Value       ' Start time
    ws.Cells(lastRow, 3).Value = wss.Cells(2, 5).Value       ' End time
    ws.Cells(lastRow - 1, 3).Value = wss.Cells(2, 4).Value
    ws.Cells(lastRow + 1, 2).Value = wss.Cells(2, 5).Value

    Call WriteRunDuration(ws, lastRow)        ' 共用工時計算（Module_Common）
    Call WriteRunDuration(ws, lastRow - 1)

    '================= Copy Log Data ======================
    lastRowL = wst.Cells(wst.Rows.Count, 1).End(xlUp).Row
    lastCol = wss.Cells(2, wss.Columns.Count).End(xlToLeft).Column

    For i = 1 To lastCol
        wst.Cells(lastRowL + 1, i).Value = wss.Cells(2, i).Value
    Next i

    ' 修正：以下與 i 無關，原碼放在迴圈內被重複執行 lastCol 次
    wst.Cells(lastRowL + 1, "T").Value = Abs(wst.Cells(lastRowL + 1, "H").Value - wst.Cells(lastRowL, "H").Value)
    wst.Cells(lastRowL, "V").Value = wst.Cells(lastRowL + 1, "I").Value - wst.Cells(lastRowL, "I").Value
    wst.Cells(lastRowL, "U").Value = 6
    wst.Cells(lastRowL + 1, "U").Value = 6

    lastRowL = wst.Cells(wst.Rows.Count, 1).End(xlUp).Row
    If wst.Cells(lastRowL, "J").Value > wst.Cells(lastRowL, "U").Value Then
        wst.Cells(lastRowL, "X").Value = "dp>6"
        ws.Cells(lastRow, "AN").Value = "DP>6" & Chr(10) & ws.Cells(lastRow, "AS").Value
    End If

    ' 修正：Range 必須限定 wst，原碼在 LOG 非作用頁時會 Resize 錯誤範圍或直接 1004
    wst.ListObjects("表格1").Resize wst.Range("$A$2:$U$" & lastRowL)
End Sub

' Track Out 時：將查詢頁 MO 流量寫入 MO_Source 並檢查 Warning / 差值 / By Pass
Sub CopyMOsource()
    Dim wss As Worksheet, wst As Worksheet, ws3 As Worksheet
    Dim lastRow As Long, lastRow2 As Long
    Dim lastCol As Long, LastCols As Long
    Dim i As Long, j As Long
    Dim searchItem As String
    Dim warning As String, deltavalue As String, bypass As String
    Dim noteMsg As String

    Call Function_OFF
    Call unProtect_1

    Set wss = ThisWorkbook.Worksheets("查詢頁")
    Set wst = ThisWorkbook.Worksheets("MO_Source")
    Set ws3 = ThisWorkbook.Worksheets("Daily")

    lastCol = wss.Cells(5, wss.Columns.Count).End(xlToLeft).Column   ' 查詢頁
    LastCols = wst.Cells(8, wst.Columns.Count).End(xlToLeft).Column  ' MO_Source
    lastRow = wst.Cells(wst.Rows.Count, 1).End(xlUp).Row
    lastRow2 = ws3.Cells(ws3.Rows.Count, 8).End(xlUp).Row            ' 原碼 lastRow2 未宣告

    wst.Cells(lastRow + 1, 1).Value = wss.Cells(2, 1).Value

    On Error GoTo SearchError
    For i = 2 To LastCols
        For j = 4 To lastCol
            If wst.Cells(8, i).Value = wss.Cells(5, j).Value Then
                searchItem = wst.Cells(8, i).Value
                wst.Cells(lastRow + 1, i).Value = Format$(wss.Cells(7, j).Value, "0.00")

                If wst.Cells(lastRow, i).Value <> "" Then
                    ' TMGa_2 需 By Pass 檢查
                    If wst.Cells(8, i).Value = "TMGa_2" Then
                        If wst.Cells(lastRow + 1, i).Value <> "" And wst.Cells(2, i).Value <> "" _
                           And wst.Cells(4, i).Value > 0 And wst.Cells(5, i).Value = "" _
                           And wst.Cells(7, i).Value <> "" Then
                            If wst.Cells(lastRow + 1, i).Value < wst.Cells(4, i).Value + 100 Then
                                wst.Cells(lastRow + 1, i).Interior.Color = RGB(160, 0, 0)
                                wst.Cells(lastRow + 1, i).Font.Color = RGB(255, 255, 255)
                                wst.Cells(lastRow + 1, LastCols + 3).Value = wst.Cells(8, i).Value & "需By Pass"
                                wst.Cells(lastRow + 1, i).NoteText "需By Pass"
                            End If
                        End If
                    End If

                    ' 低於 Warning / 差值異常
                    If wst.Cells(lastRow + 1, i).Value <= wst.Cells(7, i).Value _
                       And wst.Cells(8, i).Value <> "" And wst.Cells(7, i).Value <> "" Then
                        wst.Cells(lastRow + 1, LastCols + 1).Value = _
                            wst.Cells(lastRow + 1, LastCols + 1).Value & "," & wst.Cells(8, i).Value
                        wst.Cells(lastRow + 1, i).NoteText "低於 Warning"
                        wst.Cells(lastRow + 1, i).Interior.Color = RGB(255, 0, 0)
                        wst.Cells(lastRow + 1, i).Font.Color = RGB(255, 255, 255)
                    ElseIf wst.Cells(lastRow + 1, i).Value > wst.Cells(lastRow, i).Value _
                       And wst.Cells(8, i).Value <> "" And wst.Cells(7, i).Value <> "" Then
                        wst.Cells(lastRow + 1, LastCols + 2).Value = _
                            wst.Cells(lastRow + 1, LastCols + 2).Value & "," & wst.Cells(8, i).Value
                        wst.Cells(lastRow + 1, i).NoteText "差值異常"
                        wst.Cells(lastRow + 1, i).Interior.Color = RGB(255, 0, 0)
                        wst.Cells(lastRow + 1, i).Font.Color = RGB(255, 255, 255)
                    End If
                End If

                Exit For   ' 每個 MO 項目只會對到一欄，找到即可跳出內圈
            End If
        Next j
    Next i
    On Error GoTo 0

    ' 修正：總結備註原在雙迴圈內層被重複執行數十次，移到迴圈外只做一次
    warning = CStr(wst.Cells(lastRow + 1, LastCols + 1).Value)
    deltavalue = CStr(wst.Cells(lastRow + 1, LastCols + 2).Value)
    bypass = CStr(wst.Cells(lastRow + 1, LastCols + 3).Value)

    noteMsg = ""
    If warning <> "" Then noteMsg = "低於 Warning:" & warning
    If deltavalue <> "" Then
        If noteMsg <> "" Then
            noteMsg = noteMsg & "; 差值異常:" & deltavalue
        Else
            noteMsg = "MO異常:" & deltavalue
        End If
    End If
    If bypass <> "" Then
        If noteMsg <> "" Then
            noteMsg = noteMsg & Chr(10) & ";需By Pass" & bypass
        Else
            noteMsg = "需By Pass" & bypass
        End If
    End If

    If noteMsg <> "" Then
        wst.Cells(lastRow + 1, 1).NoteText noteMsg
        ws3.Cells(lastRow2, "AQ").Value = noteMsg
    End If

    Call Function_On
    Exit Sub

SearchError:
    Call Function_On
    MsgBox "在檔案 " & wss.Name & " 中無法找到項目: " & searchItem, vbExclamation
    Resume Next
End Sub

'==============================================================
' EpiCode：計算單一列的 Run Code（L 欄）
' 修正：CountIf 從上次 PM Reset 列（AR1）起算，而非固定 I1
'==============================================================
Sub EpiCode(ByVal cellRunIDrow As Long)
    Dim ws As Worksheet, ws2 As Worksheet
    Dim i As Long
    Dim result As Long
    Dim WaferQty As Variant
    Dim resetRow As Long

    ' 暫存變數，避免重複讀取儲存格
    Dim valH As String, valI As String, valJ As String, valK As String
    Dim valL As String, valQ As String, valAM As Variant
    Dim valAR2 As String, valAR5 As String

    i = cellRunIDrow
    Call Function_OFF

    Set ws = ThisWorkbook.Worksheets("Daily")
    Set ws2 = ThisWorkbook.Worksheets("查詢頁")

    valH = CStr(ws.Cells(i, "H").Value)
    valI = CStr(ws.Cells(i, "I").Value)
    valJ = CStr(ws.Cells(i, "J").Value)
    valK = CStr(ws.Cells(i, "K").Value)
    valL = CStr(ws.Cells(i, "L").Value)
    valQ = CStr(ws.Cells(i, "Q").Value)
    valAM = ws.Cells(i, "AM").Value

    valAR2 = CStr(ws.Cells(2, "AR").Value)
    valAR5 = CStr(ws.Cells(5, "AR").Value)

    ' 1. I 欄為空 → 沿用上一列 Code 加 W
    If valI = "" Then
        Dim prevL As String
        prevL = CStr(ws.Cells(i - 1, "L").Value)
        If prevL <> "" And Right$(prevL, 1) <> "W" Then
            ws.Cells(i, "L").Value = prevL & "W"
        End If
        Exit Sub
    End If

    ' 2. L 欄已是 UD 且 I/J 欄為 PM → 不動作
    If valL = "UD" And (valI = "PM" Or valJ = "PM") Then
        Exit Sub
    End If

    ' 3. L 欄為空時的 PM Reset 檢查
    If valL = "" Then
        If IsPMCode(valI) Or IsPMCode(valH) Or IsPMCode(valJ) Then
            ws.Cells(1, "AR").Value = i
            ws.Cells(2, "AR").Value = ""
            ws.Cells(i, "L").Value = "SD"
            Exit Sub
        End If
    End If

    ' 4. Q 欄與 AR5 皆為 PM
    If valQ = "PM" And valAR5 = "PM" Then
        ws.Cells(i, "L").Value = "T"
        Exit Sub
    End If

    ' 統計自上次 PM Reset 以來相同 Recipe 的次數
    resetRow = GetResetRow(ws, 1)
    result = Application.WorksheetFunction.CountIf(ws.Range("I" & resetRow & ":I" & i), valI)

    ' 5. AR5 為 PM、Q 欄不是 PM、投片 < 7、查詢頁不是 E
    If valQ <> "PM" And valAR5 = "PM" And valAM < 7 And ws2.Cells(1, 13).Value <> "E" Then
        If valI = "Baking" Or valI = "Coating" Then
            If result = 1 And valAR2 <> "P" Then ws.Cells(i, "L").Value = "SDC"
            If result > 1 And valAR2 <> "P" Then ws.Cells(i, "L").Value = "C"
            If result > 1 And valAR2 = "P" Then ws.Cells(i, "L").Value = "CT"
        Else
            ws.Cells(i, "L").Value = "T3"
        End If
        Exit Sub
    End If

    ' 6. 標準製程（Q 欄與 AR5 皆非 PM）
    If valQ <> "PM" And valAR5 <> "PM" Then

        If valI = "Baking" Or valI = "Coating" Then
            If Left$(valJ, 1) <> "E" Then
                If result = 1 And valAR2 <> "P" Then
                    ws.Cells(i, "L").Value = "SDC"
                ElseIf result > 1 And valAR2 <> "P" Then
                    ws.Cells(i, "L").Value = "C"
                ElseIf result > 1 And valAR2 = "P" Then
                    ws.Cells(i, "L").Value = "CT"
                End If
            End If
        Else
            WaferQty = valAM

            If WaferQty > 0 And Left$(valJ, 1) = "E" Then
                ws.Cells(i, "L").Value = "E"

            ElseIf WaferQty >= 5 And Left$(valJ, 1) <> "E" Then
                ws.Cells(2, "AR").Value = "P"
                ws.Cells(i, "L").Value = "P"

            ElseIf WaferQty < 5 And WaferQty > 0 And Left$(valJ, 1) <> "E" And valAR2 <> "P" Then
                If result = 1 Then
                    ws.Cells(i, "L").Value = "T"
                ElseIf result > 1 Then
                    ws.Cells(i, "L").Value = "T3"
                End If

            ElseIf Left$(valJ, 1) <> "E" And valAR2 = "P" Then
                If result >= 1 Then
                    If InStr(1, valK, "Capless", vbTextCompare) = 0 Then
                        ws.Cells(i, "L").Value = "T5"
                    Else
                        ws.Cells(i, "L").Value = "PC"
                    End If
                End If
            End If
        End If
    End If
End Sub

'==============================================================
' EpiCodeAll：全表重新計算 Run Code
' 重構：以列迴圈 + 快取值改寫；PM 判斷共用 IsPMCode；
'       修正 AR1 為空時 CountIf 範圍非法的問題
'==============================================================
Sub EpiCodeAll()
    Dim ws As Worksheet
    Dim lastRow As Long, resetRow As Long
    Dim r As Long
    Dim result As Long
    Dim WaferQty As Variant
    Dim valH As String, valI As String, valJ As String, valK As String

    Set ws = ThisWorkbook.Worksheets("Daily")
    lastRow = ws.Cells(ws.Rows.Count, 9).End(xlUp).Row

    Call Function_OFF
    Call unProtect_1

    resetRow = GetResetRow(ws, 7)

    For r = 7 To lastRow
        valH = CStr(ws.Cells(r, 8).Value)
        valI = CStr(ws.Cells(r, 9).Value)
        valJ = CStr(ws.Cells(r, 10).Value)
        valK = CStr(ws.Cells(r, 11).Value)

        If ws.Cells(r, 12).Value = "UD" And (valH = "UD" Or valI = "UD") Then
            ws.Cells(r, 8).Value = "UD"
            ws.Cells(r, 9).Value = "UD"
            ws.Cells(r, 10).Value = "UD"

        ElseIf valI <> "" Then
            If IsPMCode(valI) Or IsPMCode(valH) Or IsPMCode(valJ) Then
                ' PM Reset
                ws.Cells(1, "AR").Value = r
                resetRow = r
                ws.Cells(2, "AR").Value = ""
                ws.Cells(r, "L").Value = "SD"

                ws.Cells(r - 1, 12).Value = "WS"
                If ws.Cells(r - 1, 11).Value <> "" Then
                    ws.Cells(r - 1, 11).Value = ws.Cells(r - 1, 11).Value & "; Wait cool down"
                Else
                    ws.Cells(r - 1, 11).Value = "Wait Cool Down"
                End If

            ElseIf valH <> "Standby" Then
                result = Application.WorksheetFunction.CountIf(ws.Range("I" & resetRow & ":I" & r), valI)

                If valI = "Baking" Or valI = "Coating" Then
                    If ws.Cells(r, 12).Value <> "E" Then
                        If result = 1 And ws.Cells(2, "AR").Value <> "P" Then
                            ws.Cells(r, "L").Value = "SDC"
                        ElseIf result > 1 And ws.Cells(2, "AR").Value <> "P" Then
                            ws.Cells(r, "L").Value = "C"
                        ElseIf result > 1 And ws.Cells(2, "AR").Value = "P" Then
                            ws.Cells(r, "L").Value = "CT"
                        End If
                    End If
                Else
                    WaferQty = ws.Cells(r, "AM").Value

                    If WaferQty >= 0 And Left$(valJ, 1) = "E" Then
                        ws.Cells(r, "L").Value = "E"
                    ElseIf WaferQty >= 5 And Left$(valJ, 1) <> "E" Then
                        ws.Cells(2, "AR").Value = "P"
                        ws.Cells(r, "L").Value = "P"
                    ElseIf WaferQty < 5 And WaferQty > 0 And Left$(valJ, 1) <> "E" And ws.Cells(2, "AR").Value <> "P" Then
                        If result = 1 Then
                            ws.Cells(r, "L").Value = "T"
                        ElseIf result > 1 Then
                            ws.Cells(r, "L").Value = "T3"
                        End If
                    ElseIf Left$(valJ, 1) <> "E" And ws.Cells(2, "AR").Value = "P" Then
                        If result >= 1 Then
                            If InStr(1, valK, "Capless", vbTextCompare) = 0 Then
                                ws.Cells(r, "L").Value = "T5"
                            Else
                                ws.Cells(r, "L").Value = "PC"
                            End If
                        End If
                    End If
                End If
            End If

        Else   ' valI = ""：沿用上一列 Code 加 W
            If ws.Cells(r - 1, "L").Value <> "" And Right$(CStr(ws.Cells(r - 1, "L").Value), 1) <> "W" _
               And ws.Cells(r, "L").Value <> "ST" Then
                ws.Cells(r, "L").Value = ws.Cells(r - 1, "L").Value & "W"
            End If
        End If

        If valH = "Standby" Then ws.Cells(r, "L").Value = "ST"
    Next r
End Sub
