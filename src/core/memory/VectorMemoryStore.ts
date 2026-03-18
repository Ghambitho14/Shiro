import type { EmbeddingsProvider } from "./EmbeddingsClient.js";

export interface MemoryEntry {
	id: string;
	content: string;
	embedding?: number[];
	metadata: {
		timestamp: string;
		sessionId?: string;
		type: "conversation" | "tool_call" | "observation" | "decision";
		tags?: string[];
	};
}

/** Almacenamiento de memoria vectorial simple en memoria */
export class VectorMemoryStore {
	private entries: Map<string, MemoryEntry> = new Map();
	private embeddings: EmbeddingsProvider;
	private dimension: number = 768;

	constructor(embeddings: EmbeddingsProvider) {
		this.embeddings = embeddings;
	}

	/** Agrega una entrada a la memoria */
	async add(entry: Omit<MemoryEntry, "id" | "embedding">): Promise<string> {
		const id = crypto.randomUUID();
		
		// Generar embedding
		const embedding = await this.embeddings.embed(entry.content);
		
		const fullEntry: MemoryEntry = {
			...entry,
			id,
			embedding,
		};

		this.entries.set(id, fullEntry);
		return id;
	}

	/** Buscamemoria semántica más similar */
	async search(query: string, limit: number = 5): Promise<MemoryEntry[]> {
		const queryEmbedding = await this.embeddings.embed(query);
		
		const results: { entry: MemoryEntry; similarity: number }[] = [];

		for (const entry of this.entries.values()) {
			if (!entry.embedding) continue;
			
			const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
			results.push({ entry, similarity });
		}

		// Ordenar por similitud
		results.sort((a, b) => b.similarity - a.similarity);

		return results.slice(0, limit).map(r => r.entry);
	}

	/** Busca por palabras clave */
	searchByKeyword(keywords: string[], limit: number = 5): MemoryEntry[] {
		const results: { entry: MemoryEntry; score: number }[] = [];

		const lowerKeywords = keywords.map(k => k.toLowerCase());

		for (const entry of this.entries.values()) {
			const contentLower = entry.content.toLowerCase();
			let score = 0;
			
			for (const keyword of lowerKeywords) {
				if (contentLower.includes(keyword)) {
					score++;
					// Bonus por coincidir al inicio
					if (contentLower.startsWith(keyword)) {
						score += 0.5;
					}
				}
			}

			if (score > 0) {
				results.push({ entry, score });
			}
		}

		// Ordenar por score
		results.sort((a, b) => b.score - a.score);

		return results.slice(0, limit).map(r => r.entry);
	}

	/** Búsqueda híbrida: combina vector y keyword */
	async hybridSearch(
		query: string, 
		keywords: string[], 
		limit: number = 5,
		vectorWeight: number = 0.7
	): Promise<{ entry: MemoryEntry; score: number }[]> {
		// Búsqueda vectorial
		const vectorResults = await this.search(query, limit * 2);
		const vectorMap = new Map(vectorResults.map(e => [e.id, e]));

		// Búsqueda por keywords
		const keywordResults = this.searchByKeyword(keywords, limit * 2);
		const keywordMap = new Map(keywordResults.map(e => [e.id, e]));

		// Combinar resultados
		const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
		const combined: { entry: MemoryEntry; score: number }[] = [];

		for (const id of allIds) {
			const entry = vectorMap.get(id) ?? keywordMap.get(id)!;
			const vectorScore = vectorMap.has(id) 
				? (vectorResults.indexOf(entry) + 1) / vectorResults.length 
				: 0;
			const keywordScore = keywordMap.has(id)
				? (keywordResults.indexOf(entry) + 1) / keywordResults.length
				: 0;

			const score = (vectorScore * vectorWeight) + (keywordScore * (1 - vectorWeight));
			combined.push({ entry, score });
		}

		// Ordenar por score combinado
		combined.sort((a, b) => b.score - a.score);

		return combined.slice(0, limit);
	}

	/** Obtiene todas las entradas */
	getAll(): MemoryEntry[] {
		return Array.from(this.entries.values());
	}

	/** Obtiene entradas por sesión */
	getBySession(sessionId: string): MemoryEntry[] {
		return Array.from(this.entries.values())
			.filter(e => e.metadata.sessionId === sessionId);
	}

	/** Limpia la memoria */
	clear(): void {
		this.entries.clear();
	}

	/** Obtiene estadísticas */
	getStats(): { totalEntries: number; byType: Record<string, number> } {
		const byType: Record<string, number> = {};
		
		for (const entry of this.entries.values()) {
			const type = entry.metadata.type;
			byType[type] = (byType[type] ?? 0) + 1;
		}

		return {
			totalEntries: this.entries.size,
			byType,
		};
	}
}

/** Calcula similitud coseno entre dos vectores */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	if (normA === 0 || normB === 0) return 0;
	
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
