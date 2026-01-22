/**
 * Session Store - SQLite-based session persistence
 *
 * This module has been migrated from JSON file storage to SQLite.
 * The interface remains the same for backward compatibility.
 */

import { getDB, createLogger } from '../db/index.js';
import type { SessionRecord, MessageRecord, Channel } from '../db/types.js';
import type { SessionEntry, SessionStoreData, CacheEntry } from './types.js';
import type { Message } from '../types.js';

const STORE_VERSION = 2;  // Bumped for SQLite migration

/**
 * Convert SessionEntry to SessionRecord for database storage
 */
function toRecord(session: SessionEntry, channel: Channel = 'terminal'): Omit<SessionRecord, 'created_at' | 'updated_at'> {
  return {
    id: session.sessionId,
    user_id: session.userId,
    channel,
    model: session.model,
    token_input: session.tokenUsage?.input || 0,
    token_output: session.tokenUsage?.output || 0,
    message_count: session.messages?.length || 0,
    metadata: session.metadata ? JSON.stringify(session.metadata) : null,
  };
}

/**
 * Convert SessionRecord back to SessionEntry
 */
function toEntry(record: SessionRecord, messages: Message[]): SessionEntry {
  return {
    sessionId: record.id,
    userId: record.user_id,
    model: record.model,
    messages,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    tokenUsage: {
      input: record.token_input,
      output: record.token_output,
      total: record.token_input + record.token_output,
    },
    metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
  };
}

/**
 * Convert Message to MessageRecord
 */
function messageToRecord(sessionId: string, message: Message): Omit<MessageRecord, 'id' | 'created_at'> {
  return {
    session_id: sessionId,
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    tool_call_id: message.tool_call_id || null,
    name: message.name || null,
  };
}

/**
 * Convert MessageRecord to Message
 */
function recordToMessage(record: MessageRecord): Message {
  const msg: Message = {
    role: record.role as Message['role'],
    content: record.content,
  };

  if (record.tool_calls) {
    msg.tool_calls = JSON.parse(record.tool_calls);
  }
  if (record.tool_call_id) {
    msg.tool_call_id = record.tool_call_id;
  }
  if (record.name) {
    msg.name = record.name;
  }

  return msg;
}

/**
 * Session Store class - SQLite backed
 */
export class SessionStore {
  private channel: Channel;
  private cache: CacheEntry<SessionStoreData> | null = null;
  private cacheTtl: number;

  constructor(storePath?: string, cacheTtlMs?: number, channel: Channel = 'terminal') {
    // storePath is ignored - we use SQLite now
    // cacheTtlMs is kept for interface compatibility
    this.cacheTtl = cacheTtlMs || 45000;
    this.channel = channel;
  }

  /**
   * Load the session store (returns in-memory snapshot for compatibility)
   */
  async load(): Promise<SessionStoreData> {
    // Check cache validity
    if (this.cache && Date.now() - this.cache.timestamp < this.cache.ttl) {
      return this.cache.data;
    }

    const db = getDB();
    const records = db.getSessions({ channel: this.channel });

    const sessions: SessionEntry[] = [];
    for (const record of records) {
      const msgRecords = db.getMessages(record.id);
      const messages = msgRecords.map(recordToMessage);
      sessions.push(toEntry(record, messages));
    }

    const data: SessionStoreData = {
      version: STORE_VERSION,
      sessions,
      lastUpdated: Date.now(),
    };

    this.cache = {
      data,
      timestamp: Date.now(),
      ttl: this.cacheTtl,
    };

    return data;
  }

