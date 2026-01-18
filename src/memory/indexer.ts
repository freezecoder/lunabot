/**
 * Memory Indexer - Chunk and index files for memory
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { MemoryStore } from './store.js';
import { generateEmbeddings } from './embeddings.js';
import type { MemoryChunk, MemoryConfig, DEFAULT_MEMORY_CONFIG } from './types.js';

/**
 * Calculate hash of content
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Simple tokenizer (word-based approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

/**
 * Split text into chunks
 */
function chunkText(
  text: string,
  targetTokens: number = 400,
  overlapTokens: number = 80
): { content: string; lineStart: number; lineEnd: number }[] {
  const lines = text.split('\n');
  const chunks: { content: string; lineStart: number; lineEnd: number }[] = [];

  let currentChunk: string[] = [];
  let currentTokens = 0;
  let chunkStartLine = 0;
  let overlapBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);

    // Check if adding this line exceeds target
    if (currentTokens + lineTokens > targetTokens && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        content: currentChunk.join('\n'),
        lineStart: chunkStartLine,
        lineEnd: i - 1,
      });

      // Start new chunk with overlap
      currentChunk = [...overlapBuffer];
      currentTokens = estimateTokens(currentChunk.join('\n'));
      chunkStartLine = Math.max(0, i - overlapBuffer.length);
      overlapBuffer = [];
    }

    currentChunk.push(line);
    currentTokens += lineTokens;

    // Build overlap buffer from recent lines
    overlapBuffer.push(line);
    while (estimateTokens(overlapBuffer.join('\n')) > overlapTokens) {
      overlapBuffer.shift();
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.join('\n'),
      lineStart: chunkStartLine,
      lineEnd: lines.length - 1,
    });
  }

  return chunks;
}

/**
 * Smart chunking that respects paragraph boundaries
 */
function smartChunkText(
  text: string,
  targetTokens: number = 400,
  overlapTokens: number = 80
): { content: string; lineStart: number; lineEnd: number }[] {
  const lines = text.split('\n');
  const paragraphs: { content: string; startLine: number; endLine: number }[] = [];

  // First, identify paragraphs (separated by blank lines)
  let paragraphStart = 0;
  let currentParagraph: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '') {
      if (currentParagraph.length > 0) {
        paragraphs.push({
          content: currentParagraph.join('\n'),
          startLine: paragraphStart,
          endLine: i - 1,
        });
        currentParagraph = [];
      }
      paragraphStart = i + 1;
    } else {
      currentParagraph.push(line);
    }
  }

  // Last paragraph
  if (currentParagraph.length > 0) {
    paragraphs.push({
      content: currentParagraph.join('\n'),
      startLine: paragraphStart,
      endLine: lines.length - 1,
    });
  }

  // Now group paragraphs into chunks
  const chunks: { content: string; lineStart: number; lineEnd: number }[] = [];
  let currentChunk: typeof paragraphs = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para.content);

    // If single paragraph is larger than target, use simple chunking
    if (paraTokens > targetTokens) {
      // Flush current chunk first
      if (currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.map(p => p.content).join('\n\n'),
          lineStart: currentChunk[0].startLine,
          lineEnd: currentChunk[currentChunk.length - 1].endLine,
        });
        currentChunk = [];
        currentTokens = 0;
      }

      // Use simple chunking for this large paragraph
      const subChunks = chunkText(para.content, targetTokens, overlapTokens);
      for (const sub of subChunks) {
        chunks.push({
          content: sub.content,
          lineStart: para.startLine + sub.lineStart,
          lineEnd: para.startLine + sub.lineEnd,
        });
      }
      continue;
    }

    // Check if adding this paragraph exceeds target
    if (currentTokens + paraTokens > targetTokens && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.map(p => p.content).join('\n\n'),
        lineStart: currentChunk[0].startLine,
        lineEnd: currentChunk[currentChunk.length - 1].endLine,
      });
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(para);
    currentTokens += paraTokens;
  }

  // Last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.map(p => p.content).join('\n\n'),
      lineStart: currentChunk[0].startLine,
      lineEnd: currentChunk[currentChunk.length - 1].endLine,
    });
  }

  return chunks;
}

/**
 * Memory Indexer class
 */
export class MemoryIndexer {
  private store: MemoryStore;
  private config: Pick<MemoryConfig, 'chunking' | 'embedding'>;
  private batchSize: number = 10;

