; Inno Setup Script for Tilbi
; This script creates a Windows installer for the Tilbi clipboard manager application
; REQUIRED: Run 'npm run build' first to create dist\win-unpacked\

#define MyAppName "Tilbi"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Tilbi"
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
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1; Check: not IsAdminInstallMode

[Files]
; Main application files - ALL files from the built Electron app
; This includes Tilbi.exe, all DLLs, resources (with app.asar), locales, etc.
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Include icon file explicitly for shortcuts
Source: "icons\icon.ico"; DestDir: "{app}\icons"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icons\icon.ico"; Tasks: quicklaunchicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  IsUpgrade: Boolean;

function InitializeSetup(): Boolean;
var
  AppDataPath: String;
  LocalAppDataPath: String;
begin
  Result := True;
  IsUpgrade := RegKeyExists(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#emit SetupSetting("AppId")}_is1');
  
  // Clean install: Delete existing app data on first install (not upgrade)
  if not IsUpgrade then
  begin
    AppDataPath := ExpandConstant('{userappdata}\{#MyAppName}');
    LocalAppDataPath := ExpandConstant('{localappdata}\{#MyAppName}');
    
    if DirExists(AppDataPath) then
    begin
      DelTree(AppDataPath, True, True, True);
    end;
    
    if DirExists(LocalAppDataPath) then
    begin
      DelTree(LocalAppDataPath, True, True, True);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  DesktopShortcut: String;
  IconOnlyShortcut: String;
  VBScript: String;
  VBScriptPath: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // Make desktop shortcut icon-only (no text label) using VBScript
    DesktopShortcut := ExpandConstant('{autodesktop}\{#MyAppName}.lnk');
    IconOnlyShortcut := ExpandConstant('{autodesktop}\ .lnk');
    if FileExists(DesktopShortcut) then
    begin
      VBScriptPath := ExpandConstant('{tmp}\HideShortcutLabel.vbs');
      VBScript := 'Set fso = CreateObject("Scripting.FileSystemObject")' + #13#10 +
                  'Set f = fso.GetFile("' + DesktopShortcut + '")' + #13#10 +
                  'f.Name = " .lnk"';
      SaveStringToFile(VBScriptPath, VBScript, False);
      Exec('cscript.exe', '/nologo "' + VBScriptPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      DeleteFile(VBScriptPath);
    end;
  end;
end;
