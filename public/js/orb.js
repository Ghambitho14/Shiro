// Esfera holográfica del modo voz: un "holograma" dibujado en canvas, sin librerías.
// Capas de arcos, trazos tipo circuito, paneles, chispas y espigas sobre una esfera 3D que gira,
// con mezcla aditiva y un halo (bloom) barato. Reacciona a la fase del modo voz y al volumen.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Colores [r, g, b] de más oscuro a más brillante: amarillo al escuchar, azul al responder
// y rojizo al pedir permiso.
const PALETTES = {
	gold: [
		[205, 130, 0],
		[245, 185, 20],
		[255, 215, 55],
		[255, 236, 140],
		[255, 251, 226],
	],
	blue: [
		[18, 70, 200],
		[35, 120, 245],
		[70, 170, 255],
		[140, 210, 255],
		[228, 245, 255],
	],
	alert: [
		[180, 30, 14],
		[225, 70, 30],
		[255, 110, 50],
		[255, 170, 115],
		[255, 236, 226],
	],
};

// Cómo se mueve en cada fase: giro, energía (brillo), velocidad del remolino y color
// (blue: 0 amarillo → 1 azul; alert: rojizo encima de todo).
const MOODS = {
	idle: { spin: 0.1, energy: 0.35, swirl: 0.4, flow: 0.15, blue: 0, alert: 0 },
	paused: { spin: 0.06, energy: 0.26, swirl: 0.25, flow: 0.1, blue: 0, alert: 0 },
	listening: { spin: 0.2, energy: 0.62, swirl: 0.7, flow: 0.25, blue: 0, alert: 0 },
	thinking: { spin: 0.65, energy: 0.75, swirl: 3, flow: 0.9, blue: 1, alert: 0 },
	speaking: { spin: 0.28, energy: 0.85, swirl: 1.1, flow: 0.4, blue: 1, alert: 0 },
	approval: { spin: 0.16, energy: 0.72, swirl: 0.5, flow: 0.2, blue: 0, alert: 1 },
};

// Aleatorio con semilla: la esfera tiene siempre la misma forma.
function rng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function unitVec(rand) {
	const z = rand() * 2 - 1;
	const a = rand() * TAU;
	const s = Math.sqrt(1 - z * z);
	return [s * Math.cos(a), s * Math.sin(a), z];
}

function cross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v) {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

const sph = (r, lon, lat) => [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon)];

// Arco de un círculo de la esfera (radio r) perpendicular a n y desplazado h (−1..1) a lo largo de n.
function circleArc(n, r, h, a0, len) {
	const u = normalize(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	const v = cross(n, u);
	const k = Math.sqrt(1 - h * h);
	const steps = Math.max(3, Math.ceil(len / 0.07));
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const a = a0 + (len * i) / steps;
		const c = Math.cos(a) * k;
		const s = Math.sin(a) * k;
		for (let j = 0; j < 3; j++) pts.push(r * (n[j] * h + u[j] * c + v[j] * s));
	}
	return pts;
}

