Attribute VB_Name = "Module2"
Option Explicit

'==============================================================
' Module2（重寫版）：將 Daily 同步輸出成 UTF-8 CSV
' 修正：
' - 月份過濾 Month(...) >= Month(Now)-1 跨年失效 → 改用「上月 1 日」為界
' - CSV 欄位含引號 / 逗號 / 換行時會壞 → 加入 CsvQuote 轉義
' - On Error GoTo ErrHandler 被 Resume Next 覆蓋、handler 內 fs.Close 二次出錯
' - 移除未使用的 fileNum / ts / cellValue1..30 等 30 個變數
'==============================================================

Private Const CSV_FOLDER As String = "\\tycba6\tyc_odd_pde\10-EPI_Growth_log\OtherFunctions\RunList"
Private Const adWriteLine As Long = 1
Private Const adSaveCreateOverWrite As Long = 2
Private Const adStateOpen As Long = 1

Public Sub SyncSheetToCSV()
    Dim ws As Worksheet
    Dim fso As Object, fs As Object
    Dim csvPath As String
    Dim lastRow As Long
    Dim r As Long
    Dim line As String
    Dim cutoffDate As Date

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("Daily")
    On Error GoTo 0
    If ws Is Nothing Then
        MsgBox "錯誤：找不到名稱為 'Daily' 的工作表。", vbCritical
        Exit Sub
    End If

    Set fso = CreateObject("Scripting.FileSystemObject")
    csvPath = fso.BuildPath(CSV_FOLDER, fso.GetBaseName(ThisWorkbook.Name) & ".csv")

    lastRow = ws.Cells(ws.Rows.Count, "B").End(xlUp).Row
    If lastRow < 6 Then Exit Sub   ' 資料列自第 6 列起，無資料就不輸出

    ' 只輸出「上個月 1 日」之後的資料；DateSerial 會自動處理跨年（1 月 → 去年 12 月）
    cutoffDate = DateSerial(Year(Now), Month(Now) - 1, 1)

    On Error GoTo ErrHandler
    Set fs = CreateObject("ADODB.Stream")
    fs.Charset = "utf-8"
    fs.Open

    ' 首行：機台狀態
    If ws.Cells(1, 1).Value <> "" Then
        fs.WriteText CsvQuote(ws.Cells(1, 1).Text) & "," & CsvQuote(ws.Cells(2, 1).Text), adWriteLine
    Else
        fs.WriteText "Standby," & CsvQuote(ws.Cells(2, 1).Text), adWriteLine
    End If

    ' 標題列
    fs.WriteText "Track In,Track Out,Run ID,Structure,Version,Note,Code,Track In ID,Track Out ID", adWriteLine

    For r = 6 To lastRow
        If IsDate(ws.Cells(r, 2).Value) Then
            If ws.Cells(r, 2).Value >= cutoffDate Then
                line = CsvQuote(ws.Cells(r, 2).Text) & "," & _
                       CsvQuote(ws.Cells(r, 3).Text) & "," & _
                       CsvQuote(ws.Cells(r, 8).Text) & "," & _
                       CsvQuote(ws.Cells(r, 9).Text) & "," & _
                       CsvQuote(ws.Cells(r, 10).Text) & "," & _
                       CsvQuote(ws.Cells(r, 11).Text) & "," & _
                       CsvQuote(ws.Cells(r, 12).Text) & "," & _
                       CsvQuote(ws.Cells(r, 4).Text) & "," & _
                       CsvQuote(ws.Cells(r, 5).Text)
                fs.WriteText line, adWriteLine
            End If
        End If
    Next r

    fs.SaveToFile csvPath, adSaveCreateOverWrite
    fs.Close
    Set fs = Nothing
    Exit Sub

ErrHandler:
    ' 網路磁碟無法寫入等狀況：安靜收尾，不中斷存檔流程（由 Workbook_BeforeSave 呼叫）
    On Error Resume Next
    If Not fs Is Nothing Then
        If fs.State = adStateOpen Then fs.Close
    End If
    Set fs = Nothing
End Sub

' CSV 欄位轉義：包雙引號，內文的 " 轉成 ""
Private Function CsvQuote(ByVal s As String) As String
    CsvQuote = """" & Replace(s, """", """""") & """"
End Function
