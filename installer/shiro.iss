; Instalador de Shiro (Inno Setup 6). No se compila a mano: `npm run instalador`
; crea dist/Shiro.exe y luego llama a ISCC con AppVersion, ExeFile, IconFile y OutDir.
; Se instala solo para el usuario (sin permisos de administrador) en %LOCALAPPDATA%\Programs\Shiro.
; Los datos del usuario (%APPDATA%\Shiro) no se tocan al desinstalar.

; Valores por si se compila desde el editor de Inno Setup (antes hay que haber hecho `npm run exe`).
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ExeFile
  #define ExeFile "..\dist\Shiro.exe"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{88E4D300-19B7-446E-8A71-8D749EE893A5}
AppName=Shiro
AppVersion={#AppVersion}
AppVerName=Shiro {#AppVersion}
AppPublisher=Shiro
DefaultDirName={localappdata}\Programs\Shiro
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=ShiroSetup-{#AppVersion}
#ifdef IconFile
SetupIconFile={#IconFile}
#endif
UninstallDisplayIcon={app}\Shiro.exe
UninstallDisplayName=Shiro
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#ExeFile}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Shiro"; Filename: "{app}\Shiro.exe"; Comment: "Shiro, tu asistente"
Name: "{autodesktop}\Shiro"; Filename: "{app}\Shiro.exe"; Comment: "Shiro, tu asistente"; Tasks: desktopicon

[Run]
Filename: "{app}\Shiro.exe"; Description: "{cm:LaunchProgram,Shiro}"; Flags: nowait postinstall skipifsilent
