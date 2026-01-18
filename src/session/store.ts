/**
 * Session Store - File-based session persistence with TTL caching
 */

import { readFile, writeFile, mkdir, access, constants } from 'fs/promises';
import { join, dirname } from 'path';
import { getSessionsDir, getSessionCacheTtl, ensureDir } from '../config/paths.js';
import type { SessionEntry, SessionStoreData, CacheEntry } from './types.js';

const STORE_VERSION = 1;
const STORE_FILENAME = 'sessions.json';

/**
 * Simple file lock using atomic operations
 */
async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = 5000
): Promise<T> {
  const startTime = Date.now();

  // Try to acquire lock
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Try to create lock file exclusively
      await writeFile(lockPath, String(Date.now()), { flag: 'wx' });
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock exists, check if stale (older than 30s)
        try {
          const content = await readFile(lockPath, 'utf-8');
          const lockTime = parseInt(content, 10);
          if (Date.now() - lockTime > 30000) {
            // Stale lock, remove it
            const { unlink } = await import('fs/promises');
            await unlink(lockPath);
            continue;
          }
        } catch {
          // Lock file might have been removed
        }
        // Wait and retry
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    // Release lock
    try {
      const { unlink } = await import('fs/promises');
      await unlink(lockPath);
    } catch {
      // Ignore unlock errors
    }
  }
}

/**
 * Session Store class
 */
export class SessionStore {
  private storePath: string;
  private lockPath: string;
  private cache: CacheEntry<SessionStoreData> | null = null;
  private cacheTtl: number;
  private dirty: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(storePath?: string, cacheTtlMs?: number) {
    const sessionsDir = storePath || getSessionsDir();
    this.storePath = join(sessionsDir, STORE_FILENAME);
    this.lockPath = join(sessionsDir, '.sessions.lock');
    this.cacheTtl = cacheTtlMs || getSessionCacheTtl();
  }

  /**
   * Load the session store from disk
   */
  async load(): Promise<SessionStoreData> {
    // Check cache validity
    if (this.cache && Date.now() - this.cache.timestamp < this.cache.ttl) {
      return this.cache.data;
    }

    return withFileLock(this.lockPath, async () => {
      try {
        await ensureDir(dirname(this.storePath));
        const content = await readFile(this.storePath, 'utf-8');
        const data: SessionStoreData = JSON.parse(content);

        // Validate version
        if (data.version !== STORE_VERSION) {
          // Handle migration if needed
          console.warn(`Session store version mismatch: ${data.version} vs ${STORE_VERSION}`);
        }

        this.cache = {
          data,
          timestamp: Date.now(),
          ttl: this.cacheTtl,
        };

        return data;
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // File doesn't exist, create empty store
          const emptyStore: SessionStoreData = {
            version: STORE_VERSION,
            sessions: [],
            lastUpdated: Date.now(),
          };
          this.cache = {
            data: emptyStore,
            timestamp: Date.now(),
            ttl: this.cacheTtl,
          };
          return emptyStore;
        }
        throw err;
      }
    });
  }

  /**
   * Save the session store to disk
   */
  async save(): Promise<void> {
    if (!this.cache) return;

    return withFileLock(this.lockPath, async () => {
      await ensureDir(dirname(this.storePath));

      this.cache!.data.lastUpdated = Date.now();
      const content = JSON.stringify(this.cache!.data, null, 2);
      await writeFile(this.storePath, content, 'utf-8');

      this.dirty = false;
    });
  }

  /**
   * Mark store as dirty and schedule save
   */
  private markDirty(): void {
    this.dirty = true;

    // Debounce saves
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save().catch(err => {
        console.error('Failed to auto-save sessions:', err);
      });
    }, 1000);
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionEntry | undefined> {
    const data = await this.load();
    return data.sessions.find(s => s.sessionId === sessionId);
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<SessionEntry[]> {
    const data = await this.load();
    return data.sessions.filter(s => s.userId === userId);
  }

  /**
   * Save or update a session
   */
  async updateSession(session: SessionEntry): Promise<void> {
    const data = await this.load();

    const index = data.sessions.findIndex(s => s.sessionId === session.sessionId);
    if (index >= 0) {
      data.sessions[index] = session;
    } else {
      data.sessions.push(session);
    }

    this.cache!.data = data;
    this.markDirty();
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const data = await this.load();

    const index = data.sessions.findIndex(s => s.sessionId === sessionId);
    if (index < 0) return false;

    data.sessions.splice(index, 1);
    this.cache!.data = data;
    this.markDirty();

    return true;
  }

  /**
   * Clear all sessions for a user
   */
  async clearUserSessions(userId: string): Promise<number> {
    const data = await this.load();

    const before = data.sessions.length;
    data.sessions = data.sessions.filter(s => s.userId !== userId);
    const removed = before - data.sessions.length;

    if (removed > 0) {
      this.cache!.data = data;
      this.markDirty();
    }

    return removed;
  }

  /**
   * Clear all sessions
   */
  async clearAll(): Promise<void> {
    const data = await this.load();
    data.sessions = [];
    this.cache!.data = data;
    this.markDirty();
  }

  /**
   * Get session count
   */
  async count(): Promise<number> {
    const data = await this.load();
    return data.sessions.length;
  }

  /**
   * List all session IDs
   */
  async listSessionIds(): Promise<string[]> {
    const data = await this.load();
    return data.sessions.map(s => s.sessionId);
  }

  /**
   * Invalidate cache
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Force immediate save
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
  }

  /**
   * Clean up expired sessions (older than maxAge)
   */
  async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const data = await this.load();
    const cutoff = Date.now() - maxAgeMs;

    const before = data.sessions.length;
    data.sessions = data.sessions.filter(s => s.updatedAt > cutoff);
    const removed = before - data.sessions.length;

    if (removed > 0) {
      this.cache!.data = data;
      this.markDirty();
    }

    return removed;
  }

  /**
   * Export sessions as JSON
   */
  async export(): Promise<string> {
    const data = await this.load();
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import sessions from JSON
   */
  async import(json: string, merge: boolean = false): Promise<number> {
    const imported: SessionStoreData = JSON.parse(json);

    if (imported.version !== STORE_VERSION) {
      throw new Error(`Incompatible store version: ${imported.version}`);
    }

    const data = await this.load();

    if (merge) {
      // Merge sessions, preferring newer versions
      for (const session of imported.sessions) {
        const index = data.sessions.findIndex(s => s.sessionId === session.sessionId);
        if (index >= 0) {
          if (session.updatedAt > data.sessions[index].updatedAt) {
            data.sessions[index] = session;
          }
        } else {
          data.sessions.push(session);
        }
      }
    } else {
      // Replace all sessions
      data.sessions = imported.sessions;
    }

    this.cache!.data = data;
    this.markDirty();

    return imported.sessions.length;
  }
}

/**
 * Global session store instance
 */
export const globalSessionStore = new SessionStore();

/**
 * Load session store (convenience function)
 */
export async function loadSessionStore(): Promise<SessionStoreData> {
  return globalSessionStore.load();
}

/**
 * Save session store (convenience function)
 */
export async function saveSessionStore(): Promise<void> {
  return globalSessionStore.save();
}

/**
 * Update a session (convenience function)
 */
export async function updateSession(session: SessionEntry): Promise<void> {
  return globalSessionStore.updateSession(session);
}
