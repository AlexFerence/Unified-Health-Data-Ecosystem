import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * OpenAI-compatible embeddings client for locally-hosted models (e.g. LM Studio).
 *
 * Uses encoding_format:"float" explicitly to avoid the base64 decoding mismatch
 * that occurs when the server doesn't fully implement that part of the OpenAI spec.
 *
 * For nomic-embed-text models, task instruction prefixes are applied automatically:
 *   embedQuery()     → "search_query: <text>"
 *   embedDocuments() → "search_document: <text>"
 *
 * Requires env vars: LOCAL_EMBEDDING_MODEL, LOCAL_LLM_URL
 */
export class LocalEmbeddings extends Embeddings {
    private readonly model: string;
    private readonly baseUrl: string;
    private readonly addNomicPrefixes: boolean;

    static readonly QUERY_PREFIX = "search_query: ";
    static readonly DOCUMENT_PREFIX = "search_document: ";

    constructor(params?: EmbeddingsParams) {
        super(params ?? {});
        const model = process.env.LOCAL_EMBEDDING_MODEL;
        const baseUrl = process.env.LOCAL_LLM_URL;
        if (!model || !baseUrl) {
            throw new Error(
                "LOCAL_EMBEDDING_MODEL and LOCAL_LLM_URL must be set to use LocalEmbeddings."
            );
        }
        this.model = model;
        this.baseUrl = baseUrl;
        // Automatically apply nomic prefix convention when the model name contains "nomic"
        this.addNomicPrefixes = model.toLowerCase().includes("nomic");
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        const inputs = this.addNomicPrefixes
            ? texts.map(t => `${LocalEmbeddings.DOCUMENT_PREFIX}${t}`)
            : texts;
        const res = await fetch(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer local" },
            body: JSON.stringify({ model: this.model, input: inputs, encoding_format: "float" }),
        });
        if (!res.ok) {
            throw new Error(`Embeddings API error: ${res.status} ${await res.text()}`);
        }
        const json = await res.json() as { data: Array<{ embedding: number[] }> };
        return json.data.map(d => d.embedding);
    }

    async embedQuery(text: string): Promise<number[]> {
        const input = this.addNomicPrefixes
            ? `${LocalEmbeddings.QUERY_PREFIX}${text}`
            : text;
        const res = await fetch(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer local" },
            body: JSON.stringify({ model: this.model, input: [input], encoding_format: "float" }),
        });
        if (!res.ok) {
            throw new Error(`Embeddings API error: ${res.status} ${await res.text()}`);
        }
        const json = await res.json() as { data: Array<{ embedding: number[] }> };
        return json.data[0].embedding;
    }
}

/**
 * Returns the cosine similarity between two equal-length vectors.
 * Returns 0 if the vectors have different lengths or either has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Returns an embeddings instance based on available env vars.
 * Preference order: local model (LOCAL_EMBEDDING_MODEL) → OpenAI (OPENAI_API_KEY) → null.
 */
export function createEmbeddings(): Embeddings | null {
    if (process.env.LOCAL_EMBEDDING_MODEL && process.env.LOCAL_LLM_URL) {
        return new LocalEmbeddings();
    }
    return null;
}
