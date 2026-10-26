/**
 * `npm run exe`: crea dist/Shiro.exe, un solo archivo con todo Shiro dentro (Node SEA).
 *
 * 1. esbuild junta el código (src + node_modules) en un único .mjs.
 * 2. La web (public/), sus librerías y el motor de SQLite van dentro como assets (runtime.ts los lee).
 * 3. En Windows, a una copia de node.exe se le pone el icono y el nombre de Shiro.
 * 4. `node --build-sea` mete el código y los assets en esa copia → dist/Shiro.exe.
 * 5. Con `npm run instalador` (--instalador), Inno Setup lo empaqueta en dist/ShiroSetup-<versión>.exe
 *    (installer/shiro.iss).
 *
 * Los datos NO van dentro: el .exe usa la carpeta "data" a su lado si existe, si no %APPDATA%\Shiro.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { runPowerShell } from "./core/pc/powershell.js";
import { APP_DIR, APP_VERSION, SQL_WASM_FILE, VENDOR_FILES } from "./runtime.js";

const DIST = join(APP_DIR, "dist");
const WORK = join(DIST, "exe-build");
const OUTPUT = join(DIST, process.platform === "win32" ? "Shiro.exe" : "shiro");
const ICON = join(WORK, "shiro.ico");
const WANT_INSTALLER = process.argv.includes("--instalador");

/** Dependencias opcionales de librerías: si faltan, esas librerías funcionan igual. */
const OPTIONAL_DEPS = ["bufferutil", "utf-8-validate", "@aws-sdk/client-s3"];

/** Algunas librerías son CommonJS y usan require/__dirname, que no existen en un .mjs. */
const CJS_SHIMS = [
	"import { createRequire as __shiroCreateRequire } from 'node:module';",
	"const require = __shiroCreateRequire(import.meta.url);",
	"const __filename = import.meta.filename;",
	"const __dirname = import.meta.dirname;",
].join(" ");

function step(text: string): void {
	console.log(`  · ${text}`);
}

/** Archivos que van dentro del .exe: clave "public/js/app.js" → ruta en disco. */
function collectAssets(): Record<string, string> {
	const assets: Record<string, string> = {};
	const add = (rel: string) => {
		const full = join(APP_DIR, rel);
		if (!existsSync(full)) throw new Error(`Falta ${rel}. ¿Ejecutaste npm install?`);
		assets[rel] = full;
	};
	const walk = (rel: string) => {
		for (const e of readdirSync(join(APP_DIR, rel), { withFileTypes: true })) {
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else add(child);
		}
	};
	walk("public");
	for (const rel of Object.values(VENDOR_FILES)) add(rel);
	add(SQL_WASM_FILE);
	add("package.json");
	return assets;
}

