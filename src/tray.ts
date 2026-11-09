/**
 * Ícono de Aku en la bandeja de Windows (junto al reloj), mientras Aku está encendido.
 * Clic: abre la ventana (o la trae al frente). Clic derecho: un menú oscuro con la cabecera de Aku y su
 * estado, «Abrir Aku», «Hablarle» (la cajita de voz), «Nuevo chat» y «Salir de Aku».
 *
 * Lo dibuja un PowerShell oculto con System.Windows.Forms.NotifyIcon; el estilo del menú es C# (TRAY_CS),
 * que se compila una vez a una DLL en data/cache (como el ayudante nativo). Avisa de cada opción con una
 * línea en su salida (`open`, `talk`, `newchat`, `quit`). Revisa cada 2 s que Aku siga vivo: si se cierra
 * o falla, quita el ícono él solo. Los datos van por variables de entorno (`$env:SHIRO_A_*`), nunca en el script.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { readAppFile } from "./runtime.js";

/** Menú oscuro con los colores de Aku: esquinas redondeadas (Windows 11), íconos de Segoe Fluent Icons y cabecera. */
export const TRAY_CS = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AkuTray {
	public static class Native {
		[DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
		[DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

		public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

		/** Esquinas redondeadas y borde oscuro (en Windows 10 no hace nada). */
		public static void Round(IntPtr h) {
			int round = 2; DwmSetWindowAttribute(h, 33, ref round, 4);
			int border = 0x00403A3A; DwmSetWindowAttribute(h, 34, ref border, 4);
		}

		public static float Scale() {
			using (var g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f;
		}

		/** Un ícono de la fuente de símbolos de Windows como imagen (Fluent en Windows 11, MDL2 en Windows 10). */
		public static Bitmap Glyph(string glyph, Color color, int size) {
			var bmp = new Bitmap(size, size);
			string family = "Segoe MDL2 Assets";
			foreach (var f in FontFamily.Families) if (f.Name == "Segoe Fluent Icons") family = f.Name;
			using (var g = Graphics.FromImage(bmp))
			using (var font = new Font(family, size * 0.72f, GraphicsUnit.Pixel))
			using (var brush = new SolidBrush(color))
			using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {
				g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
				g.DrawString(glyph, font, brush, new RectangleF(0, 1, size, size), format);
			}
			return bmp;
		}
	}

	public class Colors : ProfessionalColorTable {
		public static readonly Color Bg = Color.FromArgb(31, 31, 34);
		public static readonly Color Hover = Color.FromArgb(50, 50, 56);
		public static readonly Color Line = Color.FromArgb(58, 58, 64);
		public static readonly Color Text = Color.FromArgb(236, 236, 236);
		public static readonly Color Muted = Color.FromArgb(154, 154, 160);
		public static readonly Color Danger = Color.FromArgb(255, 138, 128);
		public override Color ToolStripDropDownBackground { get { return Bg; } }
		public override Color ImageMarginGradientBegin { get { return Bg; } }
		public override Color ImageMarginGradientMiddle { get { return Bg; } }
		public override Color ImageMarginGradientEnd { get { return Bg; } }
		public override Color MenuBorder { get { return Line; } }
		public override Color MenuItemBorder { get { return Hover; } }
		public override Color MenuItemSelected { get { return Hover; } }
		public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
		public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
		public override Color SeparatorDark { get { return Line; } }
		public override Color SeparatorLight { get { return Bg; } }
	}

	public class Renderer : ToolStripProfessionalRenderer {
		/** Segunda línea de la cabecera ("Encendido · modelo"); se lee de un archivo al abrir el menú. */
		public static string Status = "";

		public Renderer() : base(new Colors()) { RoundedEdges = false; }

		protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { }

		protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
			var g = e.Graphics;
			using (var bg = new SolidBrush(Colors.Bg)) g.FillRectangle(bg, new Rectangle(Point.Empty, e.Item.Size));
			if (!e.Item.Selected || !e.Item.Enabled) return;
			g.SmoothingMode = SmoothingMode.AntiAlias;
			using (var path = RoundRect(new Rectangle(4, 1, e.Item.Width - 9, e.Item.Height - 2), 6))
			using (var b = new SolidBrush(Colors.Hover)) g.FillPath(b, path);
		}

		protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e) {
			if (e.Image != null) e.Graphics.DrawImage(e.Image, e.ImageRectangle);
		}

		protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
			string tag = e.Item.Tag as string;
			if (tag == "header") {
				var r = e.TextRectangle;
				using (var bold = new Font(e.TextFont.FontFamily, e.TextFont.Size + 1f, FontStyle.Bold))
				using (var small = new Font(e.TextFont.FontFamily, e.TextFont.Size - 1f)) {
					int top = (e.Item.Height - bold.Height - small.Height) / 2;
					TextRenderer.DrawText(e.Graphics, e.Item.Text, bold, new Point(r.X, top), Colors.Text);
					TextRenderer.DrawText(e.Graphics, Status, small, new Point(r.X, top + bold.Height), Colors.Muted);
				}
				return;
			}
			e.TextColor = tag == "danger" ? Colors.Danger : Colors.Text;
			base.OnRenderItemText(e);
		}

		protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
			int y = e.Item.Height / 2;
			using (var p = new Pen(Colors.Line)) e.Graphics.DrawLine(p, 10, y, e.Item.Width - 10, y);
		}

		static GraphicsPath RoundRect(Rectangle r, int radius) {
			int d = radius * 2;
			var p = new GraphicsPath();
			p.AddArc(r.X, r.Y, d, d, 180, 90);
			p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
			p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
			p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
			p.CloseFigure();
			return p;
		}
	}
}
`;

export const TRAY_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $env:SHIRO_A_DLL)) {
	Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:SHIRO_A_CS)) -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $env:SHIRO_A_DLL -OutputType Library
}
Add-Type -Path $env:SHIRO_A_DLL
[AkuTray.Native]::DpiAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
$scale = [AkuTray.Native]::Scale()
$name = $env:SHIRO_A_NAME
$src = New-Object System.Drawing.Bitmap $env:SHIRO_A_ICON
$small = New-Object System.Drawing.Bitmap $src, 32, 32
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.Icon]::FromHandle($small.GetHicon())
$tray.Text = $name

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Renderer = New-Object AkuTray.Renderer
$menu.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$menu.Padding = New-Object System.Windows.Forms.Padding 4, 6, 4, 6
$iconSize = [int](20 * $scale)
$menu.ImageScalingSize = New-Object System.Drawing.Size $iconSize, $iconSize
$text = [AkuTray.Colors]::Text
function Say([string]$what) { [Console]::Out.WriteLine($what); [Console]::Out.Flush() }
# Qué avisa cada opción (el clic busca su opción aquí; sin clausuras, que no siempre ven Say).
$events = @{}
function Item([string]$label, [int]$glyph, [string]$event, [System.Drawing.Color]$color, [string]$tag) {
	$it = New-Object System.Windows.Forms.ToolStripMenuItem $label
	$it.Image = [AkuTray.Native]::Glyph([string][char]$glyph, $color, $iconSize)
	$it.Padding = New-Object System.Windows.Forms.Padding 2, ([int](5 * $scale)), 2, ([int](5 * $scale))
	$it.Tag = $tag
	$events[$it] = $event
	$it.add_Click({ param($s, $a) [Console]::Out.WriteLine($events[$s]); [Console]::Out.Flush() })
	[void]$menu.Items.Add($it)
}

$header = New-Object System.Windows.Forms.ToolStripMenuItem $name
$header.Tag = 'header'
$header.Enabled = $false
$header.AutoSize = $false
$header.Height = [int](46 * $scale)
$header.Width = [int](230 * $scale)
$logo = New-Object System.Drawing.Bitmap $src, ([int](28 * $scale)), ([int](28 * $scale))
$header.Image = $logo
$header.ImageScaling = [System.Windows.Forms.ToolStripItemImageScaling]::None
[void]$menu.Items.Add($header)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Item ('Abrir ' + $name) 0xE8A7 'open' $text ''
Item 'Hablarle' 0xE720 'talk' $text ''
Item 'Nuevo chat' 0xE8F2 'newchat' $text ''
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Item ('Salir de ' + $name) 0xE7E8 'quit' ([AkuTray.Colors]::Danger) 'danger'

$menu.add_Opening({
	try { [AkuTray.Renderer]::Status = ([IO.File]::ReadAllText($env:SHIRO_A_STATUS)).Trim() } catch { [AkuTray.Renderer]::Status = 'Encendido' }
	# El menú toma el ancho de la opción más larga: que quepa también la línea del estado de la cabecera.
	$smallFont = New-Object System.Drawing.Font($menu.Font.FontFamily, ($menu.Font.Size - 1))
	$need = [System.Windows.Forms.TextRenderer]::MeasureText([AkuTray.Renderer]::Status, $smallFont).Width + [int](64 * $scale)
	$menu.MinimumSize = New-Object System.Drawing.Size ([Math]::Max([int](210 * $scale), $need)), 0
})
$menu.add_Opened({ [AkuTray.Native]::Round($menu.Handle) })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Say 'open' } })
$tray.Visible = $true

$parent = [int]$env:SHIRO_A_PARENT
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
Say 'ready'
[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
$tray.Dispose()
`;

