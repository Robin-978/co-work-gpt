'==============================================================
' PMForm 程式碼區（修正版）— 只取代程式碼，不動 .frx 版面
' 修正重點：
' 1. cmbSubmit_Click：改為「先驗證、後寫入」；驗證失敗不再隱藏按鈕
' 2. cmbSubmit_Click：lastRow1（未宣告，恆為 Empty）→ lastRow，
'    原本被 Resume Next 靜默跳過的工時計算恢復生效
' 3. cmbFinished_Click：移除空的 Date2 錯誤處理（原本出錯會靜默放棄後半段）、
'    宣告 result、工時計算改用共用 WriteRunDuration
' 4. QueryClose 補 Protect_1，與 cmbExit 行為一致
' 相依：Module_Common.WriteRunDuration
'==============================================================
Option Explicit

Private Sub cmbExit_Click()
    Call Function_On
    Call Protect_1
    ThisWorkbook.Save
    Unload Me
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    Call Function_On
    Call Protect_1        ' 修正：原本只恢復事件沒有恢復保護
End Sub

Private Sub UserForm_Initialize()
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim i As Long
    Dim cellValue As String

    Call Function_OFF
    Call unProtect_1

    On Error GoTo ErrorHandler
    Set ws = ThisWorkbook.Worksheets("Daily")
    lastRow = ws.Cells(ws.Rows.Count, 8).End(xlUp).Row
    On Error GoTo 0

    Me.txtOPID.Value = ""
    Me.txtPMNote.Value = ""

    For i = 1 To 21
        Me.Controls("ckb" & i).Caption = ws.Cells(2, i + 17).Value
    Next i

    ' ---- 狀態一：Waiting，準備 PM Track In ----
    If ws.Cells(lastRow, 2).Value <> "" And ws.Cells(lastRow, 3).Value = "" _
       And ws.Cells(2, 1).Value = "Waiting" Then

        For i = 1 To 21
            Me.Controls("ckb" & i).Value = False
        Next i
        For i = 1 To 4
            Me.Controls("ckbPMI0" & i).Value = False
        Next i

        Me.cmbSubmit.Enabled = True
        Me.cmbSubmit.Visible = True
        Me.cmbFinished.Enabled = False
        Me.cmbFinished.Visible = False
    End If

    ' ---- 狀態二：PM-ing，準備 PM Track Out ----
    If ws.Cells(lastRow, 2).Value <> "" And ws.Cells(lastRow, 3).Value = "" _
       And ws.Cells(2, 1).Value = "PM-ing" Then

        If ws.Cells(lastRow, 12).Value = "SD" Then
            Me.opbSD.Value = True
            Me.opbUDB.Value = False
        ElseIf ws.Cells(lastRow, 12).Value = "UD" Then
            Me.opbSD.Value = False
            Me.opbUDB.Value = True
        End If
        Me.opbSD.Enabled = True
        Me.opbUDB.Enabled = True

        For i = 1 To 21
            Me.Controls("ckb" & i).Value = (ws.Cells(lastRow, i + 17).Value = "V")
        Next i

        cellValue = CStr(ws.Cells(lastRow, 9).Value)
        Select Case cellValue
            Case "RPM": Me.ckbPMI01.Value = True
            Case "SPM": Me.ckbPMI02.Value = True
            Case "PM":  Me.ckbPMI03.Value = True
            Case "Gas": Me.ckbPMI04.Value = True
        End Select

        Me.cmbSubmit.Enabled = False
        Me.cmbSubmit.Visible = False
        Me.cmbFinished.Enabled = True
        Me.cmbFinished.Visible = True

    ' ---- 狀態三：上一筆 PM 已完成 ----
    ElseIf ws.Cells(lastRow, 2).Value <> "" And ws.Cells(lastRow, 3).Value <> "" _
       And ws.Cells(lastRow, 8).Value = "PM" Then

        For i = 1 To 21
            Me.Controls("ckb" & i).Value = False
        Next i

        Me.cmbSubmit.Enabled = True
        Me.cmbSubmit.Visible = True
        Me.cmbFinished.Enabled = False
        Me.cmbFinished.Visible = False
    End If

    Exit Sub
