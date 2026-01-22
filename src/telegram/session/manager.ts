/**
 * Session Manager - manages user sessions for Telegram bot
 * Now backed by SQLite for persistence
 */

import type { Session, Message } from '../../types.js';
import { v4 as uuid } from 'uuid';
import { getDB, createLogger } from '../../db/index.js';
import type { SessionRecord, MessageRecord, Channel } from '../../db/types.js';

export interface UserPreferences {
  model?: string;
  showToolCalls?: boolean;
  streamingEnabled?: boolean;
}

export interface TelegramSession extends Session {
  chatId: number;
  username?: string;
  preferences: UserPreferences;
  lastMessageId?: number;
}

// In-memory cache for last message IDs (not persisted)
const lastMessageIds = new Map<number, number>();

/**
 * Convert database record to TelegramSession
 */
function toTelegramSession(record: SessionRecord, messages: Message[]): TelegramSession {
  const metadata = record.metadata ? JSON.parse(record.metadata) : {};

  return {
    id: record.id,
    userId: record.user_id,
    chatId: parseInt(record.user_id, 10),  // chatId is stored as user_id
    username: metadata.username,
    messages,
    model: record.model,
    createdAt: new Date(record.created_at),
    updatedAt: new Date(record.updated_at),
    preferences: metadata.preferences || { showToolCalls: true, streamingEnabled: true },
    lastMessageId: lastMessageIds.get(parseInt(record.user_id, 10)),
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

export class SessionManager {
  private defaultModel: string;
  private maxHistoryLength: number;
  private channel: Channel = 'telegram';
  private logger = createLogger('telegram');

  constructor(options: { defaultModel?: string; maxHistoryLength?: number; storagePath?: string } = {}) {
    this.defaultModel = options.defaultModel || 'llama3.1:8b';
    this.maxHistoryLength = options.maxHistoryLength || 50;
    // storagePath is ignored - we use SQLite now

    // Log session manager initialization
    this.logger.info('startup.begin', 'Telegram session manager initialized');
  }

  /**
   * Get session ID for a chat
   */
  private getSessionId(chatId: number): string {
    return `telegram-${chatId}`;
  }

  /**
   * Get or create a session for a chat
   */
  get(chatId: number, username?: string): TelegramSession {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);

    let record = db.getSession(sessionId);

    if (!record) {
      // Create new session
      const now = Date.now();
      const metadata = JSON.stringify({
        username,
        preferences: { showToolCalls: true, streamingEnabled: true },
      });

      db.upsertSession({
        id: sessionId,
        user_id: String(chatId),
        channel: this.channel,
        model: this.defaultModel,
        token_input: 0,
        token_output: 0,
        message_count: 0,
        metadata,
        created_at: now,
        updated_at: now,
      });

      record = db.getSession(sessionId)!;

      // Log session creation
      this.logger.forSession(sessionId, String(chatId)).sessionCreated(sessionId, String(chatId));
    }

    const msgRecords = db.getMessages(sessionId);
    const messages = msgRecords.map(recordToMessage);

    return toTelegramSession(record, messages);
  }

  /**
   * Check if session exists
   */
  has(chatId: number): boolean {
    const db = getDB();
    const record = db.getSession(this.getSessionId(chatId));
    return !!record;
  }

  /**
   * Add a message to session history
   */
  addMessage(chatId: number, message: Message): void {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);

    // Ensure session exists
    this.get(chatId);

    // Add message
    db.addMessage(messageToRecord(sessionId, message));

    // Trim history if too long
    const messages = db.getMessages(sessionId);
    if (messages.length > this.maxHistoryLength) {
      // Find system message if present
      const systemIdx = messages.findIndex(m => m.role === 'system');
      const systemMsg = systemIdx === 0 ? messages[0] : null;

      // Clear all messages
      db.clearMessages(sessionId);

      // Re-add system message if present, then last N-1 messages
      if (systemMsg) {
        db.addMessage(messageToRecord(sessionId, recordToMessage(systemMsg)));
      }

      const keepCount = systemMsg ? this.maxHistoryLength - 1 : this.maxHistoryLength;
      const toKeep = messages.slice(-keepCount);

      for (const msg of toKeep) {
        if (msg.id === systemMsg?.id) continue;  // Skip system message if already added
        db.addMessage(messageToRecord(sessionId, recordToMessage(msg)));
      }
    }

    // Log message
    const logger = this.logger.forSession(sessionId, String(chatId));
    if (message.role === 'user') {
      logger.userMessage(message.content);
    } else if (message.role === 'assistant') {
      logger.assistantMessage(message.content);
    }
  }

  /**
   * Get messages for a session
   */
  getMessages(chatId: number): Message[] {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const records = db.getMessages(sessionId);
    return records.map(recordToMessage);
  }

  /**
   * Clear session messages
   */
  clear(chatId: number): void {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    db.clearMessages(sessionId);

    this.logger.forSession(sessionId, String(chatId)).sessionCleared(sessionId);
  }

  /**
   * Delete session entirely
   */
  delete(chatId: number): boolean {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const result = db.deleteSession(sessionId);
    lastMessageIds.delete(chatId);
    return result;
  }

  /**
   * Set model for session
   */
  setModel(chatId: number, model: string): void {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const session = db.getSession(sessionId);

    if (session) {
      const oldModel = session.model;
      db.upsertSession({
        ...session,
        model,
        updated_at: Date.now(),
      });

      this.logger.forSession(sessionId, String(chatId)).modelChanged(sessionId, oldModel, model);
    }
  }

  /**
   * Get model for session
   */
  getModel(chatId: number): string {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const session = db.getSession(sessionId);
    return session?.model || this.defaultModel;
  }

  /**
   * Update preferences
   */
  setPreferences(chatId: number, prefs: Partial<UserPreferences>): void {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const session = db.getSession(sessionId);

    if (session) {
      const currentMetadata = session.metadata ? JSON.parse(session.metadata) : {};
      const newMetadata = {
        ...currentMetadata,
        preferences: { ...currentMetadata.preferences, ...prefs },
      };

      db.upsertSession({
        ...session,
        metadata: JSON.stringify(newMetadata),
        updated_at: Date.now(),
      });
    }
  }

  /**
   * Get preferences
   */
  getPreferences(chatId: number): UserPreferences {
    const session = this.get(chatId);
    return session.preferences;
  }

  /**
   * Set last message ID (for editing)
   */
  setLastMessageId(chatId: number, messageId: number): void {
    lastMessageIds.set(chatId, messageId);
  }

  /**
   * Get last message ID
   */
  getLastMessageId(chatId: number): number | undefined {
    return lastMessageIds.get(chatId);
  }

  /**
   * Get all sessions (for admin)
   */
  getAll(): TelegramSession[] {
    const db = getDB();
    const records = db.getSessions({ channel: this.channel });

    return records.map(record => {
      const msgRecords = db.getMessages(record.id);
      const messages = msgRecords.map(recordToMessage);
      return toTelegramSession(record, messages);
    });
  }

  /**
   * Get session count
   */
  get count(): number {
    const db = getDB();
    const records = db.getSessions({ channel: this.channel });
    return records.length;
  }

  /**
   * Get session stats
   */
  getStats(): {
    totalSessions: number;
    totalMessages: number;
    byModel: Record<string, number>;
  } {
    const db = getDB();
    const records = db.getSessions({ channel: this.channel });

    const byModel: Record<string, number> = {};
    let totalMessages = 0;

    for (const record of records) {
      totalMessages += record.message_count;
      byModel[record.model] = (byModel[record.model] || 0) + 1;
    }

    return {
      totalSessions: records.length,
      totalMessages,
      byModel,
    };
  }

  /**
   * Save to disk - now a no-op since SQLite persists immediately
   */
  saveToDisk(): void {
    // No-op: SQLite persists immediately
  }

  /**
   * Update token usage for a session
   */
  updateTokenUsage(chatId: number, input: number, output: number): void {
    const db = getDB();
    const sessionId = this.getSessionId(chatId);
    const session = db.getSession(sessionId);

    if (session) {
      db.upsertSession({
        ...session,
        token_input: session.token_input + input,
        token_output: session.token_output + output,
        updated_at: Date.now(),
      });
    }
  }
}
