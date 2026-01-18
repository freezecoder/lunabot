/**
 * Session Manager - manages user sessions for Telegram bot
 */

import type { Session, Message } from '../../types.js';
import { v4 as uuid } from 'uuid';

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

export class SessionManager {
  private sessions: Map<number, TelegramSession> = new Map();
  private defaultModel: string;
  private maxHistoryLength: number;

  constructor(options: { defaultModel?: string; maxHistoryLength?: number } = {}) {
    this.defaultModel = options.defaultModel || 'llama3.1:8b';
    this.maxHistoryLength = options.maxHistoryLength || 50;
  }

  /**
   * Get or create a session for a chat
   */
  get(chatId: number, username?: string): TelegramSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        id: uuid(),
        userId: String(chatId),
        chatId,
        username,
        messages: [],
        model: this.defaultModel,
        createdAt: new Date(),
        updatedAt: new Date(),
        preferences: {
          showToolCalls: true,
          streamingEnabled: true,
        },
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  /**
   * Check if session exists
   */
  has(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Add a message to session history
   */
  addMessage(chatId: number, message: Message): void {
    const session = this.get(chatId);
    session.messages.push(message);
    session.updatedAt = new Date();

    // Trim history if too long
    if (session.messages.length > this.maxHistoryLength) {
      // Keep system message if present, then trim from start
      const systemIdx = session.messages.findIndex(m => m.role === 'system');
      if (systemIdx === 0) {
        session.messages = [
          session.messages[0],
          ...session.messages.slice(-(this.maxHistoryLength - 1)),
        ];
      } else {
        session.messages = session.messages.slice(-this.maxHistoryLength);
      }
    }
  }

  /**
   * Get messages for a session
   */
  getMessages(chatId: number): Message[] {
    return this.get(chatId).messages;
  }

  /**
   * Clear session messages
   */
  clear(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.messages = [];
      session.updatedAt = new Date();
    }
  }

  /**
   * Delete session entirely
   */
  delete(chatId: number): boolean {
    return this.sessions.delete(chatId);
  }

  /**
   * Set model for session
   */
  setModel(chatId: number, model: string): void {
    const session = this.get(chatId);
    session.model = model;
    session.updatedAt = new Date();
  }

  /**
   * Get model for session
   */
  getModel(chatId: number): string {
    return this.get(chatId).model;
  }

  /**
   * Update preferences
   */
  setPreferences(chatId: number, prefs: Partial<UserPreferences>): void {
    const session = this.get(chatId);
    session.preferences = { ...session.preferences, ...prefs };
    session.updatedAt = new Date();
  }

  /**
   * Get preferences
   */
  getPreferences(chatId: number): UserPreferences {
    return this.get(chatId).preferences;
  }

  /**
   * Set last message ID (for editing)
   */
  setLastMessageId(chatId: number, messageId: number): void {
    const session = this.get(chatId);
    session.lastMessageId = messageId;
  }

  /**
   * Get last message ID
   */
  getLastMessageId(chatId: number): number | undefined {
    return this.sessions.get(chatId)?.lastMessageId;
  }

  /**
   * Get all sessions (for admin)
   */
  getAll(): TelegramSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session count
   */
  get count(): number {
    return this.sessions.size;
  }

  /**
   * Get session stats
   */
  getStats(): {
    totalSessions: number;
    totalMessages: number;
    byModel: Record<string, number>;
  } {
    const byModel: Record<string, number> = {};
    let totalMessages = 0;

    for (const session of this.sessions.values()) {
      totalMessages += session.messages.length;
      byModel[session.model] = (byModel[session.model] || 0) + 1;
    }

    return {
      totalSessions: this.sessions.size,
      totalMessages,
      byModel,
    };
  }
}