ErrorHandler:
    Call Function_On
    MsgBox "初始化過程中發生錯誤: " & Err.Description
End Sub

'==============================================================
' PM Track In
'==============================================================
Private Sub cmbSubmit_Click()
    Dim ws As Worksheet, ws2 As Worksheet
    Dim lastRow As Long, lastRow2 As Long
    Dim i As Long

    Set ws = ThisWorkbook.Worksheets("Daily")
    Set ws2 = ThisWorkbook.Worksheets("temp")
    lastRow = ws.Cells(ws.Rows.Count, 2).End(xlUp).Row
    lastRow2 = ws.Cells(ws.Rows.Count, 18).End(xlUp).Row

    ' ===== 修正：先驗證再寫入 =====
    ' 原碼先把 PM-ing / OPID 寫進工作表才驗證，失敗會留下半筆資料，
    ' 而且 EmptyEnd 會把 Submit 按鈕隱藏，使用者無法重試
    If Me.ckbPMI01.Value = False And Me.ckbPMI02.Value = False And _
       Me.ckbPMI03.Value = False And Me.ckbPMI04.Value = False Then
        MsgBox "未勾選 PM Item"
        Exit Sub
    End If

    If Me.opbSD.Value = False And Me.opbUDB.Value = False Then
        MsgBox "未勾選 PM Group"
        Exit Sub
    End If

    Call Function_OFF
    Call unProtect_1
    On Error GoTo ErrorDate

    ws.Cells(lastRow + 1, 8).Value = "PM-ing"
    ws.Cells(lastRow + 1, 4).Value = Me.txtOPID.Value
    ws.Cells(lastRow, 5).Value = Me.txtOPID.Value

    ' PM Group
    If Me.opbSD.Value Then
        ws.Cells(lastRow + 1, 12).Value = "SD"
        ws.Cells(1, 1).Value = "SD"
    Else
        ws.Cells(lastRow + 1, 12).Value = "UD"
        ws.Cells(1, 1).Value = "UD"
    End If

    ' PM Item
    If Me.ckbPMI01.Value Then
        ws.Cells(lastRow + 1, 9).Value = "RPM"
    ElseIf Me.ckbPMI02.Value Then
        ws.Cells(lastRow + 1, 9).Value = "SPM"
    ElseIf Me.ckbPMI03.Value Then
        ws.Cells(lastRow + 1, 9).Value = "PM"
    ElseIf Me.ckbPMI04.Value Then
        ws.Cells(lastRow + 1, 9).Value = "Gas"
    End If

    ' PM Note
    If Me.txtPMNote.Value <> "" Then
        If ws.Cells(lastRow + 1, 11).Value = "" Then
            ws.Cells(lastRow + 1, 11).Value = Me.txtPMNote.Value
        Else
            ws.Cells(lastRow + 1, 11).Value = Me.txtPMNote.Value & ";" & ws.Cells(lastRow + 1, 11).Value
        End If
    End If

    ' Track In / Out 時間
    If ws.Cells(lastRow + 1, 2).Value = "" And ws.Cells(lastRow, 3).Value = "" Then
        ws.Cells(lastRow + 1, 2).Value = Format$(Now, "YYYY/MM/DD hh:mm")
        ws.Cells(lastRow, 3).Value = Format$(ws.Cells(lastRow + 1, 2).Value, "YYYY/MM/DD hh:mm")
    End If

    ' 修正：原碼此處使用未宣告的 lastRow1（恆為 Empty → Cells(0,3) 出錯），
    ' 整段工時計算被 Resume Next 靜默跳過
    If ws.Cells(lastRow, 3).Value <> "" And ws.Cells(lastRow, 2).Value <> "" Then
        Call WriteRunDuration(ws, lastRow)
    End If

    ' 待機碼（W）處理
    If Right$(CStr(ws.Cells(lastRow - 1, 12).Value), 1) = "W" Then
        ws.Cells(lastRow, 12).Value = ws.Cells(lastRow - 1, 12).Value
    ElseIf ws.Cells(lastRow - 1, 12).Value <> "ST" Then
        ws.Cells(lastRow, 12).Value = ws.Cells(lastRow - 1, 12).Value & "W"
    End If

    ' 點檢項目
    For i = 1 To 21
        If Me.Controls("ckb" & i).Value = True Then
            ws.Cells(lastRow + 1, i + 17).Value = "V"
            If ws.Cells(lastRow + 1, 10).Value = "" Then
                ws.Cells(lastRow + 1, 10).Value = Me.Controls("ckb" & i).Caption
            Else
                ws.Cells(lastRow + 1, 10).Value = ws.Cells(lastRow + 1, 10).Value & "," & Me.Controls("ckb" & i).Caption
            End If
        Else
            ws.Cells(lastRow + 1, i + 17).Value = ws.Cells(lastRow2, i + 17).Value
        End If
    Next i
    On Error GoTo 0

    Me.cmbFinished.Enabled = True
    Me.cmbFinished.Visible = True

    ' 狀態重置
    ws.Cells(1, 1).Value = "PM"
    ws.Cells(2, 1).Value = "PM-ing"
    ws.Range("B1:B3").Value = ""
    ws.Range("C1:C3").Value = ""

    Call Protect_1
    Call Function_On
    ThisWorkbook.Save
    Unload Me
    Exit Sub

