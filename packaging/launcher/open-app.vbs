' Starts the server if needed, then opens the app in its own Chrome/Edge window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
appUrl = "http://localhost:5000/"

Function ServerUp()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", "http://127.0.0.1:5000/api/health", False
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function

Function FindBrowser()
  FindBrowser = ""
  On Error Resume Next
  For Each exe In Array("chrome.exe", "msedge.exe")
    For Each hive In Array("HKCU", "HKLM")
      p = ""
      p = sh.RegRead(hive & "\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" & exe & "\")
      If p <> "" Then
        p = Replace(p, Chr(34), "")
        If fso.FileExists(p) Then
          FindBrowser = p
          Exit Function
        End If
      End If
    Next
  Next
  On Error GoTo 0
End Function

q = Chr(34)
If Not ServerUp() Then
  sh.Run "wscript.exe " & q & here & "\start-server.vbs" & q, 0, False
  For i = 1 To 60
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
End If

browser = FindBrowser()
If browser <> "" Then
  sh.Run q & browser & q & " --app=" & appUrl, 1, False
Else
  ' Recording needs Chrome/Edge tab-audio sharing; fall back to the default browser anyway.
  sh.Run appUrl, 1, False
End If
