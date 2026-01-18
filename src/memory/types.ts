/**
 * Memory types for LocalBot
 */

/**
 * A chunk of indexed content
 */
export interface MemoryChunk {
  id: string;
  path: string;
  content: string;
  embedding: number[];
  lineStart: number;
  lineEnd: number;
  hash: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Search result from memory
 */
export interface MemorySearchResult {
  chunk: MemoryChunk;
  score: number;
  highlights?: string[];
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  enabled: boolean;
  store: {
    path: string;  // SQLite database path
  };
  chunking: {
    tokens: number;   // Target tokens per chunk (default: 400)
    overlap: number;  // Overlap tokens between chunks (default: 80)
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
  };
  query: {
    maxResults: number;  // default: 6
    minScore: number;    // default: 0.35
  };
  embedding: {
    model: string;       // default: nomic-embed-text
    dimensions?: number;
  };
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  store: {
    path: '', // Set dynamically
  },
  chunking: {
    tokens: 400,
    overlap: 80,
  },
  sync: {
    onSessionStart: true,
    onSearch: true,
    watch: false,
  },
  query: {
    maxResults: 6,
    minScore: 0.35,
  },
  embedding: {
    model: 'nomic-embed-text',
  },
};

/**
 * File info for memory indexing
 */
export interface MemoryFileInfo {
  path: string;
  hash: string;
  lastModified: number;
  chunkCount: number;
}

/**
 * Memory status
 */
export interface MemoryStatus {
  enabled: boolean;
  dbPath: string;
  totalChunks: number;
  totalFiles: number;
  embeddingModel: string;
  lastSync?: Date;
}

/**
 * Chunking strategy
 */
export type ChunkingStrategy = 'paragraph' | 'sentence' | 'fixed' | 'hybrid';
