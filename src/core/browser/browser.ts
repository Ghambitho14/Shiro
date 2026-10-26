/**
 * Navegador de Shiro: un Chrome/Edge sin ventana (headless) con su propio perfil en data/browser-profile.
 * El modelo lo maneja con la tool `browser`; la web lo muestra en vivo en el panel "Navegador"
 * (imágenes por CDP screencast) y el usuario también puede usarlo desde ahí.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Browser, CDPSession, ElementHandle, KeyInput, Page } from "puppeteer-core";
import { DATA_DIR } from "../../config/config.js";
import { SCREENSHOT_DIR } from "../pc/pc.js";
import { automationBrowsers } from "./findBrowser.js";
import {
	SNAPSHOT_JS,
	SNAPSHOT_MAX_ELEMENTS,
	SNAPSHOT_MAX_TEXT,
	formatSnapshot,
	hostOf,
	isShiroUrl,
	normalizeUrl,
	type PageSnapshot,
} from "./pageModel.js";

const PROFILE_DIR = join(DATA_DIR, "browser-profile");
/** Mínimo entre imágenes enviadas al panel (~14 por segundo). */
const FRAME_MIN_MS = 70;
/** Sin panel abierto y sin uso durante este tiempo, se cierra para liberar memoria. */
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;

export class BrowserError extends Error {}

export type BrowserState = { open: boolean; url: string; title: string; loading: boolean };
export type BrowserFrame = { data: string; width: number; height: number };
export type BrowserEvent = ({ type: "state" } & BrowserState) | ({ type: "frame" } & BrowserFrame);