/** Variables de entorno sin claves: el ícono no necesita ninguna (y así no las ve otro proceso). */
function trayEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) env[k] = v;
	}
	for (const [k, v] of Object.entries(extra)) env[`SHIRO_A_${k.toUpperCase()}`] = v;
	return env;
}

export type TrayEvent = "open" | "talk" | "newchat" | "quit";
export type TrayHandlers = Record<TrayEvent, () => void>;

/** Archivo con la segunda línea de la cabecera del menú ("Encendido · modelo"). */
const statusFile = () => join(DATA_DIR, "cache", "tray-status.txt");

/** Cambia el estado que muestra el menú (se lee cada vez que se abre). */
export function setTrayStatus(text: string): void {
	try {
		writeFileSync(statusFile(), text.slice(0, 60), "utf-8");
	} catch {
		// sin estado, el menú dice solo "Encendido"
	}
}

/** Pone el ícono en la bandeja. Solo en Windows; si algo falla, Aku sigue funcionando sin él. */
export function startTray(handlers: TrayHandlers, name = "Aku"): void {
	if (process.platform !== "win32") return;
	const dir = join(DATA_DIR, "cache");
	let icon: string;
	let cs: string;
	let dll: string;
	try {
		const png = readAppFile("public/Aku.png");
		if (!png) throw new Error("no encuentro public/Aku.png");
		mkdirSync(dir, { recursive: true });
		icon = join(dir, "aku-tray.png");
		writeFileSync(icon, png);
		const hash = createHash("sha256").update(TRAY_CS).digest("hex").slice(0, 12);
		cs = join(dir, `aku-tray-${hash}.cs`);
		dll = join(dir, `aku-tray-${hash}.dll`);
		if (!existsSync(dll)) writeFileSync(cs, TRAY_CS, "utf-8");
	} catch (err) {
		console.log(`  (No pude poner el ícono en la bandeja: ${err instanceof Error ? err.message : String(err)})`);
		return;
	}
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(TRAY_PS, "utf16le").toString("base64")],
		{
			env: trayEnv({ icon, name, cs, dll, status: statusFile(), parent: String(process.pid) }),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	const last: Partial<Record<TrayEvent, number>> = {};
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim() as TrayEvent;
			buffer = buffer.slice(nl + 1);
			if (!(line in handlers)) continue;
			// Un doble clic manda dos: con uno basta.
			if (Date.now() - (last[line] ?? 0) < 1500) continue;
			last[line] = Date.now();
			handlers[line]();
		}
	});
	let errors = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		errors = (errors + chunk).slice(-2000);
	});
	child.on("error", (err) => console.log(`  (No pude poner el ícono en la bandeja: ${err.message})`));
	child.on("exit", (code) => {
		if (code && errors.trim()) console.log(`  (El ícono de la bandeja se cerró: ${errors.trim().split("\n")[0]})`);
	});
	child.unref();
}
