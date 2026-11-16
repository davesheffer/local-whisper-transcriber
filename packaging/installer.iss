; Meeting Transcriber - per-user Windows installer (no admin rights needed).
; Built by packaging\build-installer.ps1, which stages everything into StageDir:
;   app\{server,build,app.ico}  runtime\{node,python}  models\base  launcher\*
; Compile by hand: ISCC.exe /DAppVersion=1.0.0 /DStageDir=<stage> /O<outdir> installer.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef StageDir
  #define StageDir "stage"
#endif

#define AppName "Meeting Transcriber"

[Setup]
AppId={{6C1C1E0B-3C4E-4E43-9F1B-6A0F2C8E5D41}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppName}
DefaultDirName={userpf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Fixed folder: upgrade/uninstall replace runtime\ and app\ wholesale, which must never
; hit same-named folders of the user's in a folder they picked.
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=MeetingTranscriber-Setup-{#AppVersion}
SetupIconFile={#StageDir}\app\app.ico
UninstallDisplayIcon={app}\app\app.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Our own [Code] stops the server; Restart Manager would only nag about node.exe.
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start the transcription server when I sign in (recommended)"; GroupDescription: "Background server:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[UninstallDelete]
; Created after install: logs, downloaded models, __pycache__. Only our own
; subfolders, never {app} itself (defence in depth: /DIR= can still pick a folder).
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\launcher"
Type: dirifempty; Name: "{app}"

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\open-app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\app\app.ico"; Comment: "Record meetings and transcribe them locally"
; Not "{#AppName}.lnk": install.ps1 (dev setup) owns that desktop shortcut name.
Name: "{userdesktop}\{#AppName} App";Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\open-app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\app\app.ico"; Comment: "Record meetings and transcribe them locally"; Tasks: desktopicon
; Not "{#AppName} Server": that name belongs to the dev install.ps1 autostart shortcut.
Name: "{userstartup}\{#AppName} Background Server";Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\start-server.vbs"""; WorkingDir: "{app}"; Comment: "Starts the local transcription server"; Tasks: autostart

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\open-app.vbs"""; Description: "Open {#AppName} now"; Flags: postinstall nowait skipifsilent

[Code]
{ True when no bundled node/python is left running. The stop script exits 1 if one
  survives; a blocked PowerShell (policy, AppLocker) also lands here as a failure. }
function StopServer(Dir: String): Boolean;
var
  Script: String;
  Code: Integer;
begin
  Script := AddBackslash(Dir) + 'launcher\stop-server.ps1';
  Result := not FileExists(Script);
  if not Result then
    Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
                   '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '"',
                   '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir: String;
begin
  Result := '';
  Dir := ExpandConstant('{app}');
  { Upgrade over an earlier install of ours (marker: our stop script). Its server
    locks files under runtime\, and runtime\ + app\ are replaced wholesale so
    removed files don't linger. models\ is kept: it holds models downloaded later. }
  if FileExists(AddBackslash(Dir) + 'launcher\stop-server.ps1') then
  begin
    if not StopServer(Dir) then
    begin
      Result := 'Meeting Transcriber is still running and could not be stopped. ' +
                'Sign out and back in (or restart the PC), then run Setup again.';
      exit;
    end;
    DelTree(AddBackslash(Dir) + 'runtime', True, True, True);
    DelTree(AddBackslash(Dir) + 'app', True, True, True);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopServer(ExpandConstant('{app}'));
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('Your recordings were kept in Documents\Meeting Recordings.', mbInformation, MB_OK);
end;
