import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export interface GatewayClient {
	id: string;
	ws: WebSocket;
	sessionId?: string;
	metadata: {
		name?: string;
		connectedAt: number;
		lastPing: number;
	};
}

export interface GatewayMessage {
	type: string;
	payload: Record<string, unknown>;
}

/** Gateway - WebSocket Control Plane para Shiro */
export class Gateway {
	private wss: WebSocketServer | null = null;
	private clients: Map<string, GatewayClient> = new Map();
	private httpServer: HttpServer | null = null;
	private port: number;
	private host: string;

	constructor(port: number = 8080, host: string = "127.0.0.1") {
		this.port = port;
		this.host = host;
	}

	/** Inicia el Gateway con su propio servidor HTTP */
	start(): void {
		this.httpServer = createServer((req, res) => {
			this.handleHttpRequest(req, res);
		});

		this.wss = new WebSocketServer({ server: this.httpServer });

		this.wss.on("connection", (ws, req) => {
			this.handleConnection(ws, req);
		});

		this.httpServer.listen(this.port, this.host, () => {
			console.log(`🔌 Gateway WebSocket: ws://${this.host}:${this.port}`);
			console.log(`   HTTP Control: http://${this.host}:${this.port}/gateway`);
		});
	}

	/** Inicia el Gateway compartiendo un servidor HTTP existente */
	startWithServer(server: HttpServer, mountPath: string = "/ws"): void {
		this.wss = new WebSocketServer({ noServer: true });

		// Manejar upgrades de HTTP a WebSocket
		server.on("upgrade", (request, socket, head) => {
			const url = request.url ?? "";
			if (url.startsWith(mountPath)) {
				this.wss?.handleUpgrade(request, socket, head, (ws) => {
					this.wss?.emit("connection", ws, request);
				});
			}
		});

		console.log(`🔌 Gateway WebSocket: ${mountPath} (compartido con servidor principal)`);
	}

	/** Detiene el Gateway */
	stop(): void {
		for (const client of this.clients.values()) {
			client.ws.close();
		}
		this.clients.clear();
		this.wss?.close();
		this.httpServer?.close();
		console.log("🛑 Gateway detenido");
	}

	/** Maneja conexiones WebSocket */
	private handleConnection(ws: WebSocket, req: { url?: string }): void {
		const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
		
		const client: GatewayClient = {
			id: clientId,
			ws,
			metadata: {
				connectedAt: Date.now(),
				lastPing: Date.now(),
			},
		};

		this.clients.set(clientId, client);
		console.log(`🔗 Cliente conectado: ${clientId} (total: ${this.clients.size})`);

		// Enviar mensaje de bienvenida
		this.sendToClient(clientId, {
			type: "welcome",
			payload: {
				clientId,
				message: "Conectado al Gateway de Shiro",
				version: "1.0.0",
			},
		});

		// Broadcast a todos los clientes
		this.broadcast({
			type: "client_connected",
			payload: { clientId, totalClients: this.clients.size },
		});

		ws.on("message", (data) => {
			this.handleMessage(clientId, data.toString());
		});

		ws.on("close", () => {
			this.clients.delete(clientId);
			console.log(`🔌 Cliente desconectado: ${clientId} (total: ${this.clients.size})`);
			this.broadcast({
				type: "client_disconnected",
				payload: { clientId, totalClients: this.clients.size },
			});
		});

		ws.on("error", (err) => {
			console.error(`❌ Error en cliente ${clientId}:`, err.message);
		});

		// Ping/pong para mantener conexión viva
		ws.on("pong", () => {
			const c = this.clients.get(clientId);
			if (c) c.metadata.lastPing = Date.now();
		});
	}

	/** Maneja mensajes entrantes */
	private async handleMessage(clientId: string, raw: string): Promise<void> {
		let msg: GatewayMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			this.sendToClient(clientId, {
				type: "error",
				payload: { message: "Mensaje JSON inválido" },
			});
			return;
		}

		const client = this.clients.get(clientId);
		if (!client) return;

		console.log(`📥 Mensaje de ${clientId}:`, msg.type);

