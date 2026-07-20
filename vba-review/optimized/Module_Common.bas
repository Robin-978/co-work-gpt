Attribute VB_Name = "Module_Common"
Option Explicit

'==============================================================
' 共用工具模組（新增）
' 目的：消除全案 10+ 份重複的「工時計算 + 負值歸零 + 上色」
'       以及散落各處的小工具函式
'==============================================================

' 依 B 欄(開始) / C 欄(結束) 計算：
'   F 欄 = 時間差 hh:mm
'   G 欄 = 時間差(小時, 6 位小數)；負值歸 0 並以紅底標示
Public Sub WriteRunDuration(ByVal ws As Worksheet, ByVal r As Long)
    Dim d As Double

    If r < 1 Then Exit Sub
    If Not IsDate(ws.Cells(r, 2).Value) Then Exit Sub
    If Not IsDate(ws.Cells(r, 3).Value) Then Exit Sub

    d = ws.Cells(r, 3).Value - ws.Cells(r, 2).Value
    ws.Cells(r, 6).Value = Format$(IIf(d < 0, 0, d), "hh:mm")

    With ws.Cells(r, 7)
        If d < 0 Then
            .Value = 0
            .Font.Size = 12
            .Interior.Color = RGB(255, 0, 0)
        Else
            .Value = Format$(d * 24, "0.000000")
            .Font.Size = 8
            .Interior.Color = RGB(255, 255, 255)
        End If
        .Font.Color = RGB(0, 0, 0)
    End With
End Sub

' 取出字串中所有數字（修正原 TrackINOUT 版本的 Truedsff 打字錯誤）
Public Function ExtractNumbers(ByVal inputStr As String) As String
    Dim regEx As Object
    Dim matches As Object
    Dim match As Object
    Dim result As String

    Set regEx = CreateObject("VBScript.RegExp")
    regEx.Global = True            ' 原碼: Truedsff（未宣告變數 = False，只取得第一段數字）
    regEx.IgnoreCase = True
    regEx.Pattern = "\d+"

    If regEx.Test(inputStr) Then
        Set matches = regEx.Execute(inputStr)
        For Each match In matches
            result = result & match.Value
        Next match
    End If

    ExtractNumbers = result
End Function

' PM 類代碼判斷（EpiCode 系列共用）
Public Function IsPMCode(ByVal s As String) As Boolean
    Select Case s
        Case "RPM", "SPM", "PM", "APM"
            IsPMCode = True
    End Select
End Function

' 取得上次 PM Reset 列（Daily!AR1），未設定時回傳下限值
Public Function GetResetRow(ByVal ws As Worksheet, ByVal minRow As Long) As Long
    GetResetRow = Val(ws.Cells(1, "AR").Value)
    If GetResetRow < minRow Then GetResetRow = minRow
End Function
