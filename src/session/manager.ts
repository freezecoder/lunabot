/**
 * Session Manager - Unified session management with persistence
 */

import type { Message, Session } from '../types.js';
import { SessionStore, globalSessionStore } from './store.js';
import { toSession, toSessionEntry, type SessionEntry, type SessionManagerConfig, type SessionStats } from './types.js';
import { globalTokenTracker } from '../tracking/tokens.js';

/**
 * Session Manager class
 */
export class SessionManager {
  private store: SessionStore;
  private memoryCache: Map<string, Session> = new Map();
  private maxMessages: number;
  private autoSave: boolean;
  private defaultModel: string;

  constructor(config: SessionManagerConfig = {}) {
    this.store = config.storePath
      ? new SessionStore(config.storePath, config.cacheTtlMs)
      : globalSessionStore;
    this.maxMessages = config.maxMessagesPerSession || 100;
    this.autoSave = config.autoSave !== false;
    this.defaultModel = 'llama3.1:8b';
  }

  /**
   * Set the default model for new sessions
   */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /**
   * Get or create a session
   */
  async getSession(sessionId: string, userId: string = 'default'): Promise<Session> {
    // Check memory cache first
    let session = this.memoryCache.get(sessionId);
    if (session) {
      return session;
    }

    // Try to load from disk
    const entry = await this.store.getSession(sessionId);
    if (entry) {
      session = toSession(entry);
      this.memoryCache.set(sessionId, session);
      return session;
    }

    // Create new session
    session = {
      id: sessionId,
      userId,
      messages: [],
      model: this.defaultModel,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.memoryCache.set(sessionId, session);

    if (this.autoSave) {
      await this.persistSession(sessionId);
    }

    return session;
  }

  /**
   * Add a message to a session
   */
  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.memoryCache.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.messages.push(message);
    session.updatedAt = new Date();

    // Trim if over max
    if (session.messages.length > this.maxMessages) {
      // Keep system message if first, then trim oldest
      if (session.messages[0]?.role === 'system') {
        const systemMsg = session.messages[0];
        session.messages = [systemMsg, ...session.messages.slice(-this.maxMessages + 1)];
      } else {
        session.messages = session.messages.slice(-this.maxMessages);
      }
    }

    if (this.autoSave) {
      await this.persistSession(sessionId);
    }
  }

  /**
   * Set the model for a session
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.memoryCache.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.model = model;
    session.updatedAt = new Date();

    if (this.autoSave) {
      await this.persistSession(sessionId);
    }
  }

  /**
   * Get session model
   */
  getModel(sessionId: string): string | undefined {
    return this.memoryCache.get(sessionId)?.model;
  }

  /**
   * Get session messages
   */
  getMessages(sessionId: string): Message[] {
    return this.memoryCache.get(sessionId)?.messages || [];
  }

  /**
   * Clear a session's messages
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.memoryCache.get(sessionId);
    if (session) {
      session.messages = [];
      session.updatedAt = new Date();

      if (this.autoSave) {
        await this.persistSession(sessionId);
      }
    }
  }

  /**
   * Delete a session completely
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.memoryCache.delete(sessionId);
    return this.store.deleteSession(sessionId);
  }

  /**
   * Get session statistics
   */
  async getStats(sessionId: string): Promise<SessionStats | undefined> {
    const session = this.memoryCache.get(sessionId);
    if (!session) return undefined;

    const tokenStats = globalTokenTracker.getSessionStats(sessionId);

    return {
      sessionId,
      messageCount: session.messages.length,
      tokenUsage: tokenStats ? {
        input: tokenStats.totalInput,
        output: tokenStats.totalOutput,
        total: tokenStats.totalTokens,
      } : { input: 0, output: 0, total: 0 },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
    };
  }

  /**
   * List all session IDs
   */
  async listSessions(): Promise<string[]> {
    // Combine memory and disk sessions
    const diskSessions = await this.store.listSessionIds();
    const memorySessions = Array.from(this.memoryCache.keys());

    return [...new Set([...diskSessions, ...memorySessions])];
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<Session[]> {
    const entries = await this.store.getUserSessions(userId);
    return entries.map(toSession);
  }

  /**
   * Persist a session to disk
   */
  async persistSession(sessionId: string): Promise<void> {
    const session = this.memoryCache.get(sessionId);
    if (!session) return;

    const tokenStats = globalTokenTracker.getSessionStats(sessionId);
    const entry = toSessionEntry(session, tokenStats ? {
      input: tokenStats.totalInput,
      output: tokenStats.totalOutput,
      total: tokenStats.totalTokens,
    } : undefined);

    await this.store.updateSession(entry);
  }

  /**
   * Persist all sessions
   */
  async persistAll(): Promise<void> {
    for (const sessionId of this.memoryCache.keys()) {
      await this.persistSession(sessionId);
    }
    await this.store.flush();
  }

  /**
   * Load sessions for a user into memory
   */
  async loadUserSessions(userId: string): Promise<Session[]> {
    const entries = await this.store.getUserSessions(userId);
    const sessions: Session[] = [];

    for (const entry of entries) {
      const session = toSession(entry);
      this.memoryCache.set(session.id, session);
      sessions.push(session);
    }

    return sessions;
  }

  /**
   * Clear all sessions for a user
   */
  async clearUserSessions(userId: string): Promise<number> {
    // Clear from memory
    for (const [id, session] of this.memoryCache) {
      if (session.userId === userId) {
        this.memoryCache.delete(id);
      }
    }

    // Clear from disk
    return this.store.clearUserSessions(userId);
  }

  /**
   * Clear all sessions
   */
  async clearAll(): Promise<void> {
    this.memoryCache.clear();
    await this.store.clearAll();
  }

  /**
   * Clean up old sessions
   */
  async cleanup(maxAgeMs?: number): Promise<number> {
    return this.store.cleanup(maxAgeMs);
  }

  /**
   * Export sessions as JSON
   */
  async export(): Promise<string> {
    await this.persistAll();
    return this.store.export();
  }

  /**
   * Import sessions from JSON
   */
  async import(json: string, merge?: boolean): Promise<number> {
    const count = await this.store.import(json, merge);
    this.memoryCache.clear(); // Clear cache to reload from disk
    return count;
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.memoryCache.has(sessionId);
  }

  /**
   * Get session count
   */
  async count(): Promise<number> {
    return this.store.count();
  }
}

/**
 * Global session manager instance
 */
export const globalSessionManager = new SessionManager();