		switch (msg.type) {
			case "ping":
				this.sendToClient(clientId, { type: "pong", payload: {} });
				break;

			case "auth":
				// Autenticación simple
				this.sendToClient(clientId, {
					type: "authenticated",
					payload: { clientId },
				});
				break;

			case "join_session":
				client.sessionId = msg.payload.sessionId as string;
				this.sendToClient(clientId, {
					type: "session_joined",
					payload: { sessionId: client.sessionId },
				});
				break;

			case "leave_session":
				client.sessionId = undefined;
				this.sendToClient(clientId, {
					type: "session_left",
					payload: {},
				});
				break;

			case "chat":
				// Este lo maneja el agente
				this.sendToClient(clientId, {
					type: "chat_received",
					payload: { message: "Procesando..." },
				});
				// Emitir evento para que el servidor lo procese
				this.emitEvent("chat", { clientId, ...msg.payload });
				break;

			case "typing":
				// Reenviar typing a otros clientes en la misma sesión
				this.broadcastToSession(client.sessionId, {
					type: "typing",
					payload: { clientId, ...msg.payload },
				}, clientId);
				break;

			default:
				this.sendToClient(clientId, {
					type: "unknown_command",
					payload: { command: msg.type },
				});
		}
	}

	/** Maneja requests HTTP */
	private handleHttpRequest(
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	): void {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";

		// CORS
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Rutas públicas
		if (url === "/" || url === "/index.html") {
			this.serveFile(res, "index.html", "text/html");
			return;
		}

		if (url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				status: "ok",
				clients: this.clients.size,
				uptime: process.uptime(),
			}));
			return;
		}

		if (url === "/api/status") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.getStatus()));
			return;
		}

		if (url === "/api/clients") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.getClients()));
			return;
		}

		// Archivos estáticos
		const filePath = url.split("?")[0];
		this.serveFile(res, filePath);
	}

	/** Sirve archivos estáticos */
	private serveFile(
		res: import("node:http").ServerResponse,
		filePath: string,
		contentType?: string,
	): void {
		const fullPath = join(PUBLIC_DIR, filePath === "/" ? "index.html" : filePath);
		
		if (!existsSync(fullPath)) {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		try {
			const content = readFileSync(fullPath);
			const type = contentType || this.getContentType(fullPath);
			res.writeHead(200, { "Content-Type": type });
			res.end(content);
		} catch {
			res.writeHead(500);
			res.end("Error reading file");
		}
	}

	/** Obtiene el tipo de contenido */
	private getContentType(path: string): string {
		const ext = path.split(".").pop()?.toLowerCase();
		const types: Record<string, string> = {
			html: "text/html",
			js: "application/javascript",
			css: "text/css",
			json: "application/json",
			png: "image/png",
			jpg: "image/jpeg",
			svg: "image/svg+xml",
		};
		return types[ext ?? ""] || "text/plain";
	}

	/** Envía mensaje a un cliente específico */
	sendToClient(clientId: string, msg: GatewayMessage): void {
		const client = this.clients.get(clientId);
		if (client?.ws.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify(msg));
		}
	}

	/** Broadcast a todos los clientes */
	broadcast(msg: GatewayMessage): void {
		const data = JSON.stringify(msg);
		for (const client of this.clients.values()) {
			if (client.ws.readyState === WebSocket.OPEN) {
				client.ws.send(data);
			}
		}
	}

	/** Broadcast a clientes de una sesión específica */
	broadcastToSession(sessionId: string | undefined, msg: GatewayMessage, excludeClient?: string): void {
		if (!sessionId) return;
		const data = JSON.stringify(msg);
		for (const client of this.clients.values()) {
			if (client.sessionId === sessionId && client.id !== excludeClient && client.ws.readyState === WebSocket.OPEN) {
				client.ws.send(data);
			}
		}
	}

	/** Emite un evento (para integración con el agente) */
	private emitEvent(event: string, data: Record<string, unknown>): void {
		// Este método puede ser sobreescrito por el servidor principal
		console.log(`📡 Evento emitido: ${event}`, data);
	}

	/** Obtiene el estado del Gateway */
	getStatus(): {
		clients: number;
		sessions: number;
		uptime: number;
		version: string;
	} {
		const sessions = new Set<string>();
		for (const client of this.clients.values()) {
			if (client.sessionId) sessions.add(client.sessionId);
		}

		return {
			clients: this.clients.size,
			sessions: sessions.size,
			uptime: process.uptime(),
			version: "1.0.0",
		};
	}

	/** Obtiene lista de clientes */
	getClients(): { id: string; sessionId?: string; metadata: GatewayClient["metadata"] }[] {
		return Array.from(this.clients.values()).map((c) => ({
			id: c.id,
			sessionId: c.sessionId,
			metadata: c.metadata,
		}));
	}
}

/** Singleton del Gateway */
let gatewayInstance: Gateway | null = null;

export function getGateway(port?: number, host?: string): Gateway {
	if (!gatewayInstance) {
		gatewayInstance = new Gateway(port, host);
	}
	return gatewayInstance;
}

export function startGateway(port?: number, host?: string): Gateway {
	const gw = getGateway(port, host);
	gw.start();
	return gw;
}

export function stopGateway(): void {
	gatewayInstance?.stop();
	gatewayInstance = null;
}
