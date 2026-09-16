; Inno Setup Script for Tilbi
; This script creates a Windows installer for the Tilbi clipboard manager application
; REQUIRED: Run 'npm run build' first to create dist\win-unpacked\

#define MyAppName "Tilbi"
#define MyAppVersion "1.0.4"
#define MyAppPublisher "Globinner"
#define MyAppURL "https://www.globinner.com"
#define MyAppExeName "Tilbi.exe"

[Setup]
; NOTE: The value of AppId uniquely identifies this application. Do not use the same AppId value in installers for other applications.
AppId={{F709B319-345F-436D-A852-AE8FC83D29D3}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=Tilbi-Setup
SetupIconFile=icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile=legal\EULA.txt
UninstallDisplayIcon={app}\icons\icon.ico
UninstallDisplayName={#MyAppName}
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Clipboard Manager
VersionInfoCopyright=Copyright (C) 2024 {#MyAppPublisher}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1; Check: not IsAdminInstallMode
Name: "startupicon"; Description: "Start {#MyAppName} when Windows starts"; GroupDescription: "Startup:"

[Files]
; Packaged Electron app only. Do NOT also copy a loose resources\app folder —
; Electron prefers that folder over app.asar and then crashes (missing electron-store).
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "icons\icon.ico"; DestDir: "{app}\icons"; Flags: ignoreversion
Source: "app-update.yml"; DestDir: "{app}\resources"; Flags: ignoreversion skipifsourcedoesntexist

[InstallDelete]
; Remove leftover unpacked app trees from older installers/hotfixes
Type: filesandordirs; Name: "{app}\resources\app"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
; Desktop shortcut: display name is "Tilbi" (not Tilbi.exe)
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico,0"; Comment: "{#MyAppName}"
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico,0"; Tasks: quicklaunchicon

[Registry]
; Add to Windows startup if task selected
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startupicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  IsUpgrade: Boolean;

function InitializeSetup(): Boolean;
begin
  Result := True;
  IsUpgrade := RegKeyExists(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#emit SetupSetting("AppId")}_is1');
  // Never delete user AppData here — upgrades and reinstalls must keep saved data.
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Desktop: String;
  BadShortcut: String;
  BadNames: array of String;
  LooseApp: String;
  I: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    LooseApp := ExpandConstant('{app}\resources\app');
    if DirExists(LooseApp) then
      DelTree(LooseApp, True, True, True);

    Desktop := ExpandConstant('{autodesktop}');
    BadNames := ['Tilbi.exe - Shortcut.lnk', '{#MyAppExeName} - Shortcut.lnk', 'Tilbi.exe.lnk', 'Loginner.lnk', 'Loginner.exe - Shortcut.lnk'];
    for I := 0 to GetArrayLength(BadNames) - 1 do
    begin
      BadShortcut := Desktop + '\' + BadNames[I];
      if FileExists(BadShortcut) then
        DeleteFile(BadShortcut);
    end;
  end;
end;