function supportsBuildSea(): boolean {
	try {
		return execFileSync(process.execPath, ["--help"], { encoding: "utf8" }).includes("--build-sea");
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	console.log(`\n  Creando Shiro.exe (v${APP_VERSION})\n`);
	if (!supportsBuildSea()) {
		throw new Error(`Para crear el .exe hace falta Node.js 25.5 o más nuevo (tienes ${process.version}). Descárgalo de nodejs.org.`);
	}
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });

	step("Juntando el código en un solo archivo…");
	const bundle = join(WORK, "shiro.mjs");
	await build({
		entryPoints: [join(APP_DIR, "src", "index.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile: bundle,
		banner: { js: CJS_SHIMS },
		external: OPTIONAL_DEPS,
		logLevel: "warning",
	});

	step("Guardando la web y sus librerías dentro…");
	const assets = collectAssets();

	let base = process.execPath;
	if (process.platform === "win32") {
		step("Poniéndole el icono y el nombre de Shiro…");
		const copy = join(WORK, "node-base.exe");
		copyFileSync(process.execPath, copy);
		try {
			const cs = join(WORK, "ExeResources.cs");
			writeFileSync(cs, EXE_RESOURCES_SOURCE, "utf-8");
			await runPowerShell(
				"Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:SHIRO_A_CS)) -ReferencedAssemblies System.Drawing\n" +
					"[ShiroExeResources]::Apply($env:SHIRO_A_EXE, $env:SHIRO_A_PNG, $env:SHIRO_A_VERSION)\n" +
					"[ShiroExeResources]::WriteIco($env:SHIRO_A_PNG, $env:SHIRO_A_ICO)",
				{ cs, exe: copy, png: join(APP_DIR, "public", "icons", "icon-512.png"), version: APP_VERSION, ico: ICON },
				120_000,
			);
			base = copy;
		} catch (err) {
			console.log(`    (no pude ponerle el icono: ${err instanceof Error ? err.message : String(err)}; el .exe funciona igual)`);
		}
	}

	step("Creando el ejecutable…");
	const built = join(WORK, process.platform === "win32" ? "Shiro.exe" : "shiro");
	const config = join(WORK, "sea-config.json");
	writeFileSync(
		config,
		JSON.stringify(
			{
				main: bundle,
				mainFormat: "module",
				executable: base,
				output: built,
				disableExperimentalSEAWarning: true,
				// Avisos técnicos de librerías (p. ej. "punycode is deprecated"): no le sirven a quien usa el .exe.
				execArgv: ["--no-deprecation"],
				useSnapshot: false,
				useCodeCache: false,
				assets,
			},
			null,
			2,
		),
	);
	execFileSync(process.execPath, ["--build-sea", config], { stdio: ["ignore", "ignore", "inherit"] });

	try {
		rmSync(OUTPUT, { force: true });
		renameSync(built, OUTPUT);
	} catch {
		throw new Error(`No pude reemplazar ${OUTPUT}: ¿está abierto? Cierra Shiro (su consola) y vuelve a intentarlo.`);
	}
	const mb = Math.round(statSync(OUTPUT).size / 1024 / 1024);
	if (!WANT_INSTALLER) {
		rmSync(WORK, { recursive: true, force: true });
		console.log(`\n  ✓ Listo: ${OUTPUT} (${mb} MB)`);
		console.log("    Ábrelo con doble clic. Tus datos se guardan en la carpeta \"data\" junto al .exe si existe;");
		console.log("    si no, en %APPDATA%\\Shiro.\n");
		return;
	}

	step("Creando el instalador (Inno Setup)…");
	const setup = buildInstaller();
	rmSync(WORK, { recursive: true, force: true });
	console.log(`\n  ✓ Listo: ${setup} (${Math.round(statSync(setup).size / 1024 / 1024)} MB)`);
	console.log("    Es el archivo para instalar Shiro (aquí o en otro PC): doble clic → Instalar.");
	console.log("    Queda en el menú Inicio, se desinstala desde Configuración → Aplicaciones");
	console.log("    y tus datos van en %APPDATA%\\Shiro.\n");
}

/** ISCC.exe de Inno Setup 6 (winget lo instala para el usuario; su instalador normal, en Archivos de programa). */
function findIscc(): string | null {
	const env = process.env;
	const candidates = [
		join(env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
		join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
		join(env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
	];
	return candidates.find((c) => existsSync(c)) ?? null;
}

function buildInstaller(): string {
	if (process.platform !== "win32") throw new Error("El instalador solo se puede crear en Windows.");
	const iscc = findIscc();
	if (!iscc) throw new Error("Falta Inno Setup 6. Instálalo con: winget install --id JRSoftware.InnoSetup -e --scope user");
	const args = [`/DAppVersion=${APP_VERSION}`, `/DExeFile=${OUTPUT}`, `/DOutDir=${DIST}`, "/Q"];
	if (existsSync(ICON)) args.push(`/DIconFile=${ICON}`);
	args.push(join(APP_DIR, "installer", "shiro.iss"));
	execFileSync(iscc, args, { stdio: ["ignore", "ignore", "inherit"] });
	return join(DIST, `ShiroSetup-${APP_VERSION}.exe`);
}

/**
 * Cambia el icono y la información de versión (lo que muestran el Explorador y el Administrador de tareas)
 * de una copia de node.exe. Se compila con Add-Type (C# 5 de Windows PowerShell: sin $"" ni ?.).
 */
const EXE_RESOURCES_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ShiroExeResources {
	const int RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16;
	static readonly int[] Sizes = { 16, 24, 32, 48, 64, 128, 256 };

	delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
	delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
	[DllImport("kernel32.dll", SetLastError = true)]
	static extern bool FreeLibrary(IntPtr module);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
	[DllImport("kernel32.dll", SetLastError = true)]
	static extern bool EndUpdateResource(IntPtr update, bool discard);

	class Res { public int Type; public object Name; public ushort Lang; }

	public static void Apply(string exe, string png, string version) {
		StripSignature(exe);
		List<byte[]> icons = new List<byte[]>();
		using (Image src = Image.FromFile(png)) {
			foreach (int size in Sizes) icons.Add(Resize(src, size));
		}
		List<Res> old = Find(exe, new int[] { RT_ICON, RT_GROUP_ICON, RT_VERSION });
		ushort lang = 1033;
		foreach (Res r in old) if (r.Type == RT_GROUP_ICON) { lang = r.Lang; break; }

		IntPtr update = BeginUpdateResource(exe, false);
		if (update == IntPtr.Zero) throw new Exception("no pude abrir " + exe + " para editarlo");
		bool ok = false;
		try {
			foreach (Res r in old) Put(update, r.Type, r.Name, r.Lang, null);
			MemoryStream group = new MemoryStream();
			BinaryWriter w = new BinaryWriter(group);
			w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)icons.Count);
			for (int i = 0; i < icons.Count; i++) {
				byte side = (byte)(Sizes[i] >= 256 ? 0 : Sizes[i]);
				w.Write(side); w.Write(side); w.Write((byte)0); w.Write((byte)0);
				w.Write((ushort)1); w.Write((ushort)32);
				w.Write((uint)icons[i].Length);
				w.Write((ushort)(i + 1));
				Put(update, RT_ICON, i + 1, lang, icons[i]);
			}
			Put(update, RT_GROUP_ICON, 1, lang, group.ToArray());
			Put(update, RT_VERSION, 1, lang, VersionInfo(version));
			ok = true;
		} finally {
			bool saved = EndUpdateResource(update, !ok);
			if (ok && !saved) throw new Exception("no pude guardar los cambios (error " + Marshal.GetLastWin32Error() + ")");
		}
	}

	/** Icono .ico (todas las medidas, en PNG) para el instalador. */
	public static void WriteIco(string png, string path) {
		List<byte[]> icons = new List<byte[]>();
		using (Image src = Image.FromFile(png)) {
			foreach (int size in Sizes) icons.Add(Resize(src, size));
		}
		using (BinaryWriter w = new BinaryWriter(File.Create(path))) {
			w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)icons.Count);
			int offset = 6 + 16 * icons.Count;
			for (int i = 0; i < icons.Count; i++) {
				byte side = (byte)(Sizes[i] >= 256 ? 0 : Sizes[i]);
				w.Write(side); w.Write(side); w.Write((byte)0); w.Write((byte)0);
				w.Write((ushort)1); w.Write((ushort)32);
				w.Write((uint)icons[i].Length); w.Write((uint)offset);
				offset += icons[i].Length;
			}
			foreach (byte[] icon in icons) w.Write(icon);
		}
	}

	static byte[] Resize(Image src, int size) {
		using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
			using (Graphics g = Graphics.FromImage(bmp)) {
				g.InterpolationMode = InterpolationMode.HighQualityBicubic;
				g.SmoothingMode = SmoothingMode.HighQuality;
				g.PixelOffsetMode = PixelOffsetMode.HighQuality;
				g.CompositingQuality = CompositingQuality.HighQuality;
				g.DrawImage(src, 0, 0, size, size);
			}
			using (MemoryStream ms = new MemoryStream()) {
				bmp.Save(ms, ImageFormat.Png);
				return ms.ToArray();
			}
		}
	}

	static void Put(IntPtr update, int type, object name, ushort lang, byte[] data) {
		IntPtr ptr = NamePtr(name);
		try {
			if (!UpdateResource(update, new IntPtr(type), ptr, lang, data, data == null ? 0u : (uint)data.Length))
				throw new Exception("no pude cambiar un recurso (error " + Marshal.GetLastWin32Error() + ")");
		} finally {
			if (name is string) Marshal.FreeHGlobal(ptr);
		}
	}

	static object NameOf(IntPtr name) {
		long v = name.ToInt64();
		if ((v >> 16) == 0) return (int)v;
		return Marshal.PtrToStringUni(name);
	}

	static IntPtr NamePtr(object name) {
		if (name is int) return new IntPtr((int)name);
		return Marshal.StringToHGlobalUni((string)name);
	}

	static List<Res> Find(string exe, int[] types) {
		List<Res> found = new List<Res>();
		IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, 0x2 | 0x20);
		if (module == IntPtr.Zero) throw new Exception("no pude leer " + exe);
		try {
			foreach (int type in types) {
				List<object> names = new List<object>();
				EnumResourceNames(module, new IntPtr(type), delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) { names.Add(NameOf(n)); return true; }, IntPtr.Zero);
				foreach (object name in names) {
					IntPtr ptr = NamePtr(name);
					try {
						int resType = type;
						EnumResourceLanguages(module, new IntPtr(type), ptr, delegate(IntPtr m, IntPtr t, IntPtr n, ushort lang, IntPtr p) {
							Res r = new Res(); r.Type = resType; r.Name = name; r.Lang = lang; found.Add(r); return true;
						}, IntPtr.Zero);
					} finally {
						if (name is string) Marshal.FreeHGlobal(ptr);
					}
				}
			}
		} finally {
			FreeLibrary(module);
		}
		return found;
	}

	/** Quita la firma digital de node.exe (deja de ser válida al cambiar recursos). */
	static void StripSignature(string exe) {
		using (FileStream fs = new FileStream(exe, FileMode.Open, FileAccess.ReadWrite)) {
			BinaryReader r = new BinaryReader(fs);
			BinaryWriter w = new BinaryWriter(fs);
			fs.Position = 0x3C;
			int pe = r.ReadInt32();
			int optional = pe + 4 + 20;
			fs.Position = optional;
			ushort magic = r.ReadUInt16();
			int dirs = optional + (magic == 0x20B ? 112 : 96);
			long entry = dirs + 4 * 8;
			fs.Position = entry;
			uint offset = r.ReadUInt32();
			uint size = r.ReadUInt32();
			if (offset == 0 || size == 0) return;
			fs.Position = entry;
			w.Write(0u); w.Write(0u);
			w.Flush();
			if (offset + size >= fs.Length - 8) fs.SetLength(offset);
		}
	}

	static byte[] VersionInfo(string version) {
		ushort[] v = new ushort[4];
		string[] parts = version.Split('.');
		for (int i = 0; i < 4 && i < parts.Length; i++) { ushort n; if (UInt16.TryParse(parts[i], out n)) v[i] = n; }
		MemoryStream fixedInfo = new MemoryStream();
		BinaryWriter f = new BinaryWriter(fixedInfo);
		uint ms = ((uint)v[0] << 16) | v[1], ls = ((uint)v[2] << 16) | v[3];
		f.Write(0xFEEF04BDu); f.Write(0x00010000u);
		f.Write(ms); f.Write(ls); f.Write(ms); f.Write(ls);
		f.Write(0x3Fu); f.Write(0u); f.Write(0x00040004u); f.Write(1u); f.Write(0u); f.Write(0u); f.Write(0u);

		string[,] strings = {
			{ "CompanyName", "Shiro" },
			{ "FileDescription", "Shiro" },
			{ "FileVersion", version },
			{ "InternalName", "Shiro" },
			{ "OriginalFilename", "Shiro.exe" },
			{ "ProductName", "Shiro" },
			{ "ProductVersion", version },
		};
		List<byte[]> items = new List<byte[]>();
		for (int i = 0; i < strings.GetLength(0); i++) {
			string value = strings[i, 1];
			items.Add(Block(strings[i, 0], Encoding.Unicode.GetBytes(value + "\0"), value.Length + 1, 1));
		}
		byte[] table = Block("040904B0", null, 0, 1, items.ToArray());
		byte[] stringInfo = Block("StringFileInfo", null, 0, 1, table);
		byte[] translation = Block("Translation", BitConverter.GetBytes(0x04B00409u), 4, 0);
		byte[] varInfo = Block("VarFileInfo", null, 0, 1, translation);
		return Block("VS_VERSION_INFO", fixedInfo.ToArray(), 52, 0, stringInfo, varInfo);
	}

	/** Un bloque de VS_VERSIONINFO: cabecera, clave, valor e hijos, alineados a 4 bytes. */
	static byte[] Block(string key, byte[] value, int valueLength, ushort type, params byte[][] children) {
		MemoryStream ms = new MemoryStream();
		BinaryWriter w = new BinaryWriter(ms);
		w.Write((ushort)0);
		w.Write((ushort)valueLength);
		w.Write(type);
		w.Write(Encoding.Unicode.GetBytes(key + "\0"));
		Pad(w);
		if (value != null) w.Write(value);
		foreach (byte[] child in children) { Pad(w); w.Write(child); }
		byte[] result = ms.ToArray();
		result[0] = (byte)(result.Length & 0xFF);
		result[1] = (byte)(result.Length >> 8);
		return result;
	}

	static void Pad(BinaryWriter w) {
		while (w.BaseStream.Position % 4 != 0) w.Write((byte)0);
	}
}
`;

main().catch((err) => {
	console.error(`\n  ✗ No pude crear el .exe: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