  /**
   * Save is now a no-op - SQLite persists immediately
   */
  async save(): Promise<void> {
    // No-op: SQLite persists immediately
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionEntry | undefined> {
    const db = getDB();
    const record = db.getSession(sessionId);

    if (!record) return undefined;

    const msgRecords = db.getMessages(sessionId);
    const messages = msgRecords.map(recordToMessage);

    return toEntry(record, messages);
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<SessionEntry[]> {
    const db = getDB();
    const records = db.getSessions({ userId, channel: this.channel });

    const sessions: SessionEntry[] = [];
    for (const record of records) {
      const msgRecords = db.getMessages(record.id);
      const messages = msgRecords.map(recordToMessage);
      sessions.push(toEntry(record, messages));
    }

    return sessions;
  }

  /**
   * Save or update a session
   */
  async updateSession(session: SessionEntry): Promise<void> {
    const db = getDB();
    const now = Date.now();

    // Check if session exists
    const existing = db.getSession(session.sessionId);

    // Upsert session record
    db.upsertSession({
      ...toRecord(session, this.channel),
      created_at: existing?.created_at || session.createdAt || now,
      updated_at: session.updatedAt || now,
    });

    // Sync messages if provided
    if (session.messages && session.messages.length > 0) {
      // Get existing messages
      const existingMsgs = db.getMessages(session.sessionId);

      // Add only new messages (by comparing count)
      const newMsgs = session.messages.slice(existingMsgs.length);
      for (const msg of newMsgs) {
        db.addMessage(messageToRecord(session.sessionId, msg));
      }
    }

    // Invalidate cache
    this.cache = null;

    // Log the update
    const logger = createLogger(this.channel, session.sessionId, session.userId);
    if (!existing) {
      logger.sessionCreated(session.sessionId, session.userId);
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const db = getDB();
    const result = db.deleteSession(sessionId);

    if (result) {
      this.cache = null;
    }

    return result;
  }

  /**
   * Clear all sessions for a user
   */
  async clearUserSessions(userId: string): Promise<number> {
    const db = getDB();
    const sessions = db.getSessions({ userId, channel: this.channel });

    let removed = 0;
    for (const session of sessions) {
      if (db.deleteSession(session.id)) {
        removed++;
      }
    }

    if (removed > 0) {
      this.cache = null;
    }

    return removed;
  }

  /**
   * Clear all sessions
   */
  async clearAll(): Promise<void> {
    const db = getDB();
    const sessions = db.getSessions({ channel: this.channel });

    for (const session of sessions) {
      db.deleteSession(session.id);
    }

    this.cache = null;
  }

  /**
   * Get session count
   */
  async count(): Promise<number> {
    const db = getDB();
    const sessions = db.getSessions({ channel: this.channel });
    return sessions.length;
  }

  /**
   * List all session IDs
   */
  async listSessionIds(): Promise<string[]> {
    const db = getDB();
    const sessions = db.getSessions({ channel: this.channel });
    return sessions.map(s => s.id);
  }

  /**
   * Invalidate cache
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Force immediate save (no-op for SQLite)
   */
  async flush(): Promise<void> {
    // No-op: SQLite persists immediately
  }

  /**
   * Clean up expired sessions (older than maxAge)
   */
  async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const db = getDB();
    const cutoff = Date.now() - maxAgeMs;
    const sessions = db.getSessions({ channel: this.channel, until: cutoff });

    let removed = 0;
    for (const session of sessions) {
      if (db.deleteSession(session.id)) {
        removed++;
      }
    }

    if (removed > 0) {
      this.cache = null;
    }

    return removed;
  }

  /**
   * Export sessions as JSON (for migration/backup)
   */
  async export(): Promise<string> {
    const data = await this.load();
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import sessions from JSON (for migration)
   */
  async import(json: string, merge: boolean = false): Promise<number> {
    const imported: SessionStoreData = JSON.parse(json);
    const db = getDB();

    if (!merge) {
      // Clear existing sessions first
      await this.clearAll();
    }

    let count = 0;
    for (const session of imported.sessions) {
      if (merge) {
        // Check if exists and compare timestamps
        const existing = db.getSession(session.sessionId);
        if (existing && existing.updated_at >= session.updatedAt) {
          continue;  // Skip older or same version
        }
      }

      // Import session
      await this.updateSession(session);
      count++;
    }

    this.cache = null;
    return count;
  }

  /**
   * Add a single message to a session
   */
  async addMessage(sessionId: string, message: Message): Promise<void> {
    const db = getDB();

    // Ensure session exists
    let session = db.getSession(sessionId);
    if (!session) {
      // Create minimal session if it doesn't exist
      db.upsertSession({
        id: sessionId,
        user_id: 'unknown',
        channel: this.channel,
        model: 'unknown',
        token_input: 0,
        token_output: 0,
        message_count: 0,
        metadata: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // Add message
    db.addMessage(messageToRecord(sessionId, message));

    this.cache = null;
  }

  /**
   * Get messages for a session
   */
  async getMessages(sessionId: string): Promise<Message[]> {
    const db = getDB();
    const records = db.getMessages(sessionId);
    return records.map(recordToMessage);
  }

  /**
   * Clear messages for a session
   */
  async clearMessages(sessionId: string): Promise<void> {
    const db = getDB();
    db.clearMessages(sessionId);

    const logger = createLogger(this.channel, sessionId);
    logger.sessionCleared(sessionId);

    this.cache = null;
  }

  /**
   * Update token usage for a session
   */
  async updateTokenUsage(sessionId: string, input: number, output: number): Promise<void> {
    const db = getDB();
    const session = db.getSession(sessionId);

    if (session) {
      db.upsertSession({
        ...session,
        token_input: session.token_input + input,
        token_output: session.token_output + output,
        updated_at: Date.now(),
      });
    }

    this.cache = null;
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
 * Save session store (convenience function - no-op for SQLite)
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