/** Lo que el usuario hace en el panel (clics, rueda, teclas). Coordenadas en píxeles CSS de la página. */
export type BrowserInput =
	| { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number }
	| { type: "wheel"; x: number; y: number; deltaX?: number; deltaY?: number }
	| { type: "key"; key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
	| { type: "text"; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function friendlyNavError(err: unknown, url: string): Error {
	const msg = err instanceof Error ? err.message : String(err);
	if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE/.test(msg)) {
		return new BrowserError(`No se pudo abrir ${hostOf(url)}: la dirección no existe o no hay internet.`);
	}
	if (/ERR_CONNECTION_REFUSED/.test(msg)) return new BrowserError(`${hostOf(url)} rechazó la conexión (¿está encendido ese servidor?).`);
	if (/ERR_CERT|SSL/.test(msg)) return new BrowserError(`${hostOf(url)} tiene un certificado de seguridad inválido.`);
	if (/ERR_ABORTED/.test(msg)) return new BrowserError(`La carga de ${hostOf(url)} se interrumpió (quizá era una descarga, que están desactivadas).`);
	return new BrowserError(`No se pudo abrir ${hostOf(url)}: ${msg.split("\n")[0].slice(0, 200)}`);
}

class ShiroBrowser {
	private browser: Browser | null = null;
	private page: Page | null = null;
	private launching: Promise<Browser> | null = null;
	private cdp: CDPSession | null = null;
	private userAgent = "";
	private viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
	private listeners = new Set<(e: BrowserEvent) => void>();
	private lastFrame: BrowserFrame | null = null;
	private frameTimer: NodeJS.Timeout | null = null;
	private lastFrameSent = 0;
	private loadingTimer: NodeJS.Timeout | null = null;
	/** ref → descripción del último read (para explicar las aprobaciones). */
	private refs = new Map<number, string>();
	private lastUse = Date.now();
	state: BrowserState = { open: false, url: "", title: "", loading: false };

	constructor() {
		setInterval(() => {
			if (this.browser && !this.listeners.size && Date.now() - this.lastUse > IDLE_CLOSE_MS) void this.close();
		}, 60_000).unref();
	}

	isOpen(): boolean {
		return Boolean(this.browser?.connected && this.page && !this.page.isClosed());
	}

	/** Descripción del elemento [ref] según la última lectura de la página. */
	describeRef(ref: number): string | undefined {
		return this.refs.get(ref);
	}

	/** El panel se suscribe para recibir el estado y las imágenes; devuelve la función para darse de baja. */
	subscribe(fn: (e: BrowserEvent) => void): () => void {
		this.listeners.add(fn);
		fn({ type: "state", ...this.state });
		if (this.lastFrame && this.state.open) fn({ type: "frame", ...this.lastFrame });
		if (this.listeners.size === 1 && this.isOpen()) void this.startScreencast();
		return () => {
			this.listeners.delete(fn);
			if (!this.listeners.size) void this.stopScreencast();
		};
	}

	private emit(e: BrowserEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(e);
			} catch {
				/* un panel roto no afecta a los demás */
			}
		}
	}

	private setState(patch: Partial<BrowserState>): void {
		const next = { ...this.state, ...patch };
		if (next.open === this.state.open && next.url === this.state.url && next.title === this.state.title && next.loading === this.state.loading) return;
		this.state = next;
		this.emit({ type: "state", ...next });
	}

	private setLoading(loading: boolean): void {
		if (this.loadingTimer) clearTimeout(this.loadingTimer);
		this.loadingTimer = loading ? setTimeout(() => this.setState({ loading: false }), 20_000) : null;
		this.setState({ loading });
	}

	private touch(): void {
		this.lastUse = Date.now();
	}

	// ─────────────────────────── ciclo de vida ───────────────────────────

	private async launch(): Promise<Browser> {
		const candidates = automationBrowsers();
		if (!candidates.length) throw new BrowserError("No encontré Chrome ni Edge instalados: instala Google Chrome para usar el navegador de Shiro.");
		const { default: puppeteer } = await import("puppeteer-core");
		mkdirSync(PROFILE_DIR, { recursive: true });
		let browser: Browser | null = null;
		let lastError = "";
		// Se prueba cada navegador instalado hasta que uno arranque.
		for (const executablePath of candidates) {
			const startedAt = Date.now();
			try {
				browser = await puppeteer.launch({
					executablePath,
					headless: true,
					userDataDir: PROFILE_DIR,
					defaultViewport: null,
					args: [
						"--no-first-run",
						"--no-default-browser-check",
						"--disable-features=Translate,MediaRouter,OptimizationHints",
						"--disable-session-crashed-bubble",
						"--lang=es-ES",
						`--window-size=${this.viewport.width},${this.viewport.height}`,
					],
				});
				break;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				if (/already running|SingletonLock|user data directory is already in use/i.test(lastError)) {
					// Quedó abierto de antes (otro proceso de Shiro o un cierre brusco): se usa ese mismo.
					browser = await this.connectExisting(puppeteer, 0);
					if (browser) break;
					throw new BrowserError("El navegador de Shiro ya está abierto en otro proceso de Shiro. Ciérralo y vuelve a intentarlo.");
				}
				// Edge a veces arranca con un lanzador que se cierra enseguida y deja el navegador abierto aparte.
				browser = await this.connectExisting(puppeteer, startedAt);
				if (browser) break;
			}
		}
		if (!browser) throw new BrowserError(`No se pudo abrir el navegador: ${lastError.split("\n")[0].slice(0, 200)}`);
		this.browser = browser;
		this.userAgent = (await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
		// Las descargas quedan desactivadas: una web no puede dejar archivos en el PC.
		try {
			const session = await browser.target().createCDPSession();
			await session.send("Browser.setDownloadBehavior", { behavior: "deny" });
		} catch {
			/* versión sin este comando: no pasa nada */
		}
		browser.on("disconnected", () => {
			if (this.browser !== browser) return;
			this.browser = null;
			this.page = null;
			this.cdp = null;
			this.lastFrame = null;
			this.refs.clear();
			this.setState({ open: false, url: "", title: "", loading: false });
		});
		browser.on("targetcreated", async (target) => {
			// Enlaces que abren otra pestaña: se pasa a la nueva, que es lo que el usuario espera ver.
			if (target.type() !== "page") return;
			const page = await target.page().catch(() => null);
			if (page && page !== this.page) await this.adopt(page);
		});
		const [first] = await browser.pages();
		await this.adopt(first ?? (await browser.newPage()));
		return browser;
	}

	/**
	 * Se conecta a un navegador ya abierto con el perfil de Shiro (anuncia su puerto en DevToolsActivePort).
	 * `since`: solo si el archivo es de después de ese momento (0 = cualquiera).
	 */
	private async connectExisting(puppeteer: { connect(options: { browserURL: string; defaultViewport: null }): Promise<Browser> }, since: number): Promise<Browser | null> {
		const file = join(PROFILE_DIR, "DevToolsActivePort");
		for (let i = 0; i < (since ? 15 : 1); i++) {
			try {
				if (statSync(file).mtimeMs >= since - 1000) {
					const port = Number(readFileSync(file, "utf8").split(/\r?\n/)[0]);
					if (port > 0) return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
				}
			} catch {
				/* aún no existe o no responde */
			}
			await sleep(200);
		}
		return null;
	}

	private async ensurePage(): Promise<Page> {
		this.touch();
		if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page;
		if (this.browser?.connected) {
			await this.adopt(await this.browser.newPage());
			return this.page!;
		}
		this.launching ??= this.launch().finally(() => (this.launching = null));
		await this.launching;
		if (!this.page) throw new BrowserError("No se pudo abrir una pestaña en el navegador.");
		return this.page;
	}

	private requirePage(): Page {
		this.touch();
		if (!this.isOpen()) throw new BrowserError("El navegador está cerrado: ábrelo primero con action=open y una dirección.");
		return this.page!;
	}

	private async adopt(page: Page): Promise<void> {
		if (this.page === page) return;
		await this.stopScreencast();
		this.page = page;
		this.refs.clear();
		page.on("close", () => {
			if (this.page !== page) return;
			this.page = null;
			this.cdp = null;
			void this.browser
				?.pages()
				.then((pages) => {
					const next = pages.filter((p) => !p.isClosed()).pop();
					if (next) return this.adopt(next);
					this.setState({ url: "", title: "" });
				})
				.catch(() => {});
		});
		page.on("framenavigated", (frame) => {
			if (this.page === page && frame === page.mainFrame()) this.setState({ url: page.url() });
		});
		const onLoaded = () => {
			if (this.page !== page) return;
			this.setLoading(false);
			void page
				.title()
				.then((title) => this.setState({ title, url: page.url() }))
				.catch(() => {});
		};
		page.on("load", onLoaded);
		page.on("domcontentloaded", onLoaded);
		// Avisos de la página (alert, confirm): se aceptan los de salir de la página y se cierran los demás.
		page.on("dialog", (dialog) => {
			void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
		});
		try {
			if (this.userAgent) await page.setUserAgent(this.userAgent);
			await page.setExtraHTTPHeaders({ "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" });
			await page.setViewport(this.viewport);
		} catch {
			/* página cerrándose */
		}
		this.setState({ open: true, url: page.url(), title: await page.title().catch(() => "") });
		if (this.listeners.size) await this.startScreencast();
	}

	async close(): Promise<void> {
		const browser = this.browser;
		if (!browser) return;
		await this.stopScreencast();
		await browser.close().catch(() => {});
	}

	// ─────────────────────────── imagen en vivo ───────────────────────────

	private async startScreencast(): Promise<void> {
		const page = this.page;
		if (!page || this.cdp || page.isClosed()) return;
		try {
			const cdp = await page.createCDPSession();
			this.cdp = cdp;
			let gotFrame = false;
			cdp.on("Page.screencastFrame", (f) => {
				void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
				if (this.cdp !== cdp) return;
				gotFrame = true;
				this.pushFrame({ data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
			});
			const { width, height, deviceScaleFactor } = this.viewport;
			await cdp.send("Page.startScreencast", {
				format: "jpeg",
				quality: 70,
				maxWidth: Math.round(width * deviceScaleFactor),
				maxHeight: Math.round(height * deviceScaleFactor),
				everyNthFrame: 1,
			});
			// Una página quieta puede no mandar ninguna imagen: se hace una captura para empezar.
			setTimeout(() => {
				if (gotFrame || this.cdp !== cdp || page.isClosed()) return;
				void page
					.screenshot({ type: "jpeg", quality: 70, encoding: "base64" })
					.then((data) => this.cdp === cdp && this.pushFrame({ data: String(data), width, height }))
					.catch(() => {});
			}, 600);
		} catch {
			this.cdp = null;
		}
	}

	private async stopScreencast(): Promise<void> {
		const cdp = this.cdp;
		this.cdp = null;
		if (!cdp) return;
		await cdp.send("Page.stopScreencast").catch(() => {});
		await cdp.detach().catch(() => {});
	}

	private pushFrame(frame: BrowserFrame): void {
		this.lastFrame = frame;
		if (this.frameTimer) return;
		const wait = Math.max(0, FRAME_MIN_MS - (Date.now() - this.lastFrameSent));
		this.frameTimer = setTimeout(() => {
			this.frameTimer = null;
			this.lastFrameSent = Date.now();
			if (this.lastFrame) this.emit({ type: "frame", ...this.lastFrame });
		}, wait);
	}

	/** El panel cambió de tamaño: la página se adapta a él (como una ventana normal). */
	async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
		const next = {
			width: Math.round(clamp(width, 320, 1920)),
			height: Math.round(clamp(height, 240, 1400)),
			deviceScaleFactor: clamp(Math.round(deviceScaleFactor * 4) / 4, 1, 2),
		};
		const v = this.viewport;
		if (next.width === v.width && next.height === v.height && next.deviceScaleFactor === v.deviceScaleFactor) return;
		this.viewport = next;
		const page = this.page;
		if (!page || page.isClosed()) return;
		await page.setViewport(next).catch(() => {});
		if (this.cdp) {
			await this.stopScreencast();
			await this.startScreencast();
		}
	}

	// ─────────────────────────── acciones del usuario (panel) ───────────────────────────

	async navigate(input: string): Promise<void> {
		const url = normalizeUrl(input);
		const page = await this.ensurePage();
		this.setLoading(true);
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
		} catch (err) {
			this.setLoading(false);
			if (!/timeout/i.test(String(err))) throw friendlyNavError(err, url);
		}
	}

	async history(action: "back" | "forward" | "reload"): Promise<void> {
		const page = this.requirePage();
		this.setLoading(true);
		try {
			const opts = { waitUntil: "domcontentloaded" as const, timeout: NAV_TIMEOUT_MS };
			const r = action === "back" ? await page.goBack(opts) : action === "forward" ? await page.goForward(opts) : await page.reload(opts);
			if (!r && action !== "reload") this.setLoading(false);
		} catch (err) {
			this.setLoading(false);
			if (!/timeout/i.test(String(err))) throw friendlyNavError(err, this.state.url);
		}
	}

	async input(ev: BrowserInput): Promise<void> {
		const page = this.requirePage();
		const { width, height } = this.viewport;
		switch (ev.type) {
			case "click":
				await page.mouse.click(clamp(ev.x, 0, width), clamp(ev.y, 0, height), {
					button: ev.button ?? "left",
					clickCount: clamp(ev.clickCount ?? 1, 1, 3),
				});
				return;
			case "wheel":
				await page.mouse.move(clamp(ev.x, 0, width), clamp(ev.y, 0, height));
				await page.mouse.wheel({ deltaX: clamp(ev.deltaX ?? 0, -3000, 3000), deltaY: clamp(ev.deltaY ?? 0, -3000, 3000) });
				return;
			case "text":
				if (ev.text.length > 60) await page.keyboard.sendCharacter(ev.text);
				else await page.keyboard.type(ev.text);
				return;
			case "key": {
				const mods: KeyInput[] = [];
				if (ev.ctrl) mods.push("Control");
				if (ev.shift) mods.push("Shift");
				if (ev.alt) mods.push("Alt");
				if (ev.meta) mods.push("Meta");
				try {
					for (const m of mods) await page.keyboard.down(m);
					await page.keyboard.press(ev.key as KeyInput);
				} catch {
					/* tecla que Chrome no conoce: se ignora */
				} finally {
					for (const m of mods.reverse()) await page.keyboard.up(m).catch(() => {});
				}
				return;
			}
		}
	}

	// ─────────────────────────── acciones del modelo (tool browser) ───────────────────────────

	/** Espera a que la página termine de cargar lo principal (sin quedarse colgado). */
	private async settle(page: Page): Promise<void> {
		await sleep(300);
		await Promise.race([page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {}), sleep(4000)]);
	}

	async snapshot(): Promise<string> {
		const page = this.requirePage();
		if (isShiroUrl(page.url())) throw new BrowserError("Esta página es la propia web de Shiro: no la puedo leer desde el navegador.");
		let snap: PageSnapshot | null = null;
		for (let attempt = 0; attempt < 3 && !snap; attempt++) {
			try {
				snap = (await page.evaluate(`${SNAPSHOT_JS}(${SNAPSHOT_MAX_ELEMENTS}, ${SNAPSHOT_MAX_TEXT})`)) as PageSnapshot;
			} catch (err) {
				// La página estaba cambiando (navegación): se espera y se reintenta.
				if (attempt === 2 || !/context|navigat|detached/i.test(String(err))) throw new BrowserError(`No pude leer la página: ${String(err).slice(0, 200)}`);
				await sleep(800);
			}
		}
		this.refs = new Map(snap!.els.map((e) => [e.ref, `${e.kind}${e.name ? ` "${e.name}"` : ""}`]));
		this.setState({ title: snap!.title, url: snap!.url });
		return formatSnapshot(snap!);
	}

	async open(input: string): Promise<string> {
		const url = normalizeUrl(input);
		const page = await this.ensurePage();
		this.setLoading(true);
		let note = "";
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
		} catch (err) {
			if (!/timeout/i.test(String(err))) {
				this.setLoading(false);
				throw friendlyNavError(err, url);
			}
			note = "[La página tardó mucho en cargar; puede estar incompleta.]\n";
		}
		await this.settle(page);
		return note + (await this.snapshot());
	}

	private async element(ref: number): Promise<ElementHandle<Element>> {
		const page = this.requirePage();
		const el = await page.$(`[data-shiro-ref="${Math.trunc(ref)}"]`);
		if (!el) throw new BrowserError(`No encuentro el elemento [${ref}] (la página cambió). Usa action=read para ver los números actuales.`);
		await el.scrollIntoView().catch(() => {});
		return el;
	}

	async click(ref: number): Promise<string> {
		const page = this.requirePage();
		const el = await this.element(ref);
		try {
			await el.click({ delay: 30 });
		} catch {
			// Tapado por otro elemento o sin tamaño: clic directo desde la página.
			await page.evaluate(`(function(){var e=document.querySelector('[data-shiro-ref="${Math.trunc(ref)}"]');if(e)e.click();})()`);
		}
		await this.settle(page);
		return this.snapshot();
	}

	async type(ref: number, text: string, enter: boolean): Promise<string> {
		const page = this.requirePage();
		const el = await this.element(ref);
		const sel = `document.querySelector('[data-shiro-ref="${Math.trunc(ref)}"]')`;
		const tag = String(await page.evaluate(`(function(){var e=${sel};return e?e.tagName:""})()`).catch(() => "")).toLowerCase();
		if (tag === "select") {
			const chosen = await page.evaluate(
				`(function(t){var e=${sel};if(!e)return "";t=t.toLowerCase();for(var i=0;i<e.options.length;i++){var o=e.options[i];if(o.text.toLowerCase().indexOf(t)>=0||o.value.toLowerCase()===t){e.selectedIndex=i;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return o.text;}}return "";})(${JSON.stringify(text)})`,
			);
			if (!chosen) throw new BrowserError(`La lista [${ref}] no tiene ninguna opción parecida a "${text}".`);
		} else {
			await el.click();
			// Se reemplaza lo que hubiera escrito.
			const mod: KeyInput = process.platform === "darwin" ? "Meta" : "Control";
			await page.keyboard.down(mod);
			await page.keyboard.press("KeyA");
			await page.keyboard.up(mod);
			if (text) {
				if (text.length > 80) await page.keyboard.sendCharacter(text);
				else await page.keyboard.type(text, { delay: 12 });
			} else {
				await page.keyboard.press("Backspace");
			}
		}
		if (enter) await page.keyboard.press("Enter");
		await this.settle(page);
		return this.snapshot();
	}

	async scroll(direction: "up" | "down"): Promise<string> {
		const page = this.requirePage();
		const { width, height } = this.viewport;
		await page.mouse.move(width / 2, height / 2);
		await page.mouse.wheel({ deltaY: (direction === "up" ? -1 : 1) * Math.round(height * 0.8) });
		await sleep(500);
		return this.snapshot();
	}

	async back(): Promise<string> {
		const page = this.requirePage();
		const r = await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((err) => {
			if (/timeout/i.test(String(err))) return true;
			throw friendlyNavError(err, this.state.url);
		});
		if (!r) throw new BrowserError("No hay ninguna página anterior.");
		await this.settle(page);
		return this.snapshot();
	}

	async screenshot(): Promise<{ path: string; width: number; height: number }> {
		const page = this.requirePage();
		if (isShiroUrl(page.url())) throw new BrowserError("Esta página es la propia web de Shiro: no la capturo.");
		mkdirSync(SCREENSHOT_DIR, { recursive: true });
		const path = join(SCREENSHOT_DIR, `navegador-${Date.now()}.jpg`);
		await page.screenshot({ type: "jpeg", quality: 75, path });
		return { path, width: this.viewport.width, height: this.viewport.height };
	}
}

export const shiroBrowser = new ShiroBrowser();