function buildScene(seed) {
	const rand = rng(seed);
	const lines = [];
	const traces = [];
	const add = (pts, w, tone, a) => {
		const line = { pts: Float32Array.from(pts), w, tone, a, ph: rand() * TAU };
		lines.push(line);
		return line;
	};

	// Bandas de "latitud" (alrededor de un eje casi vertical): dan la silueta de globo.
	for (let i = 0; i < 50; i++) {
		const axis = normalize([(rand() - 0.5) * 0.35, 1, (rand() - 0.5) * 0.35]);
		const band = rand() < 0.1;
		add(
			circleArc(axis, 0.78 + rand() * 0.22, (rand() * 2 - 1) * 0.88, rand() * TAU, 0.3 + rand() ** 1.4 * 2.2),
			band ? 2.2 + rand() * 1.4 : 0.6 + rand() * 1,
			1 + ((rand() * 3) | 0),
			0.5 + rand() * 0.4,
		);
	}
	// Círculos máximos en la capa más externa: al girar se amontonan en el borde y dibujan la silueta.
	for (let i = 0; i < 45; i++) {
		add(
			circleArc(unitVec(rand), 0.95 + rand() * 0.05, (rand() * 2 - 1) * 0.12, rand() * TAU, 0.6 + rand() * 1.8),
			0.7 + rand() * 1.2,
			2 + ((rand() * 2) | 0),
			0.55 + rand() * 0.4,
		);
	}
	// Arcos en orientaciones al azar sobre la capa exterior.
	for (let i = 0; i < 50; i++) {
		add(
			circleArc(unitVec(rand), 0.72 + rand() * 0.3, (rand() * 2 - 1) * 0.5, rand() * TAU, 0.25 + rand() ** 1.5 * 1.6),
			0.6 + rand() * 1.1,
			1 + ((rand() * 3) | 0),
			0.45 + rand() * 0.45,
		);
	}
	// Capa interior, más tenue y más caliente.
	for (let i = 0; i < 34; i++) {
		add(
			circleArc(unitVec(rand), 0.32 + rand() * 0.3, (rand() * 2 - 1) * 0.4, rand() * TAU, 0.4 + rand() * 1.6),
			0.5 + rand() * 0.7,
			2 + ((rand() * 3) | 0),
			0.3 + rand() * 0.4,
		);
	}
	// Trazos tipo circuito (en L) con un "dato" que viaja por ellos.
	for (let i = 0; i < 60; i++) {
		const r = 0.8 + rand() * 0.2;
		let lon = rand() * TAU;
		let lat = (rand() * 2 - 1) * 1.15;
		const pts = [...sph(r, lon, lat)];
		const legs = 2 + ((rand() * 2) | 0);
		for (let l = 0; l < legs; l++) {
			const d = (0.08 + rand() * 0.32) * (rand() < 0.5 ? -1 : 1);
			const steps = Math.max(2, Math.ceil(Math.abs(d) / 0.05));
			for (let s = 1; s <= steps; s++) {
				if (l % 2 === 0) lon += d / steps;
				else lat = clamp(lat + d / steps, -1.4, 1.4);
				pts.push(...sph(r, lon, lat));
			}
		}
		const line = add(pts, 0.7 + rand() * 0.5, 3, 0.75);
		line.speed = 0.3 + rand() * 0.7;
		traces.push(line);
	}
	// Paneles rectangulares (como pantallas flotando en la superficie).
	for (let i = 0; i < 22; i++) {
		const r = 0.86 + rand() * 0.16;
		const lon = rand() * TAU;
		const lat = (rand() * 2 - 1) * 0.9;
		const w = 0.06 + rand() * 0.12;
		const h = 0.05 + rand() * 0.1;
		const corners = [
			[lon - w, lat - h],
			[lon + w, lat - h],
			[lon + w, lat + h],
			[lon - w, lat + h],
			[lon - w, lat - h],
		];
		const pts = [];
		for (let c = 0; c < 4; c++) {
			const [a, b] = [corners[c], corners[c + 1]];
			for (let s = 0; s < 4; s++) pts.push(...sph(r, lerp(a[0], b[0], s / 4), lerp(a[1], b[1], s / 4)));
		}
		pts.push(...sph(r, corners[0][0], corners[0][1]));
		add(pts, 0.6, 2, 0.4 + rand() * 0.3);
	}

	// Fragmentos: rayitas cortas y brillantes pegadas a la superficie (el "circuito" pixelado).
	const chips = [];
	for (let i = 0; i < 260; i++) {
		const r = 0.45 + 0.57 * rand() ** 0.5;
		const lon = rand() * TAU;
		const lat = Math.asin(rand() * 2 - 1);
		const len = 0.02 + rand() ** 2 * 0.09;
		const a = sph(r, lon, lat);
		const b = rand() < 0.5 ? sph(r, lon + len, lat) : sph(r, lon, lat + len);
		chips.push({ a, b, w: 0.8 + rand() * 1.6 });
	}

	// Chispas: más densas hacia fuera. Ordenadas por tono para cambiar de color pocas veces.
	const sparks = [];
	for (let i = 0; i < 420; i++) {
		const d = unitVec(rand);
		const r = 0.15 + 0.95 * rand() ** 0.5;
		sparks.push({ x: d[0] * r, y: d[1] * r, z: d[2] * r, size: 0.8 + rand() ** 2 * 2.4, tone: 2 + ((rand() * 3) | 0), ph: rand() * TAU, sp: 1 + rand() * 4 });
	}
	sparks.sort((a, b) => a.tone - b.tone);

	// Espigas radiales: se ven sobre todo en el borde, como en la silueta del holograma.
	const spikes = [];
	for (let i = 0; i < 80; i++) {
		const d = unitVec(rand);
		const inner = 0.9 + rand() * 0.1;
		spikes.push({ d, inner, len: 0.04 + rand() ** 2.2 * 0.3, w: 0.6 + rand() * 1.1, ph: rand() * TAU });
	}

	return { lines, traces, chips, sparks, spikes };
}

