/**
 * Session types for LocalBot
 */

import type { Message } from '../types.js';

/**
 * Session entry stored to disk
 */
export interface SessionEntry {
  sessionId: string;
  userId: string;
  model: string;
  messages: Message[];
  createdAt: number;   // Unix timestamp ms
  updatedAt: number;   // Unix timestamp ms
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Session store data structure
 */
export interface SessionStoreData {
  version: number;
  sessions: SessionEntry[];
  lastUpdated: number;
}

/**
 * Cache entry with TTL
 */
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Session manager configuration
 */
export interface SessionManagerConfig {
  storePath?: string;
  cacheTtlMs?: number;
  maxMessagesPerSession?: number;
  autoSave?: boolean;
  autoSaveIntervalMs?: number;
}

/**
 * Session statistics
 */
export interface SessionStats {
  sessionId: string;
  messageCount: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  createdAt: Date;
  updatedAt: Date;
  model: string;
}

/**
 * Convert SessionEntry to runtime Session
 */
export function toSession(entry: SessionEntry): import('../types.js').Session {
  return {
    id: entry.sessionId,
    userId: entry.userId,
    model: entry.model,
    messages: entry.messages,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    metadata: entry.metadata,
  };
}

/**
 * Convert runtime Session to SessionEntry
 */
export function toSessionEntry(
  session: import('../types.js').Session,
  tokenUsage?: { input: number; output: number; total: number }
): SessionEntry {
  return {
    sessionId: session.id,
    userId: session.userId,
    model: session.model,
    messages: session.messages,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
    tokenUsage: tokenUsage || { input: 0, output: 0, total: 0 },
    metadata: session.metadata,
  };
}
