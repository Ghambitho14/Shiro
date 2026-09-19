import { getConfig } from "../../config/config.js";
import { resolveLLMSettings } from "../llm/providers.js";

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
		const llm = resolveLLMSettings();
		// Si el chat ya usa Ollama, se reutiliza su URL para los embeddings.
		const ollamaUrl = llm.dialect === "ollama" ? llm.baseUrl : "http://localhost:11434";
		this.baseUrl = opts.baseUrl ?? config.embeddingsBaseUrl ?? ollamaUrl;
		this.model = opts.model ?? config.embeddingsModel;
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