// "Voz" simulada mientras habla (la voz del navegador no da volumen): sílabas y frases.
function speechPulse(t) {
	const syllable = Math.max(0, Math.sin(t * 11.3) * 0.6 + Math.sin(t * 7.1 + 1.7) * 0.4);
	const phrase = 0.55 + 0.45 * Math.sin(t * 1.9 + 0.5);
	return 0.12 + 0.6 * syllable * phrase;
}

export class HoloOrb {
	constructor(host) {
		this.host = host;
		this.canvas = document.createElement("canvas");
		this.canvas.setAttribute("aria-hidden", "true");
		host.append(this.canvas);
		this.ctx = this.canvas.getContext("2d");
		// Halo: copia reducida y difuminada que se suma encima.
		this.glow = document.createElement("canvas");
		this.gctx = this.glow.getContext("2d");
		this.haze = document.createElement("canvas");
		this.hctx = this.haze.getContext("2d");
		this.canBlur = typeof this.gctx?.filter === "string";

		this.scene = buildScene(1337);
		this.state = "idle";
		this.level = 0; // volumen del micrófono (0..1)
		this.lvl = 0; // volumen suavizado
		this.cur = { ...MOODS.idle };
		this.t = 0;
		this.rotY = 0;
		this.swirlA = 0;
		this.flowT = 0;
		this.raf = 0;
		this.last = 0;
		this.W = 0;
		this.H = 0;
		this.dpr = 1;
		this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");

		this.resize();
		new ResizeObserver(() => this.resize()).observe(host);
	}

	setState(state) {
		this.state = MOODS[state] ? state : "idle";
	}

	setLevel(level) {
		this.level = clamp(Number(level) || 0, 0, 1);
	}

	start() {
		if (this.raf) return;
		this.last = 0;
		this.raf = requestAnimationFrame((n) => this.frame(n));
	}

	stop() {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.level = 0;
	}

	resize() {
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		if (!w || !h) return;
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = this.canvas.width = Math.round(w * this.dpr);
		this.H = this.canvas.height = Math.round(h * this.dpr);
		this.glow.width = Math.max(1, Math.round(this.W / 4));
		this.glow.height = Math.max(1, Math.round(this.H / 4));
		this.haze.width = Math.max(1, Math.round(this.W / 10));
		this.haze.height = Math.max(1, Math.round(this.H / 10));
	}

