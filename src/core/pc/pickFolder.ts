/**
 * Selector de carpetas de Windows. Se abre en el PC donde corre Shiro, así que solo se ofrece
 * si la web también está abierta en ese PC.
 */
import type { IncomingMessage } from "node:http";
import { IS_WINDOWS, runPowerShell } from "./powershell.js";

function isLoopback(req: IncomingMessage): boolean {
	const ip = req.socket.remoteAddress ?? "";
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export const canPickFolder = (req: IncomingMessage) => IS_WINDOWS && isLoopback(req);

const PICK_FOLDER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:SHIRO_A_TITLE
$d.ShowNewFolderButton = $false
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }
`;

/** Abre el selector y devuelve la carpeta elegida ("" si se canceló). */
export function pickFolder(title: string): Promise<string> {
	return runPowerShell(PICK_FOLDER_SCRIPT, { title }, 10 * 60_000);
}