ErrorDate:
    Call Function_On
    Resume Next
End Sub

'==============================================================
' PM Track Out
'==============================================================
Private Sub cmbFinished_Click()
    Dim ws As Worksheet, ws2 As Worksheet
    Dim lastRow As Long, lastRow3 As Long
    Dim i As Long, j As Long
    Dim result As Long          ' 修正：原碼未宣告

    Set ws = ThisWorkbook.Worksheets("Daily")
    Set ws2 = ThisWorkbook.Worksheets("temp")
    lastRow = ws.Cells(ws.Rows.Count, 8).End(xlUp).Row
    lastRow3 = ws2.Cells(ws2.Rows.Count, 1).End(xlUp).Row

    Call Function_OFF
    Call unProtect_1

    ws.Cells(lastRow, 5).Value = Me.txtOPID.Value
    ws.Cells(lastRow + 1, 4).Value = Me.txtOPID.Value

    If ws.Cells(lastRow, 8).Value = "PM-ing" Then
        If ws.Cells(lastRow, 12).Value = "SD" Then
            Me.opbSD.Value = True
            Me.opbUDB.Value = False
            ws.Cells(lastRow, 8).Value = "PM"
        ElseIf ws.Cells(lastRow, 12).Value = "UD" Then
            Me.opbSD.Value = False
            Me.opbUDB.Value = True
            ws.Cells(lastRow, 8).Value = "UD"
            ws.Cells(lastRow, 9).Value = "UD"
            ws.Cells(lastRow, 10).Value = "UD"
        End If
    End If

    ws2.Range("C2:C" & lastRow3).Value = 0
    ws2.Range("F2:F100").Value = 0
    ws2.Cells(1, 3).Value = "T"

    ' 修正：原碼此段掛在空的 Date2 處理器上，一出錯就靜默放棄後半段所有回寫
    On Error GoTo ErrorDate
    If ws.Cells(lastRow, 8).Value <> "" Then
        If ws.Cells(lastRow, 2).Value <> "" And ws.Cells(lastRow, 3).Value = "" Then
            ws.Cells(lastRow, 3).Value = Format$(Now, "YYYY/MM/DD hh:mm")
            ws.Cells(lastRow + 1, 2).Value = Format$(ws.Cells(lastRow, 3).Value, "YYYY/MM/DD hh:mm")
        End If
        ' 共用工時計算：負值一律歸 0 並紅底標示
        ' （取代原本 C<B 時反向相減的寫法與其後永遠不會成立的負值檢查）
        Call WriteRunDuration(ws, lastRow)
    End If

    ' 點檢項目回寫
    For i = 1 To 21
        If Me.Controls("ckb" & i).Value = True Then
            ws.Cells(lastRow, i + 17).Value = 0
            If ws.Cells(lastRow, 11).Value = "" Then
                ws.Cells(lastRow, 11).Value = Me.Controls("ckb" & i).Caption & ";" & Chr(10)
            Else
                ws.Cells(lastRow, 11).Value = ws.Cells(lastRow, 11).Value & "," & Me.Controls("ckb" & i).Caption & ";" & Chr(10)
            End If
        Else
            If ws.Cells(lastRow, i + 17).Value = "V" Then
                For j = 1 To 21
                    If ws.Cells(lastRow - j, i + 17).Value > 0 And ws.Cells(lastRow - j, i + 17).Value <> "" _
                       And ws.Cells(lastRow - j, i + 17).Value <> "V" Then
                        ws.Cells(lastRow, i + 17).Value = ws.Cells(lastRow - j, i + 17).Value
                    End If
                Next j
            End If
        End If
    Next i

    ' PM Item 回寫
    If Me.ckbPMI01.Value Then
        ws.Cells(lastRow, 9).Value = "RPM":  ws.Cells(lastRow, 10).Value = "RPM"
    ElseIf Me.ckbPMI02.Value Then
        ws.Cells(lastRow, 9).Value = "SPM":  ws.Cells(lastRow, 10).Value = "SPM"
    ElseIf Me.ckbPMI03.Value Then
        ws.Cells(lastRow, 9).Value = "PM":   ws.Cells(lastRow, 10).Value = "PM"
    ElseIf Me.ckbPMI04.Value Then
        ws.Cells(lastRow, 9).Value = "Gas":  ws.Cells(lastRow, 10).Value = "Gas"
    Else
        ' 資料不完整時的保底寫法（維持原行為）
        ws.Cells(lastRow, 8).Value = "PM"
        ws.Cells(lastRow, 9).Value = "PM"
        ws.Cells(lastRow, 10).Value = "PM"
        ws.Cells(lastRow, 11).Value = "In/Out 輸入資料不完全"
        ws.Cells(lastRow, 12).Value = "SD"
    End If

    ' PM Note
    If Me.txtPMNote.Value = "" Then
        If ws.Cells(lastRow, 11).Value <> "" Then
            ws.Cells(lastRow, 11).Value = "Change:" & ws.Cells(lastRow, 11).Value
        End If
    Else
        If ws.Cells(lastRow, 11).Value <> "" Then
            ws.Cells(lastRow, 11).Value = "Change:" & Me.txtPMNote.Value & "," & ws.Cells(lastRow, 11).Value & ";" & Chr(10)
        Else
            ws.Cells(lastRow, 11).Value = "Change:" & Me.txtPMNote.Value & ";" & Chr(10)
        End If
    End If

    ' PM 序號（AU / AT 欄）
    j = lastRow
    ws.Cells(j, "AU").Value = "PM" & Format$(Year(ws.Cells(j, 2).Value), "00") & _
                              Format$(Month(ws.Cells(j, 2).Value), "00") & _
                              Format$(Day(ws.Cells(j, 2).Value), "00")
    result = Application.WorksheetFunction.CountIfs(ws.Range("AU6:AU" & j), ws.Cells(j, "AU").Value)
    ws.Cells(j, "AT").Value = ws.Cells(j, "AU").Value & result
    With ws.Cells(j, "AU")
        .Font.Size = 6
        .Font.Color = RGB(255, 255, 255)
    End With
    On Error GoTo 0

    Me.cmbSubmit.Enabled = True
    Me.cmbSubmit.Visible = True
    Me.cmbFinished.Enabled = False
    Me.cmbFinished.Visible = False

    ' 狀態重置
    ws.Cells(1, 1).Value = ""
    ws.Cells(2, 1).Value = "Waiting"
    ws.Cells(1, 2).Value = "Recipe執行後,"
    ws.Cells(2, 2).Value = "點選 Track In,"
    ws.Cells(3, 2).Value = "輸入Run ID"
    ws.Range("C1:C3").Value = ""

    Call Protect_1
    Call Function_On
    ThisWorkbook.Save
    Unload Me
    Exit Sub

ErrorDate:
    Call Function_On
    MsgBox "日期格式有錯"
    Resume Next
End Sub
