'==============================================================
' Sheet5 / ThisWorkbook / Module_AuditEnterprise 修正片段
'==============================================================
Option Explicit

'--------------------------------------------------------------
'【修正 1】Sheet5.cmdRunCode_Click：Call EpiCode 缺少必要參數
' EpiCode 的簽章是 Sub EpiCode(ByVal cellRunIDrow As Long)，
' 原碼 Call EpiCode 會編譯錯誤「Argument not optional」。
'--------------------------------------------------------------
'Private Sub cmdRunCode_Click()
'    Dim wsD As Worksheet
'    Dim lastRow As Long
'    Set wsD = ThisWorkbook.Worksheets("Daily")
'    lastRow = wsD.Cells(wsD.Rows.Count, 9).End(xlUp).Row
'    Call EpiCode(lastRow)
'    cmdRunCode.Enabled = False
'End Sub

'--------------------------------------------------------------
'【修正 2】Sheet5.cmdRunTime_Click / CommandButton2_Click：
' 模組有 Option Explicit，但迴圈變數 i（及 CommandButton2 的 j）未宣告
' → 編譯錯誤「Variable not defined」。
' 在各自 Sub 開頭補：
'   Dim i As Long            ' cmdRunTime_Click
'   Dim i As Long, j As Long ' CommandButton2_Click
'--------------------------------------------------------------

'--------------------------------------------------------------
'【修正 3】Sheet5.SaveUndoSnapshot：OldAddress / UndoStack 未宣告
' 若專案其他模組沒有這兩個全域變數，Sheet5 無法編譯。
' 此 Sub 目前沒有任何呼叫端：
'   a) 尚未完成的功能 → 補全域宣告：
'        Public OldAddress As String
'        Public UndoStack As New Collection
'   b) 廢棄功能 → 整段刪除（建議）
'--------------------------------------------------------------

'--------------------------------------------------------------
'【修正 4】Sheet5.CommandButton3_Click：
' cmdResetRunCode.Enabled = True 重複兩行，刪除其一。
'--------------------------------------------------------------

'--------------------------------------------------------------
'【修正 5】ThisWorkbook.Workbook_Activate：事件可能被永久關閉
' 原碼：
'   Call Function_OFF
'   If Application.CutCopyMode <> False Then Exit Sub   ' ← 從這裡離開時事件停在關閉狀態
'   Call Function_On
' 複製狀態下切回活頁簿，EnableEvents / ScreenUpdating 就再也不會恢復。
' OFF 完馬上 ON 本來就沒有淨效果，整段可簡化為：
'--------------------------------------------------------------
'Private Sub Workbook_Activate()
'    If Application.CutCopyMode <> False Then Exit Sub
'End Sub

'--------------------------------------------------------------
'【修正 6】Module_AuditEnterprise.AppendHiddenComment：
' 歷史合併（KeepLastNCommentEntries）是死碼
' 原碼開頭先把舊註解刪掉，之後 If tgt.Comment Is Nothing 永遠成立，
' Else 分支（合併歷史、保留最近 N 筆）永遠不會執行。
' 修正版：先取出舊文字再刪除；只合併本系統寫入的註解
' （以「流水號：」開頭辨識），外部貼上帶來的註解仍照原意丟棄。
'--------------------------------------------------------------
Public Sub AppendHiddenComment(ByVal tgt As Range, ByVal logID As Long, ByVal ts As Date, _
                               ByVal userName As String, ByVal fullName As String, _
                               ByVal computerName As String, ByVal fileName As String, _
                               ByVal oldText As String, ByVal newText As String, ByVal keepN As Long)
    On Error Resume Next

    Dim newEntry As String
    Dim existingText As String
    Dim mergedText As String

    ' 修正：先保留既有稽核註解內容，再刪除
    existingText = ""
    If Not tgt.Comment Is Nothing Then
        existingText = tgt.Comment.Text
        If Left$(existingText, 4) <> "流水號：" Then existingText = ""   ' 貼上帶來的外部註解不保留
        tgt.Comment.Delete
    End If
    If tgt.CommentThreaded.Count > 0 Then tgt.CommentThreaded.Delete

    newEntry = "流水號：" & logID & vbCrLf & _
               "變更日期時間：" & Format$(ts, "yyyy-mm-dd hh:nn:ss") & vbCrLf & _
               "username：" & userName & vbCrLf & _
               "使用者全名：" & fullName & vbCrLf & _
               "電腦名稱：" & computerName & vbCrLf & _
               "檔案名稱：" & fileName & vbCrLf & _
               "前值：" & oldText & vbCrLf & _
               "後值：" & newText

    If existingText = "" Then
        tgt.AddComment newEntry
    Else
        mergedText = newEntry & vbCrLf & String(40, "-") & vbCrLf & existingText
        tgt.AddComment KeepLastNCommentEntries(mergedText, keepN)
    End If

    tgt.Comment.Visible = False
    On Error GoTo 0
End Sub

'--------------------------------------------------------------
'【建議 7】Workbook_BeforeSave 每次存檔都同步寫網路磁碟 CSV
' \\tycba6\... 網路慢或斷線時，每次 Ctrl+S 都會卡住。
' 建議在 audit_global 加一個 SyncCsvOnSave 旗標控制：
'--------------------------------------------------------------
'Private Sub Workbook_BeforeSave(ByVal SaveAsUI As Boolean, Cancel As Boolean)
'    If GetGlobalFlag("SyncCsvOnSave", True) Then Call SyncSheetToCSV
'    Call Protect_1
'    Call Function_On
'End Sub

'--------------------------------------------------------------
'【建議 8】密碼集中管理
' "57732"（Daily 保護）散落在 Sheet5 多個 Sub 與 Protect_1/unProtect_1；
' "WU1974" 已是常數（Module_AuditEnterprise），但 Daily 的沒有。
' 建議統一：
'   Public Const DAILY_SHEET_PASSWORD As String = "57732"
' 並注意：VBA 專案本身若未上鎖，任何人 Alt+F11 即可看到所有密碼。
'--------------------------------------------------------------
