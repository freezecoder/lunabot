/**
 * Memory Tools - Search and retrieve from indexed memory
 */

import type { Tool } from '../../types.js';
import { getMemoryManager } from '../../memory/manager.js';

/**
 * Memory search tool - semantic search across indexed content
 */
export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: 'RESTRICTED: Only call this when user explicitly says "remember", "recall", "what did we discuss", or asks about past conversations. NEVER use for greetings, hello, hi, general questions, or anything else.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query - describe what you\'re looking for',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 6)',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const maxResults = (args.maxResults as number) || 6;

    try {
      const manager = await getMemoryManager();

      if (!manager.enabled) {
        return 'Memory is not enabled. Set LOCALBOT_MEMORY_ENABLED=true to enable.';
      }

      const results = await manager.search(query, maxResults);

      if (results.length === 0) {
        return `No relevant memories found for query: "${query}"`;
      }

      // Format results
      const formatted = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        const lines = `lines ${r.chunk.lineStart}-${r.chunk.lineEnd}`;
        const preview = r.chunk.content.slice(0, 500);

        return `[${i + 1}] ${r.chunk.path} (${lines}, ${score}% match)\n${preview}${r.chunk.content.length > 500 ? '...' : ''}`;
      });

      return `Found ${results.length} relevant memories:\n\n${formatted.join('\n\n---\n\n')}`;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // Check for embedding model not found error
      if (errMsg.includes('not found') && errMsg.includes('pulling')) {
        const model = process.env.LOCALBOT_EMBEDDING_MODEL || 'nomic-embed-text';
        return `Memory search requires embedding model "${model}" which is not installed.\n\nTo install it, run:\n  ollama pull ${model}\n\nOr use a different model with LOCALBOT_EMBEDDING_MODEL environment variable.`;
      }

      return `Memory search failed: ${errMsg}`;
    }
  },
};

/**
 * Memory get tool - read a specific memory file
 */
export const memoryGetTool: Tool = {
  name: 'memory_get',
  description: 'Read a specific memory file. Path must be under memory/ directory or MEMORY.md.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the memory file (must be memory/* or MEMORY.md)',
      },
      lineStart: {
        type: 'number',
        description: 'Start reading from this line (optional)',
      },
      lineEnd: {
        type: 'number',
        description: 'Stop reading at this line (optional)',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const lineStart = args.lineStart as number | undefined;
    const lineEnd = args.lineEnd as number | undefined;

    // Validate path is in memory area
    const normalizedPath = path.toLowerCase();
    if (!normalizedPath.includes('memory/') && !normalizedPath.endsWith('memory.md')) {
      return 'Error: Path must be a memory file (memory/* or MEMORY.md)';
    }

    try {
      const manager = await getMemoryManager();

      if (!manager.enabled) {
        return 'Memory is not enabled.';
      }

      const content = await manager.getFile(path, { lineStart, lineEnd });

      if (!content) {
        return `Memory file not found or not indexed: ${path}`;
      }

      return content;
    } catch (error) {
      return `Failed to read memory file: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Memory sync tool - manually trigger memory sync
 */
export const memorySyncTool: Tool = {
  name: 'memory_sync',
  description: 'Sync memory index with workspace files. Run this to update the index after file changes.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args: Record<string, unknown>): Promise<string> {
    try {
      const manager = await getMemoryManager();

      if (!manager.enabled) {
        return 'Memory is not enabled.';
      }

      const result = await manager.sync();

      if (result.files === 0) {
        return 'Memory sync complete. No files needed updating.';
      }

      return `Memory sync complete. Indexed ${result.files} file(s) with ${result.chunks} chunk(s).`;
    } catch (error) {
      return `Memory sync failed: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Memory save tool - save content to memory
 */
export const memorySaveTool: Tool = {
  name: 'memory_save',
  description: 'Save content to memory for future retrieval. Content is stored in a dated file under memory/.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The content to save to memory',
      },
    },
    required: ['content'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string;

    if (!content || content.trim().length === 0) {
      return 'Error: Content cannot be empty';
    }

    try {
      const manager = await getMemoryManager();

      if (!manager.enabled) {
        return 'Memory is not enabled.';
      }

      const filePath = await manager.flush(content);

      return `Content saved to memory at: ${filePath}`;
    } catch (error) {
      return `Failed to save to memory: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Memory status tool - check memory system status
 */
export const memoryStatusTool: Tool = {
  name: 'memory_status',
  description: 'Check the status of the memory system including indexed files and configuration.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args: Record<string, unknown>): Promise<string> {
    try {
      const manager = await getMemoryManager();

      if (!manager.enabled) {
        return 'Memory is not enabled. Set LOCALBOT_MEMORY_ENABLED=true to enable.';
      }

      const status = await manager.getStatus();
      const files = await manager.listFiles();

      const lines = [
        '=== Memory Status ===',
        `Enabled: ${status.enabled}`,
        `Database: ${status.dbPath}`,
        `Embedding Model: ${status.embeddingModel}`,
        `Total Chunks: ${status.totalChunks}`,
        `Total Files: ${status.totalFiles}`,
        '',
        'Indexed Files:',
      ];

      if (files.length === 0) {
        lines.push('  (none)');
      } else {
        for (const file of files.slice(0, 10)) {
          lines.push(`  ${file.path} (${file.chunks} chunks)`);
        }
        if (files.length > 10) {
          lines.push(`  ... and ${files.length - 10} more`);
        }
      }

      return lines.join('\n');
    } catch (error) {
      return `Failed to get memory status: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Export all memory tools
 */
export const memoryTools: Tool[] = [
  memorySearchTool,
  memoryGetTool,
  memorySyncTool,
  memorySaveTool,
  memoryStatusTool,
];

export default memoryTools;