	frame(now) {
		this.raf = requestAnimationFrame((n) => this.frame(n));
		const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
		this.last = now;
		this.t += dt;

		const motion = this.reduced?.matches ? 0.3 : 1;
		const mood = MOODS[this.state];
		const k = 1 - Math.exp(-dt * 3.5);
		for (const key in mood) this.cur[key] = lerp(this.cur[key], mood[key], k);

		let target = this.level;
		if (this.state === "speaking") target = Math.max(target, speechPulse(this.t) * motion);
		if (this.state === "thinking") target = Math.max(target, (0.14 + 0.08 * Math.sin(this.t * 5)) * motion);
		if (this.state === "approval") target = Math.max(target, (0.1 + 0.1 * Math.sin(this.t * 3)) * motion);
		// Sube rápido y baja despacio, como un vúmetro.
		this.lvl = lerp(this.lvl, target, 1 - Math.exp(-dt * (target > this.lvl ? 16 : 5)));

		this.rotY += dt * this.cur.spin * motion;
		this.swirlA += dt * this.cur.swirl * motion;
		this.flowT += dt * this.cur.flow * motion;
		this.draw();
	}

	draw() {
		const { ctx, W, H, dpr, scene, cur, t } = this;
		if (!ctx || !W) return;
		const lvl = this.lvl;
		const energy = clamp(cur.energy + lvl * 0.5, 0, 1.2);
		const ox = W / 2;
		const oy = H / 2;
		const R = Math.min(W, H) * 0.34 * (1 + 0.025 * Math.sin(t * 1.3) + 0.1 * lvl);

		// Paleta del momento (amarillo ↔ azul, y rojizo al pedir permiso); cambia con un fundido.
		const tones = PALETTES.gold.map((c, i) => {
			const b = PALETTES.blue[i];
			const a = PALETTES.alert[i];
			const ch = (j) => lerp(lerp(c[j], b[j], cur.blue), a[j], cur.alert) | 0;
			return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
		});
		const rgba = (i, alpha) => tones[i].replace("rgb(", "rgba(").replace(")", `,${clamp(alpha, 0, 1).toFixed(3)})`);

		// Proyección 3D → 2D: giro en Y, inclinación en X, leve balanceo y perspectiva.
		const cyr = Math.cos(this.rotY);
		const syr = Math.sin(this.rotY);
		const tilt = 0.32 + 0.08 * Math.sin(t * 0.37);
		const cx = Math.cos(tilt);
		const sx = Math.sin(tilt);
		const roll = 0.12 * Math.sin(t * 0.21);
		const cr = Math.cos(roll);
		const sr = Math.sin(roll);
		const F = 3.4;
		let px = 0;
		let py = 0;
		let pz = 0;
		const project = (x, y, z) => {
			const x1 = x * cyr + z * syr;
			const z1 = -x * syr + z * cyr;
			const y2 = y * cx - z1 * sx;
			pz = y * sx + z1 * cx;
			const s = (R * F) / (F - pz);
			px = ox + (x1 * cr - y2 * sr) * s;
			py = oy - (x1 * sr + y2 * cr) * s;
		};
		const depthOf = (z) => 0.25 + 0.75 * ((clamp(z, -1, 1) + 1) / 2) ** 1.4;

		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		ctx.setLineDash([]);
		ctx.clearRect(0, 0, W, H);
		ctx.globalCompositeOperation = "lighter";
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		// Resplandor de fondo.
		let g = ctx.createRadialGradient(ox, oy, R * 0.15, ox, oy, R * 1.4);
		g.addColorStop(0, rgba(2, 0.16 * energy));
		g.addColorStop(0.6, rgba(1, 0.06 * energy));
		g.addColorStop(1, rgba(0, 0));
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);

		// Borde luminoso de la esfera.
		g = ctx.createRadialGradient(ox, oy, R * 0.8, ox, oy, R * 1.08);
		g.addColorStop(0, rgba(2, 0));
		g.addColorStop(0.75, rgba(2, 0.12 * energy));
		g.addColorStop(1, rgba(2, 0));
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(ox, oy, R * 1.08, 0, TAU);
		ctx.fill();

