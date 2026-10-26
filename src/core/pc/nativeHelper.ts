/**
 * Código C# que PowerShell compila una sola vez (ver ensureNativeHelper).
 * Da acceso a funciones de Windows que no tienen comando directo:
 * teclado y ratón (SendInput), ventanas (EnumWindows/ShowWindow) y volumen (Core Audio).
 */
export const NATIVE_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ShiroPc {
	[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IAudioEndpointVolume {
		int f(); int g(); int h(); int i();
		int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
		int j();
		int GetMasterVolumeLevelScalar(out float pfLevel);
		int k(); int l(); int m(); int n();
		int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
		int GetMute(out bool pbMute);
	}

	[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDevice {
		int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
	}

	[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDeviceEnumerator {
		int f();
		int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
	}

	[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
	class MMDeviceEnumeratorComObject { }

	public static class Audio {
		static IAudioEndpointVolume Endpoint() {
			var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
			IMMDevice device = null;
			Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
			IAudioEndpointVolume volume = null;
			var iid = typeof(IAudioEndpointVolume).GUID;
			Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, 0, out volume));
			return volume;
		}
		public static int GetVolume() {
			float v;
			Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
			return (int)Math.Round(v * 100);
		}
		public static void SetVolume(int percent) {
			float v = Math.Max(0, Math.Min(100, percent)) / 100f;
			Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty));
		}
		public static bool GetMute() {
			bool m;
			Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
			return m;
		}
		public static void SetMute(bool mute) {
			Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, Guid.Empty));
		}
	}

	public static class Input {
		[StructLayout(LayoutKind.Sequential)]
		struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
		[StructLayout(LayoutKind.Sequential)]
		struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
		[StructLayout(LayoutKind.Explicit)]
		struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
		[StructLayout(LayoutKind.Sequential)]
		struct INPUT { public uint type; public INPUTUNION u; }

		[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
		[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
		[DllImport("user32.dll")] static extern bool SetProcessDPIAware();

		const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

		static readonly HashSet<int> Extended = new HashSet<int> {
			0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90,
			0xA3, 0xA5, 0xAD, 0xAE, 0xAF, 0xB0, 0xB1, 0xB2, 0xB3
		};

		public static void DpiAware() { SetProcessDPIAware(); }

		static INPUT Key(int vk, bool up) {
			var i = new INPUT { type = 1 };
			i.u.ki.wVk = (ushort)vk;
			i.u.ki.dwFlags = (up ? KEYUP : 0) | (Extended.Contains(vk) ? EXTENDED : 0);
			return i;
		}

		static INPUT Char(char c, bool up) {
			var i = new INPUT { type = 1 };
			i.u.ki.wScan = c;
			i.u.ki.dwFlags = UNICODE | (up ? KEYUP : 0);
			return i;
		}

		static void Send(List<INPUT> list) {
			if (list.Count == 0) return;
			SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
		}

		/** Pulsa una combinación: baja las teclas en orden y las suelta al revés. */
		public static void Combo(int[] vks) {
			var list = new List<INPUT>();
			foreach (var vk in vks) list.Add(Key(vk, false));
			for (int n = vks.Length - 1; n >= 0; n--) list.Add(Key(vks[n], true));
			Send(list);
			Thread.Sleep(60);
		}

		/** Escribe texto tal cual (acentos, ñ, emojis) sin depender de la distribución del teclado. */
		public static void Type(string text) {
			var list = new List<INPUT>();
			foreach (char c in text) {
				if (c == '\r') continue;
				if (c == '\n') { list.Add(Key(0x0D, false)); list.Add(Key(0x0D, true)); }
				else if (c == '\t') { list.Add(Key(0x09, false)); list.Add(Key(0x09, true)); }
				else { list.Add(Char(c, false)); list.Add(Char(c, true)); }
				if (list.Count >= 40) { Send(list); list.Clear(); Thread.Sleep(8); }
			}
			Send(list);
		}

		public static void Move(int x, int y) { SetCursorPos(x, y); }

		public static void Click(string button, int count) {
			uint down = 0x0002, up = 0x0004;
			if (button == "right") { down = 0x0008; up = 0x0010; }
			else if (button == "middle") { down = 0x0020; up = 0x0040; }
			for (int n = 0; n < count; n++) {
				var list = new List<INPUT>();
				var d = new INPUT { type = 0 }; d.u.mi.dwFlags = down; list.Add(d);
				var u = new INPUT { type = 0 }; u.u.mi.dwFlags = up; list.Add(u);
				Send(list);
				Thread.Sleep(70);
			}
		}

		/** notches > 0 sube, < 0 baja. */
		public static void Scroll(int notches) {
			var i = new INPUT { type = 0 };
			i.u.mi.dwFlags = 0x0800;
			i.u.mi.mouseData = unchecked((uint)(notches * 120));
			Send(new List<INPUT> { i });
		}
	}

	/** Captura de la pantalla principal a JPEG (en C#: los scripts equivalentes los bloquea el antivirus). */
	public static class Screenshot {
		public static string Take(string path, int maxWidth, long quality) {
			Input.DpiAware();
			var b = global::System.Windows.Forms.Screen.PrimaryScreen.Bounds;
			using (var bmp = new global::System.Drawing.Bitmap(b.Width, b.Height)) {
				using (var g = global::System.Drawing.Graphics.FromImage(bmp)) {
					g.CopyFromScreen(b.X, b.Y, 0, 0, bmp.Size);
				}
				var img = bmp;
				bool scaled = b.Width > maxWidth;
				if (scaled) {
					int h = (int)((double)b.Height * maxWidth / b.Width);
					img = new global::System.Drawing.Bitmap(maxWidth, h);
					using (var g2 = global::System.Drawing.Graphics.FromImage(img)) {
						g2.InterpolationMode = global::System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
						g2.DrawImage(bmp, 0, 0, maxWidth, h);
					}
				}
				global::System.Drawing.Imaging.ImageCodecInfo codec = null;
				foreach (var c in global::System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders()) {
					if (c.MimeType == "image/jpeg") codec = c;
				}
				var ep = new global::System.Drawing.Imaging.EncoderParameters(1);
				ep.Param[0] = new global::System.Drawing.Imaging.EncoderParameter(global::System.Drawing.Imaging.Encoder.Quality, quality);
				img.Save(path, codec, ep);
				string result = "{\"sw\":" + b.Width + ",\"sh\":" + b.Height + ",\"w\":" + img.Width + ",\"h\":" + img.Height + "}";
				if (scaled) img.Dispose();
				return result;
			}
		}
	}

	public static class Windows {
		delegate bool EnumProc(IntPtr h, IntPtr l);
		[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
		[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
		[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
		[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
		[DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
		[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
		[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
		[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
		[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
		[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
		[DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
		[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

		/** Ventanas como las de Alt+Tab: "hwnd|pid|título". */
		public static string[] List() {
			var result = new List<string>();
			EnumWindows((h, l) => {
				if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
				int len = GetWindowTextLength(h);
				if (len == 0) return true;
				int cloaked;
				if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
				var sb = new StringBuilder(len + 1);
				GetWindowText(h, sb, sb.Capacity);
				uint pid;
				GetWindowThreadProcessId(h, out pid);
				result.Add(h.ToInt64() + "|" + pid + "|" + sb.ToString().Replace("|", "¦"));
				return true;
			}, IntPtr.Zero);
			return result.ToArray();
		}

		public static long Foreground() { return GetForegroundWindow().ToInt64(); }

		public static bool Focus(long hwnd) {
			var h = new IntPtr(hwnd);
			if (IsIconic(h)) ShowWindow(h, 9);
			// Windows solo deja traer ventanas al frente tras una pulsación: se simula Alt.
			Input.Combo(new int[] { 0x12 });
			return SetForegroundWindow(h);
		}

		public static void Show(long hwnd, int cmd) { ShowWindow(new IntPtr(hwnd), cmd); }

		public static void Close(long hwnd) { PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }
	}
}
`;
