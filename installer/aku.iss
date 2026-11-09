; Instalador de Aku (Inno Setup 6). No se compila a mano: `npm run instalador`
; crea dist/Aku.exe y luego llama a ISCC con AppVersion, ExeFile, IconFile y OutDir.
; Se instala solo para el usuario (sin permisos de administrador) en %LOCALAPPDATA%\Programs\Aku.
; Los datos del usuario (%APPDATA%\Shiro, el nombre de antes) no se tocan al instalar ni al desinstalar.
;
; Antes se llamaba Shiro: el AppId es el mismo, así que Windows lo trata como una actualización,
; y [InstallDelete] quita el Shiro.exe viejo, su desinstalador y sus accesos directos.

; Valores por si se compila desde el editor de Inno Setup (antes hay que haber hecho `npm run exe`).
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ExeFile
  #define ExeFile "..\dist\Aku.exe"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{88E4D300-19B7-446E-8A71-8D749EE893A5}
AppName=Aku
AppVersion={#AppVersion}
AppVerName=Aku {#AppVersion}
AppPublisher=Aku
DefaultDirName={localappdata}\Programs\Aku
; La instalación de antes estaba en Programs\Shiro: se usa la carpeta nueva.
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=AkuSetup-{#AppVersion}
#ifdef IconFile
SetupIconFile={#IconFile}
#endif
UninstallDisplayIcon={app}\Aku.exe
UninstallDisplayName=Aku
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

[InstallDelete]
; Lo que dejó el instalador de cuando se llamaba Shiro (los datos están en otra carpeta y no se tocan).
Type: files; Name: "{localappdata}\Programs\Shiro\Shiro.exe"
Type: files; Name: "{localappdata}\Programs\Shiro\unins000.exe"
Type: files; Name: "{localappdata}\Programs\Shiro\unins000.dat"
Type: dirifempty; Name: "{localappdata}\Programs\Shiro"
Type: files; Name: "{autoprograms}\Shiro.lnk"
Type: files; Name: "{autodesktop}\Shiro.lnk"

[Files]
Source: "{#ExeFile}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Aku"; Filename: "{app}\Aku.exe"; Comment: "Aku, tu asistente"
Name: "{autodesktop}\Aku"; Filename: "{app}\Aku.exe"; Comment: "Aku, tu asistente"; Tasks: desktopicon

[Run]
Filename: "{app}\Aku.exe"; Description: "{cm:LaunchProgram,Aku}"; Flags: nowait postinstall skipifsilent
