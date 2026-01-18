/**
 * Embeddings - Generate embeddings using Ollama
 */

import { Ollama } from 'ollama';

// Default embedding model
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

// Get Ollama host - check env var at runtime, not module load time
function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || 'http://localhost:11434';
}

// Singleton client with host tracking
let ollamaClient: Ollama | null = null;
let currentClientHost: string | null = null;

/**
 * Get or create Ollama client
 * Creates a new client if host changes
 */
function getClient(host?: string): Ollama {
  const effectiveHost = host || getOllamaHost();

  // Create new client if none exists or host changed
  if (!ollamaClient || currentClientHost !== effectiveHost) {
    ollamaClient = new Ollama({ host: effectiveHost });
    currentClientHost = effectiveHost;
  }
  return ollamaClient;
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
  host?: string
): Promise<number[]> {
  const effectiveHost = host || getOllamaHost();
  const client = getClient(effectiveHost);

  try {
    const response = await client.embed({
      model,
      input: text,
    });

    // Ollama's embed endpoint returns embeddings array
    if (response.embeddings && response.embeddings.length > 0) {
      return response.embeddings[0];
    }

    throw new Error(`No embeddings returned from Ollama (model: ${model}, host: ${effectiveHost})`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Check for model not found error
    if (errMsg.includes('not found') || errMsg.includes('pulling')) {
      throw new Error(
        `Embedding model "${model}" not found. Install it with: ollama pull ${model}`
      );
    }

    throw error;
  }
}

/**
 * Generate embeddings for multiple texts
 */
export async function generateEmbeddings(
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL,
  host?: string
): Promise<number[][]> {
  const effectiveHost = host || getOllamaHost();
  const client = getClient(effectiveHost);

  try {
    // Ollama's embed endpoint can handle multiple inputs
    const response = await client.embed({
      model,
      input: texts,
    });

    if (response.embeddings && response.embeddings.length === texts.length) {
      return response.embeddings;
    }

    throw new Error(`Expected ${texts.length} embeddings, got ${response.embeddings?.length || 0}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Check for model not found error
    if (errMsg.includes('not found') || errMsg.includes('pulling')) {
      throw new Error(
        `Embedding model "${model}" not found. Install it with: ollama pull ${model}`
      );
    }

    throw error;
  }
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Find most similar embeddings from a list
 */
export function findMostSimilar(
  queryEmbedding: number[],
  embeddings: { embedding: number[]; id: string }[],
  topK: number = 5,
  minScore: number = 0
): { id: string; score: number }[] {
  const scores = embeddings.map(item => ({
    id: item.id,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));

  return scores
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Check if embedding model is available
 */
export async function isEmbeddingModelAvailable(
  model: string = DEFAULT_EMBEDDING_MODEL,
  host?: string
): Promise<boolean> {
  const client = getClient(host);

  try {
    const response = await client.list();
    return response.models.some(m => m.name.includes(model));
  } catch {
    return false;
  }
}

/**
 * Pull embedding model if not available
 */
export async function ensureEmbeddingModel(
  model: string = DEFAULT_EMBEDDING_MODEL,
  host?: string,
  onProgress?: (status: string) => void
): Promise<void> {
  const available = await isEmbeddingModelAvailable(model, host);
  if (available) return;

  const client = getClient(host);

  try {
    const response = await client.pull({ model, stream: true });
    for await (const chunk of response) {
      if (onProgress && chunk.status) {
        onProgress(chunk.status);
      }
    }
  } catch (error) {
    console.error(`Failed to pull embedding model ${model}:`, error);
    throw error;
  }
}

/**
 * Normalize embedding vector (for some operations)
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return embedding;
  return embedding.map(v => v / norm);
}