		// Arcos, circuitos y paneles.
		const bright = 0.55 + 0.8 * energy;
		for (const L of scene.lines) {
			const p = L.pts;
			let zs = 0;
			ctx.beginPath();
			for (let i = 0; i < p.length; i += 3) {
				project(p[i], p[i + 1], p[i + 2]);
				if (i === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
				zs += pz;
			}
			const zm = zs / (p.length / 3);
			const shimmer = 0.78 + 0.22 * Math.sin(t * 2.1 + L.ph);
			ctx.globalAlpha = clamp(L.a * depthOf(zm) * shimmer * bright, 0, 1);
			ctx.lineWidth = L.w * dpr * (0.65 + 0.55 * ((zm + 1) / 2));
			ctx.strokeStyle = tones[L.tone];
			ctx.stroke();
		}

		// Fragmentos: se agrupan por profundidad (delante, medio, detrás) para dibujar en 3 trazos.
		const buckets = [new Path2D(), new Path2D(), new Path2D()];
		for (const c of scene.chips) {
			project(c.a[0], c.a[1], c.a[2]);
			const x0 = px;
			const y0 = py;
			const b = pz > 0.35 ? 0 : pz > -0.35 ? 1 : 2;
			project(c.b[0], c.b[1], c.b[2]);
			buckets[b].moveTo(x0, y0);
			buckets[b].lineTo(px, py);
		}
		ctx.lineWidth = 1.5 * dpr;
		[
			[3, 0.95],
			[2, 0.6],
			[1, 0.35],
		].forEach(([tone, alpha], i) => {
			ctx.strokeStyle = tones[tone];
			ctx.globalAlpha = clamp(alpha * bright, 0, 1);
			ctx.stroke(buckets[i]);
		});

		// Datos viajando por los circuitos.
		ctx.fillStyle = tones[4];
		for (const L of scene.traces) {
			const n = L.pts.length / 3;
			const f = (this.flowT * L.speed + L.ph) % 1;
			const i = Math.min(n - 1, Math.floor(f * n)) * 3;
			project(L.pts[i], L.pts[i + 1], L.pts[i + 2]);
			const s = (1.2 + 1.6 * energy) * dpr;
			ctx.globalAlpha = clamp(depthOf(pz) * 0.9 * bright, 0, 1);
			ctx.fillRect(px - s / 2, py - s / 2, s, s);
		}

		// Chispas que titilan.
		let tone = -1;
		for (const s of scene.sparks) {
			if (s.tone !== tone) {
				tone = s.tone;
				ctx.fillStyle = tones[tone];
			}
			project(s.x, s.y, s.z);
			const tw = 0.25 + 0.75 * Math.max(0, Math.sin(t * s.sp + s.ph)) ** 3;
			const d = depthOf(pz);
			const size = s.size * dpr * (0.6 + 0.8 * d);
			ctx.globalAlpha = clamp(tw * d * bright, 0, 1);
			ctx.fillRect(px - size / 2, py - size / 2, size, size);
		}

		// Espigas en el borde; se alargan con la voz.
		ctx.strokeStyle = tones[2];
		for (const sp of scene.spikes) {
			const [dx, dy, dz] = sp.d;
			// Tope para no salirse del canvas (que mide ~1.47 radios desde el centro).
			const len = Math.min(1.34 - sp.inner, sp.len * (0.5 + energy * 0.7 + lvl * 1.6) * (0.8 + 0.2 * Math.sin(t * 3 + sp.ph)));
			project(dx * sp.inner, dy * sp.inner, dz * sp.inner);
			const x0 = px;
			const y0 = py;
			const z0 = pz;
			project(dx * (sp.inner + len), dy * (sp.inner + len), dz * (sp.inner + len));
			ctx.globalAlpha = clamp(0.7 * depthOf(z0) * bright, 0, 1);
			ctx.lineWidth = sp.w * dpr;
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(px, py);
			ctx.stroke();
		}

		// Remolino central: un brazo brillante y otro tenue que se estrechan hacia fuera.
		const arms = [
			[0, 1],
			[Math.PI, 0.45],
		];
		for (const [offset, strength] of arms) {
			const N = 40;
			let x0 = 0;
			let y0 = 0;
			for (let i = 0; i <= N; i++) {
				const f = i / N;
				const ang = this.swirlA + offset + f * TAU * 0.85;
				const rad = R * (0.1 + 0.64 * f) * (1 + 0.12 * lvl);
				const x = ox + Math.cos(ang) * rad;
				const y = oy + Math.sin(ang) * rad * 0.8;
				if (i > 0) {
					ctx.globalAlpha = clamp((1 - f) ** 0.6 * strength * bright, 0, 1);
					ctx.lineWidth = (1 + 4 * (1 - f)) * dpr * strength;
					ctx.strokeStyle = tones[f < 0.3 ? 4 : 3];
					ctx.beginPath();
					ctx.moveTo(x0, y0);
					ctx.lineTo(x, y);
					ctx.stroke();
				}
				x0 = x;
				y0 = y;
			}
		}

		// Núcleo: brillo y anillos centrales que laten con la voz.
		ctx.globalAlpha = 1;
		g = ctx.createRadialGradient(ox, oy, 0, ox, oy, R * 0.5);
		g.addColorStop(0, rgba(4, 0.5 * energy));
		g.addColorStop(0.3, rgba(3, 0.18 * energy));
		g.addColorStop(1, rgba(2, 0));
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(ox, oy, R * 0.5, 0, TAU);
		ctx.fill();
		ctx.strokeStyle = tones[4];
		ctx.globalAlpha = clamp(0.95 * bright, 0, 1);
		ctx.lineWidth = 2.2 * dpr;
		ctx.beginPath();
		ctx.arc(ox, oy, R * (0.075 + 0.03 * lvl), 0, TAU);
		ctx.stroke();
		ctx.strokeStyle = tones[3];
		ctx.globalAlpha = clamp(0.45 * bright, 0, 1);
		ctx.lineWidth = 1 * dpr;
		ctx.beginPath();
		ctx.arc(ox, oy, R * (0.13 + 0.05 * lvl), 0, TAU);
		ctx.stroke();

		// Anillos de interfaz alrededor (discontinuos, giran en sentidos opuestos).
		ctx.strokeStyle = tones[2];
		ctx.globalAlpha = clamp(0.35 * bright, 0, 1);
		ctx.lineWidth = 1.2 * dpr;
		ctx.setLineDash([2 * dpr, 7 * dpr]);
		ctx.lineDashOffset = -this.rotY * 60 * dpr;
		ctx.beginPath();
		ctx.arc(ox, oy, R * 1.12, 0, TAU);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = clamp(0.3 * bright, 0, 1);
		for (let i = 0; i < 3; i++) {
			const a = -this.rotY * 0.8 + (i * TAU) / 3;
			ctx.beginPath();
			ctx.arc(ox, oy, R * 1.2, a, a + 0.55);
			ctx.stroke();
		}

		// Halo (bloom): copias reducidas y borrosas sumadas encima; una cercana y otra amplia.
		const { glow, gctx, haze, hctx } = this;
		if (gctx && hctx) {
			gctx.globalCompositeOperation = "copy";
			if (this.canBlur) gctx.filter = "blur(2px)";
			gctx.drawImage(this.canvas, 0, 0, glow.width, glow.height);
			hctx.globalCompositeOperation = "copy";
			if (this.canBlur) hctx.filter = "blur(3px)";
			hctx.drawImage(glow, 0, 0, haze.width, haze.height);
			ctx.globalAlpha = 1;
			ctx.drawImage(glow, 0, 0, W, H);
			ctx.globalAlpha = 0.7;
			ctx.drawImage(haze, 0, 0, W, H);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}
}
