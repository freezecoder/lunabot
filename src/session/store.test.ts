/**
 * Session Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { SessionStore } from './store.js';
import type { SessionEntry } from './types.js';
import { useTempDir } from '../../test/helpers/temp-dir.js';

describe('SessionStore', () => {
  const tempDir = useTempDir('session-test-');
  let store: SessionStore;

  beforeEach(async () => {
    const dir = await tempDir.setup();
    store = new SessionStore(dir, 1000);
  });

  afterEach(async () => {
    await store.flush();
    await tempDir.cleanup();
  });

  const createTestSession = (id: string, userId: string = 'user-1'): SessionEntry => ({
    sessionId: id,
    userId,
    model: 'llama3.1:8b',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tokenUsage: { input: 100, output: 50, total: 150 },
  });

  describe('load', () => {
    it('should create empty store if file does not exist', async () => {
      const data = await store.load();
      expect(data.sessions).toEqual([]);
      expect(data.version).toBe(1);
    });

    it('should load existing sessions', async () => {
      const session = createTestSession('session-1');
      await store.updateSession(session);
      await store.flush();

      // Create new store instance to force reload
      const newStore = new SessionStore(tempDir.path, 0);
      const data = await newStore.load();

      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].sessionId).toBe('session-1');
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', async () => {
      const session = await store.getSession('non-existent');
      expect(session).toBeUndefined();
    });

    it('should return existing session', async () => {
      const session = createTestSession('session-1');
      await store.updateSession(session);

      const retrieved = await store.getSession('session-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe('session-1');
      expect(retrieved!.messages.length).toBe(2);
    });
  });

  describe('updateSession', () => {
    it('should add new session', async () => {
      const session = createTestSession('session-1');
      await store.updateSession(session);

      const count = await store.count();
      expect(count).toBe(1);
    });

    it('should update existing session', async () => {
      const session = createTestSession('session-1');
      await store.updateSession(session);

      session.messages.push({ role: 'user', content: 'Another message' });
      session.updatedAt = Date.now();
      await store.updateSession(session);

      const retrieved = await store.getSession('session-1');
      expect(retrieved!.messages.length).toBe(3);
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      const session = createTestSession('session-1');
      await store.updateSession(session);

      const deleted = await store.deleteSession('session-1');
      expect(deleted).toBe(true);

      const retrieved = await store.getSession('session-1');
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent session', async () => {
      const deleted = await store.deleteSession('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('getUserSessions', () => {
    it('should return all sessions for a user', async () => {
      await store.updateSession(createTestSession('session-1', 'user-1'));
      await store.updateSession(createTestSession('session-2', 'user-1'));
      await store.updateSession(createTestSession('session-3', 'user-2'));

      const user1Sessions = await store.getUserSessions('user-1');
      expect(user1Sessions.length).toBe(2);

      const user2Sessions = await store.getUserSessions('user-2');
      expect(user2Sessions.length).toBe(1);
    });
  });

  describe('clearUserSessions', () => {
    it('should clear all sessions for a user', async () => {
      await store.updateSession(createTestSession('session-1', 'user-1'));
      await store.updateSession(createTestSession('session-2', 'user-1'));
      await store.updateSession(createTestSession('session-3', 'user-2'));

      const removed = await store.clearUserSessions('user-1');
      expect(removed).toBe(2);

      const remaining = await store.count();
      expect(remaining).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all sessions', async () => {
      await store.updateSession(createTestSession('session-1'));
      await store.updateSession(createTestSession('session-2'));

      await store.clearAll();

      const count = await store.count();
      expect(count).toBe(0);
    });
  });

  describe('listSessionIds', () => {
    it('should return all session IDs', async () => {
      await store.updateSession(createTestSession('session-1'));
      await store.updateSession(createTestSession('session-2'));
      await store.updateSession(createTestSession('session-3'));

      const ids = await store.listSessionIds();
      expect(ids).toContain('session-1');
      expect(ids).toContain('session-2');
      expect(ids).toContain('session-3');
    });
  });

  describe('cleanup', () => {
    it('should remove old sessions', async () => {
      const oldSession = createTestSession('old-session');
      oldSession.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await store.updateSession(oldSession);

      const newSession = createTestSession('new-session');
      await store.updateSession(newSession);

      const removed = await store.cleanup(7 * 24 * 60 * 60 * 1000); // 7 days
      expect(removed).toBe(1);

      const remaining = await store.count();
      expect(remaining).toBe(1);
    });
  });

  describe('export/import', () => {
    it('should export and import sessions', async () => {
      await store.updateSession(createTestSession('session-1'));
      await store.updateSession(createTestSession('session-2'));

      const exported = await store.export();
      const parsed = JSON.parse(exported);
      expect(parsed.sessions.length).toBe(2);

      // Create new store and import
      const newDir = await useTempDir('import-test-').setup();
      const newStore = new SessionStore(newDir, 1000);

      const imported = await newStore.import(exported);
      expect(imported).toBe(2);

      const count = await newStore.count();
      expect(count).toBe(2);
    });

    it('should merge sessions when import with merge=true', async () => {
      await store.updateSession(createTestSession('session-1'));

      const exported = await store.export();

      // Update the session
      const updated = createTestSession('session-1');
      updated.messages.push({ role: 'user', content: 'New message' });
      updated.updatedAt = Date.now() + 1000;
      await store.updateSession(updated);

      // Add another session
      await store.updateSession(createTestSession('session-2'));

      // Import with merge
      await store.import(exported, true);

      const count = await store.count();
      expect(count).toBe(2); // Should still have 2 (merged, not duplicated)
    });
  });

  describe('caching', () => {
    it('should use cache within TTL', async () => {
      await store.updateSession(createTestSession('session-1'));

      // Load twice should use cache
      await store.load();
      const data = await store.load();

      expect(data.sessions.length).toBe(1);
    });

    it('should invalidate cache on request', async () => {
      await store.updateSession(createTestSession('session-1'));
      await store.flush();

      store.invalidateCache();

      // Should reload from disk
      const data = await store.load();
      expect(data.sessions.length).toBe(1);
    });
  });
});
