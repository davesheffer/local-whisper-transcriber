' Starts the bundled transcription server without a window (installed build).
' Layout: <root>\launcher\this.vbs, <root>\runtime\{node,python}, <root>\app\server, <root>\models
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logPath = logDir & "\server.log"
If fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 5242880 Then fso.CopyFile logPath, logPath & ".old", True : fso.DeleteFile logPath
End If

Set env = sh.Environment("Process")
env("TRANSCRIBER_PORT") = "5000"  ' open-app.vbs and the shortcuts expect 5000
env("HOST") = "127.0.0.1"         ' a user-level HOST must never expose recordings to the LAN
env("PYTHON_BIN") = root & "\runtime\python\python.exe"
env("WHISPER_MODELS_DIR") = root & "\models"
env("RECORDINGS_DIR") = sh.SpecialFolders("MyDocuments") & "\Meeting Recordings"
env("PYTHONNOUSERSITE") = "1"
env("HF_HUB_DISABLE_TELEMETRY") = "1"
env("HF_HUB_DISABLE_SYMLINKS_WARNING") = "1"

sh.CurrentDirectory = root & "\app\server"
q = Chr(34)
' cmd /c ""node.exe" server.js >> "log" 2>&1"  (outer quotes are stripped by cmd)
sh.Run "cmd /c " & q & q & root & "\runtime\node\node.exe" & q & " server.js >> " & q & logPath & q & " 2>&1" & q, 0, False
