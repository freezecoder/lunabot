/**
 * Memory Store - SQLite storage for memory chunks
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { cosineSimilarity } from './embeddings.js';
import type { MemoryChunk, MemorySearchResult, MemoryFileInfo, MemoryStatus } from './types.js';
import { getMemoryDir } from '../config/paths.js';

/**
 * Memory Store class
 */
export class MemoryStore {
  private db!: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || join(getMemoryDir(), 'memory.sqlite');
  }

  /**
   * Initialize the database
   */
  async init(): Promise<void> {
    // Ensure directory exists
    const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });

    // Open database
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        hash TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
    `);
  }

  /**
   * Close the database
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  /**
   * Save a chunk
   */
  saveChunk(chunk: MemoryChunk): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, path, content, embedding, line_start, line_end, hash, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      chunk.id,
      chunk.path,
      chunk.content,
      Buffer.from(new Float32Array(chunk.embedding).buffer),
      chunk.lineStart,
      chunk.lineEnd,
      chunk.hash,
      chunk.metadata ? JSON.stringify(chunk.metadata) : null,
      chunk.createdAt,
      chunk.updatedAt
    );
  }

  /**
   * Save multiple chunks in a transaction
   */
  saveChunks(chunks: MemoryChunk[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, path, content, embedding, line_start, line_end, hash, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((chunks: MemoryChunk[]) => {
      for (const chunk of chunks) {
        stmt.run(
          chunk.id,
          chunk.path,
          chunk.content,
          Buffer.from(new Float32Array(chunk.embedding).buffer),
          chunk.lineStart,
          chunk.lineEnd,
          chunk.hash,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          chunk.createdAt,
          chunk.updatedAt
        );
      }
    });

    insertMany(chunks);
  }

  /**
   * Get a chunk by ID
   */
  getChunk(id: string): MemoryChunk | undefined {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) return undefined;

    return this.rowToChunk(row);
  }

  /**
   * Get all chunks for a file
   */
  getFileChunks(path: string): MemoryChunk[] {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE path = ? ORDER BY line_start');
    const rows = stmt.all(path) as any[];

    return rows.map(row => this.rowToChunk(row));
  }

  /**
   * Delete all chunks for a file
   */
  deleteFileChunks(path: string): number {
    const stmt = this.db.prepare('DELETE FROM chunks WHERE path = ?');
    const result = stmt.run(path);
    return result.changes;
  }

  /**
   * Search by embedding similarity
   */
  searchByEmbedding(
    queryEmbedding: number[],
    maxResults: number = 6,
    minScore: number = 0.35
  ): MemorySearchResult[] {
    // Get all chunks with embeddings
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL');
    const rows = stmt.all() as any[];

    // Calculate similarities
    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      const chunk = this.rowToChunk(row);
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);

      if (score >= minScore) {
        results.push({ chunk, score });
      }
    }

    // Sort by score and limit
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Full-text search (simple LIKE-based)
   */
  searchByText(query: string, maxResults: number = 10): MemorySearchResult[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks
      WHERE content LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(`%${query}%`, maxResults) as any[];

    return rows.map(row => ({
      chunk: this.rowToChunk(row),
      score: 1.0, // Text matches get max score
    }));
  }

  /**
   * Get file info
   */
  getFileInfo(path: string): MemoryFileInfo | undefined {
    const stmt = this.db.prepare('SELECT * FROM files WHERE path = ?');
    const row = stmt.get(path) as any;

    if (!row) return undefined;

    return {
      path: row.path,
      hash: row.hash,
      lastModified: row.last_modified,
      chunkCount: row.chunk_count,
    };
  }

  /**
   * Update file info
   */
  updateFileInfo(info: MemoryFileInfo): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, last_modified, chunk_count)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(info.path, info.hash, info.lastModified, info.chunkCount);
  }

  /**
   * Delete file info
   */
  deleteFileInfo(path: string): void {
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    stmt.run(path);
  }

  /**
   * Get all indexed files
   */
  listIndexedFiles(): MemoryFileInfo[] {
    const stmt = this.db.prepare('SELECT * FROM files ORDER BY path');
    const rows = stmt.all() as any[];

    return rows.map(row => ({
      path: row.path,
      hash: row.hash,
      lastModified: row.last_modified,
      chunkCount: row.chunk_count,
    }));
  }

  /**
   * Get store status
   */
  getStatus(): MemoryStatus {
    const chunkCount = (this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as any).count;
    const fileCount = (this.db.prepare('SELECT COUNT(*) as count FROM files').get() as any).count;

    return {
      enabled: true,
      dbPath: this.dbPath,
      totalChunks: chunkCount,
      totalFiles: fileCount,
      embeddingModel: process.env.LOCALBOT_EMBEDDING_MODEL || 'nomic-embed-text',
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.db.exec('DELETE FROM chunks');
    this.db.exec('DELETE FROM files');
  }

  /**
   * Convert database row to MemoryChunk
   */
  private rowToChunk(row: any): MemoryChunk {
    // Convert BLOB back to number array
    let embedding: number[] = [];
    if (row.embedding) {
      const buffer = row.embedding as Buffer;
      const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
      embedding = Array.from(float32Array);
    }

    return {
      id: row.id,
      path: row.path,
      content: row.content,
      embedding,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      hash: row.hash,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Create and initialize a memory store
 */
export async function createMemoryStore(dbPath?: string): Promise<MemoryStore> {
  const store = new MemoryStore(dbPath);
  await store.init();
  return store;
}
