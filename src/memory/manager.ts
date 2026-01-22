/**
 * Memory Manager - High-level API for memory operations
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { MemoryStore, createMemoryStore } from './store.js';
import { MemoryIndexer } from './indexer.js';
import { generateEmbedding } from './embeddings.js';
import type {
  MemorySearchResult,
  MemoryConfig,
  MemoryStatus,
  DEFAULT_MEMORY_CONFIG,
} from './types.js';
import { getMemoryDir, getAgentDir } from '../config/paths.js';
import { createLogger, type Logger } from '../db/index.js';
import type { Channel } from '../db/types.js';

// Module-level logger for memory operations
let memoryLogger: Logger | null = null;

/**
 * Set the channel for memory logging
 */
export function setMemoryLoggerChannel(channel: Channel): void {
  memoryLogger = createLogger(channel);
}

/**
 * Get the memory logger (creates with 'system' channel if not set)
 */
function getLogger(): Logger {
  if (!memoryLogger) {
    memoryLogger = createLogger('system');
  }
  return memoryLogger;
}

/**
 * Memory Manager class
 */
export class MemoryManager {
  private store: MemoryStore;
  private indexer: MemoryIndexer;
  private config: MemoryConfig;
  private initialized: boolean = false;
  private workspaceDir: string;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = {
      enabled: config?.enabled !== false,
      store: {
        path: config?.store?.path || join(getMemoryDir(), 'memory.sqlite'),
      },
      chunking: {
        tokens: config?.chunking?.tokens || 400,
        overlap: config?.chunking?.overlap || 80,
      },
      sync: {
        onSessionStart: config?.sync?.onSessionStart !== false,
        onSearch: config?.sync?.onSearch !== false,
        watch: config?.sync?.watch || false,
      },
      query: {
        maxResults: config?.query?.maxResults || 6,
        minScore: config?.query?.minScore || 0.35,
      },
      embedding: {
        model: config?.embedding?.model || process.env.LOCALBOT_EMBEDDING_MODEL || 'nomic-embed-text',
      },
    };

    this.workspaceDir = getAgentDir();
    this.store = new MemoryStore(this.config.store.path);
    this.indexer = new MemoryIndexer(this.store, {
      chunking: this.config.chunking,
      embedding: this.config.embedding,
    });
  }

  /**
   * Initialize the memory manager
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.store.init();
    this.initialized = true;

    // Sync on init if configured
    if (this.config.sync.onSessionStart) {
      await this.sync();
    }
  }

  /**
   * Ensure manager is initialized
   */
  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * Search memory for relevant content
   */
  async search(
    query: string,
    maxResults?: number
  ): Promise<MemorySearchResult[]> {
    await this.ensureInit();

    // Optionally sync before search
    if (this.config.sync.onSearch) {
      await this.sync();
    }

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query, this.config.embedding.model);

    // Search by embedding similarity
    const results = this.store.searchByEmbedding(
      queryEmbedding,
      maxResults || this.config.query.maxResults,
      this.config.query.minScore
    );

    // Log the search
    const logger = getLogger();
    logger.memorySearch(query, results.length);

    return results;
  }

  /**
   * Simple text search (no embedding)
   */
  async textSearch(query: string, maxResults?: number): Promise<MemorySearchResult[]> {
    await this.ensureInit();

    return this.store.searchByText(query, maxResults || this.config.query.maxResults);
  }

  /**
   * Sync memory files from workspace
   */
  async sync(): Promise<{ files: number; chunks: number }> {
    await this.ensureInit();

    const result = await this.indexer.syncWorkspace(this.workspaceDir);

    // Log the sync
    const logger = getLogger();
    logger.memorySync(result.files, result.chunks);

    return result;
  }

  /**
   * Index a specific file
   */
  async indexFile(path: string): Promise<number> {
    await this.ensureInit();

    return this.indexer.indexFile(path);
  }

  /**
   * Index a directory
   */
  async indexDirectory(
    path: string,
    options?: { extensions?: string[]; recursive?: boolean }
  ): Promise<{ files: number; chunks: number }> {
    await this.ensureInit();

    return this.indexer.indexDirectory(path, options);
  }

  /**
   * Flush content to memory file
   * Creates a new file in memory/ with today's date
   */
  async flush(content: string): Promise<string> {
    await this.ensureInit();

    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const memoryDir = join(this.workspaceDir, 'memory');
    const filePath = join(memoryDir, `${date}.md`);

    // Ensure memory directory exists
    await mkdir(memoryDir, { recursive: true });

    // Append to existing file or create new
    try {
      const { readFile: rf } = await import('fs/promises');
      const existing = await rf(filePath, 'utf-8');
      await writeFile(filePath, existing + '\n\n---\n\n' + content, 'utf-8');
    } catch {
      // File doesn't exist, create it
      const header = `# Memory - ${date}\n\n`;
      await writeFile(filePath, header + content, 'utf-8');
    }

    // Re-index the file
    await this.indexer.indexFile(filePath, { force: true });

    // Log the flush
    const logger = getLogger();
    logger.info('memory.flush', `Flushed content to ${filePath}`, { filePath, contentLength: content.length });

    return filePath;
  }

  /**
   * Get a specific memory file's content
   */
  async getFile(
    path: string,
    options?: { lineStart?: number; lineEnd?: number }
  ): Promise<string | undefined> {
    await this.ensureInit();

    const chunks = this.store.getFileChunks(path);
    if (chunks.length === 0) return undefined;

    // If specific lines requested, filter chunks
    if (options?.lineStart !== undefined || options?.lineEnd !== undefined) {
      const start = options.lineStart || 0;
      const end = options.lineEnd || Infinity;

      const relevantChunks = chunks.filter(
        c => c.lineEnd >= start && c.lineStart <= end
      );

      return relevantChunks.map(c => c.content).join('\n');
    }

    // Return all content
    return chunks.map(c => c.content).join('\n');
  }

  /**
   * Get memory status
   */
  async getStatus(): Promise<MemoryStatus> {
    await this.ensureInit();

    const status = this.store.getStatus();
    return {
      ...status,
      embeddingModel: this.config.embedding.model,
    };
  }

  /**
   * List all indexed files
   */
  async listFiles(): Promise<{ path: string; chunks: number; lastModified: Date }[]> {
    await this.ensureInit();

    const files = this.store.listIndexedFiles();
    return files.map(f => ({
      path: f.path,
      chunks: f.chunkCount,
      lastModified: new Date(f.lastModified),
    }));
  }

  /**
   * Clear all memory
   */
  async clear(): Promise<void> {
    await this.ensureInit();

    this.store.clear();
  }

  /**
   * Close the memory manager
   */
  close(): void {
    this.store.close();
    this.initialized = false;
  }

  /**
   * Set workspace directory
   */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir;
  }

  /**
   * Check if enabled
   */
  get enabled(): boolean {
    return this.config.enabled;
  }
}

// Global memory manager instance
let globalMemoryManager: MemoryManager | null = null;

/**
 * Get or create global memory manager
 */
export async function getMemoryManager(
  config?: Partial<MemoryConfig>
): Promise<MemoryManager> {
  if (!globalMemoryManager) {
    globalMemoryManager = new MemoryManager(config);
    await globalMemoryManager.init();
  }
  return globalMemoryManager;
}

/**
 * Reset global memory manager (for testing)
 */
export function resetMemoryManager(): void {
  if (globalMemoryManager) {
    globalMemoryManager.close();
    globalMemoryManager = null;
  }
}
