import { getConfig } from "../../config/config.js";

export interface EmbeddingResult {
	embedding: number[];
	model: string;
}

export interface EmbeddingsProvider {
	embed(text: string): Promise<number[]>;
	getModel(): string;
}

/** Cliente de embeddings usando Ollama */
export class OllamaEmbeddings implements EmbeddingsProvider {
	private baseUrl: string;
	private model: string;

	constructor(opts: { baseUrl?: string; model?: string } = {}) {
		const config = getConfig();
		this.baseUrl = opts.baseUrl ?? config.ollamaBaseUrl ?? "http://localhost:11434";
		this.model = opts.model ?? "nomic-embed-text";
	}

	async embed(text: string): Promise<number[]> {
		const url = `${this.baseUrl}/api/embeddings`;
		
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				prompt: text,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Ollama embeddings error: ${response.status} - ${error}`);
		}

		const data = (await response.json()) as { embedding?: number[] };
		if (!data.embedding) {
			throw new Error("No embedding returned from Ollama");
		}

		return data.embedding;
	}

	getModel(): string {
		return this.model;
	}
}

/** Factory para obtener el proveedor de embeddings */
export function getEmbeddingsProvider(): EmbeddingsProvider {
	return new OllamaEmbeddings();
}