  constructor(
    store: MemoryStore,
    config?: Partial<Pick<MemoryConfig, 'chunking' | 'embedding'>>
  ) {
    this.store = store;
    this.config = {
      chunking: config?.chunking || { tokens: 400, overlap: 80 },
      embedding: config?.embedding || { model: 'nomic-embed-text' },
    };
  }

  /**
   * Index a single file
   */
  async indexFile(
    path: string,
    options?: { force?: boolean; relativeTo?: string }
  ): Promise<number> {
    // Read file
    const content = await readFile(path, 'utf-8');
    const contentHash = hashContent(content);

    // Check if already indexed and unchanged
    const existingInfo = this.store.getFileInfo(path);
    if (!options?.force && existingInfo && existingInfo.hash === contentHash) {
      return 0; // Already indexed
    }

    // Delete old chunks if re-indexing
    if (existingInfo) {
      this.store.deleteFileChunks(path);
    }

    // Chunk the content
    const textChunks = smartChunkText(
      content,
      this.config.chunking.tokens,
      this.config.chunking.overlap
    );

    if (textChunks.length === 0) {
      return 0;
    }

    // Generate embeddings in batches
    const now = Date.now();
    const chunks: MemoryChunk[] = [];

    for (let i = 0; i < textChunks.length; i += this.batchSize) {
      const batch = textChunks.slice(i, i + this.batchSize);
      const texts = batch.map(c => c.content);

      const embeddings = await generateEmbeddings(texts, this.config.embedding.model);

      for (let j = 0; j < batch.length; j++) {
        const textChunk = batch[j];
        chunks.push({
          id: uuid(),
          path,
          content: textChunk.content,
          embedding: embeddings[j],
          lineStart: textChunk.lineStart,
          lineEnd: textChunk.lineEnd,
          hash: hashContent(textChunk.content),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Save chunks
    this.store.saveChunks(chunks);

    // Update file info
    this.store.updateFileInfo({
      path,
      hash: contentHash,
      lastModified: now,
      chunkCount: chunks.length,
    });

    return chunks.length;
  }

  /**
   * Index a directory
   */
  async indexDirectory(
    dirPath: string,
    options?: {
      extensions?: string[];
      recursive?: boolean;
      ignore?: string[];
    }
  ): Promise<{ files: number; chunks: number }> {
    const extensions = options?.extensions || ['.md', '.txt'];
    const recursive = options?.recursive !== false;
    const ignore = options?.ignore || ['node_modules', '.git', 'dist'];

    let totalFiles = 0;
    let totalChunks = 0;

    const processDir = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (recursive && !ignore.includes(entry.name)) {
            await processDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = '.' + entry.name.split('.').pop();
          if (extensions.includes(ext)) {
            const chunks = await this.indexFile(fullPath);
            if (chunks > 0) {
              totalFiles++;
              totalChunks += chunks;
            }
          }
        }
      }
    };

    await processDir(dirPath);

    return { files: totalFiles, chunks: totalChunks };
  }

  /**
   * Sync workspace memory files
   */
  async syncWorkspace(workspaceDir: string): Promise<{ files: number; chunks: number }> {
    let totalFiles = 0;
    let totalChunks = 0;

    // Index MEMORY.md if exists
    try {
      const memoryPath = join(workspaceDir, 'MEMORY.md');
      const chunks = await this.indexFile(memoryPath);
      if (chunks > 0) {
        totalFiles++;
        totalChunks += chunks;
      }
    } catch {
      // MEMORY.md doesn't exist, that's OK
    }

    // Index memory/ directory if exists
    try {
      const memoryDir = join(workspaceDir, 'memory');
      const stats = await stat(memoryDir);
      if (stats.isDirectory()) {
        const result = await this.indexDirectory(memoryDir, {
          extensions: ['.md'],
          recursive: true,
        });
        totalFiles += result.files;
        totalChunks += result.chunks;
      }
    } catch {
      // memory/ directory doesn't exist, that's OK
    }

    return { files: totalFiles, chunks: totalChunks };
  }

  /**
   * Remove a file from index
   */
  async removeFile(path: string): Promise<void> {
    this.store.deleteFileChunks(path);
    this.store.deleteFileInfo(path);
  }

  /**
   * Check if file needs re-indexing
   */
  async needsReindex(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, 'utf-8');
      const contentHash = hashContent(content);
      const existingInfo = this.store.getFileInfo(path);

      return !existingInfo || existingInfo.hash !== contentHash;
    } catch {
      return false;
    }
  }
}

/**
 * Create an indexer with a store
 */
export function createIndexer(store: MemoryStore): MemoryIndexer {
  return new MemoryIndexer(store);
}
