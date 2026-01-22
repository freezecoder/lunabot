/**
 * LocalBot Database - SQLite-based persistence and logging
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getLocalbotHome } from '../config/paths.js';
import type {
  EventType,
  LogLevel,
  Channel,
  SessionRecord,
  MessageRecord,
  EventRecord,
  StartupManifestRecord,
  ToolExecutionRecord,
  MemorySyncRecord,
  Event,
  EventQueryOptions,
  EventStats,
  SessionQueryOptions,
  SessionStats,
  SessionWithMessages,
  StartupManifest,
  WorkspaceFileInfo,
  SkillInfo,
  ToolExecution,
  MemorySync,
  MemorySyncQueryOptions,
} from './types.js';

// ============ Database Schema ============

const SCHEMA = `
-- Sessions (replaces JSON files)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  model TEXT NOT NULL,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Chat history (replaces message arrays)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);

-- Event log (replaces activity-tracker)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT,
  session_id TEXT,
  user_id TEXT,
  level TEXT DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT
);

-- Startup manifests (tracks what was loaded)
CREATE TABLE IF NOT EXISTS startup_manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  channel TEXT NOT NULL,
  workspace_files TEXT,
  skills_loaded TEXT,
  tools_count INTEGER,
  model_default TEXT,
  duration_ms INTEGER
);

-- Tool executions (enhanced tracking)
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments TEXT,
  result TEXT,
  is_error INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER
);

-- Memory sync tracking (tracks which sessions have been synced to memory)
CREATE TABLE IF NOT EXISTS memory_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  memory_file TEXT NOT NULL,
  summary_hash TEXT,
  message_count INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_started ON tool_executions(started_at);
CREATE INDEX IF NOT EXISTS idx_memory_sync_session ON memory_sync_log(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_sync_channel ON memory_sync_log(channel);
`;

// ============ LocalBotDB Class ============

/**
 * LocalBot SQLite Database
 */
export class LocalBotDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    // Default path: ~/.localbot/localbot.db
    const localbotHome = getLocalbotHome();
    if (!existsSync(localbotHome)) {
      mkdirSync(localbotHome, { recursive: true });
    }

    this.dbPath = dbPath || join(localbotHome, 'localbot.db');
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize schema
    this.db.exec(SCHEMA);
  }

  /**
   * Get the database path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }

  // ============ Session Methods ============

  /**
   * Create or update a session
   */
  upsertSession(session: Omit<SessionRecord, 'created_at' | 'updated_at'> & { created_at?: number; updated_at?: number }): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, user_id, channel, model, token_input, token_output, message_count, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model = excluded.model,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        message_count = excluded.message_count,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      session.id,
      session.user_id,
      session.channel,
      session.model,
      session.token_input || 0,
      session.token_output || 0,
      session.message_count || 0,
      session.metadata || null,
      session.created_at || now,
      session.updated_at || now
    );
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): SessionRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(sessionId) as SessionRecord | undefined;
  }

  /**
   * Get sessions with optional filters
   */
  getSessions(options: SessionQueryOptions = {}): SessionRecord[] {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: unknown[] = [];

    if (options.channel) {
      sql += ' AND channel = ?';
      params.push(options.channel);
    }
    if (options.userId) {
      sql += ' AND user_id = ?';
      params.push(options.userId);
    }
    if (options.since) {
      const ts = options.since instanceof Date ? options.since.getTime() : options.since;
      sql += ' AND updated_at >= ?';
      params.push(ts);
    }
    if (options.until) {
      const ts = options.until instanceof Date ? options.until.getTime() : options.until;
      sql += ' AND updated_at <= ?';
      params.push(ts);
    }

    sql += ' ORDER BY updated_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as SessionRecord[];
  }

  /**
   * Delete a session and its messages
   */
  deleteSession(sessionId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const result = stmt.run(sessionId);
    return result.changes > 0;
  }

  /**
   * Get session statistics
   */
  getSessionStats(): SessionStats {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const total = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const active = this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE updated_at >= ?').get(dayAgo) as { count: number };
    const byChannel = this.db.prepare('SELECT channel, COUNT(*) as count FROM sessions GROUP BY channel').all() as { channel: string; count: number }[];
    const totals = this.db.prepare('SELECT SUM(message_count) as messages, SUM(token_input) as input, SUM(token_output) as output FROM sessions').get() as { messages: number; input: number; output: number };

    return {
      total: total.count,
      active: active.count,
      byChannel: Object.fromEntries(byChannel.map(r => [r.channel, r.count])),
      totalMessages: totals.messages || 0,
      totalTokensInput: totals.input || 0,
      totalTokensOutput: totals.output || 0,
    };
  }

  // ============ Message Methods ============

  /**
   * Add a message to a session
   */
  addMessage(message: Omit<MessageRecord, 'id' | 'created_at'> & { created_at?: number }): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      message.session_id,
      message.role,
      message.content,
      message.tool_calls || null,
      message.tool_call_id || null,
      message.name || null,
      message.created_at || now
    );

    // Update session message count
    this.db.prepare('UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?')
      .run(now, message.session_id);

    return result.lastInsertRowid as number;
  }

  /**
   * Get messages for a session
   */
  getMessages(sessionId: string, limit?: number): MessageRecord[] {
    let sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC';
    const params: unknown[] = [sessionId];

    if (limit) {
      sql = `SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`;
      params.push(limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as MessageRecord[];
  }

  /**
   * Delete all messages for a session
   */
  clearMessages(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const result = stmt.run(sessionId);

    // Reset message count
    this.db.prepare('UPDATE sessions SET message_count = 0, updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);

    return result.changes;
  }

  /**
   * Get session with messages
   */
  getSessionWithMessages(sessionId: string): SessionWithMessages | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    const messages = this.getMessages(sessionId);

    return {
      id: session.id,
      userId: session.user_id,
      channel: session.channel as Channel,
      model: session.model,
      tokenInput: session.token_input,
      tokenOutput: session.token_output,
      messageCount: session.message_count,
      metadata: session.metadata ? JSON.parse(session.metadata) : null,
      createdAt: new Date(session.created_at),
      updatedAt: new Date(session.updated_at),
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
        toolCallId: m.tool_call_id,
        name: m.name,
        createdAt: new Date(m.created_at),
      })),
    };
  }

  // ============ Event Methods ============

  /**
   * Log an event
   */
  logEvent(event: Omit<EventRecord, 'id' | 'timestamp'> & { timestamp?: number }): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (timestamp, event_type, channel, session_id, user_id, level, message, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.timestamp || Date.now(),
      event.event_type,
      event.channel || null,
      event.session_id || null,
      event.user_id || null,
      event.level || 'info',
      event.message,
      event.data || null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get events with optional filters
   */
  getEvents(options: EventQueryOptions = {}): Event[] {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params: unknown[] = [];

    if (options.channel) {
      sql += ' AND channel = ?';
      params.push(options.channel);
    }
    if (options.eventType) {
      sql += ' AND event_type = ?';
      params.push(options.eventType);
    }
    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (options.userId) {
      sql += ' AND user_id = ?';
      params.push(options.userId);
    }
    if (options.level) {
      sql += ' AND level = ?';
      params.push(options.level);
    }
    if (options.since) {
      const ts = options.since instanceof Date ? options.since.getTime() : options.since;
      sql += ' AND timestamp >= ?';
      params.push(ts);
    }
    if (options.until) {
      const ts = options.until instanceof Date ? options.until.getTime() : options.until;
      sql += ' AND timestamp <= ?';
      params.push(ts);
    }

    sql += ' ORDER BY timestamp DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    const records = stmt.all(...params) as EventRecord[];

    return records.map(r => ({
      id: r.id,
      timestamp: new Date(r.timestamp),
      eventType: r.event_type as EventType,
      channel: r.channel as Channel | null,
      sessionId: r.session_id,
      userId: r.user_id,
      level: r.level as LogLevel,
      message: r.message,
      data: r.data ? JSON.parse(r.data) : null,
    }));
  }

  /**
   * Get event statistics
   */
  getEventStats(): EventStats {
    const hourAgo = Date.now() - 60 * 60 * 1000;

    const total = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    const byType = this.db.prepare('SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type').all() as { event_type: string; count: number }[];
    const byChannel = this.db.prepare('SELECT channel, COUNT(*) as count FROM events WHERE channel IS NOT NULL GROUP BY channel').all() as { channel: string; count: number }[];
    const byLevel = this.db.prepare('SELECT level, COUNT(*) as count FROM events GROUP BY level').all() as { level: string; count: number }[];
    const recentErrors = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE level = ? AND timestamp >= ?').get('error', hourAgo) as { count: number };

    return {
      total: total.count,
      byType: Object.fromEntries(byType.map(r => [r.event_type, r.count])),
      byChannel: Object.fromEntries(byChannel.map(r => [r.channel, r.count])),
      byLevel: Object.fromEntries(byLevel.map(r => [r.level, r.count])),
      recentErrors: recentErrors.count,
    };
  }

  /**
   * Cleanup old events (keep last N days)
   */
  cleanupEvents(daysToKeep: number = 7): number {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM events WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return result.changes;
  }

  // ============ Startup Manifest Methods ============

  /**
   * Create a startup manifest
   */
  createStartupManifest(manifest: Omit<StartupManifestRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO startup_manifests (started_at, channel, workspace_files, skills_loaded, tools_count, model_default, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      manifest.started_at,
      manifest.channel,
      manifest.workspace_files || null,
      manifest.skills_loaded || null,
      manifest.tools_count || 0,
      manifest.model_default || null,
      manifest.duration_ms || null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Update startup manifest duration
   */
  updateStartupManifestDuration(id: number, durationMs: number): void {
    const stmt = this.db.prepare('UPDATE startup_manifests SET duration_ms = ? WHERE id = ?');
    stmt.run(durationMs, id);
  }

  /**
   * Get the latest startup manifest
   */
  getLatestStartupManifest(channel?: Channel): StartupManifest | undefined {
    let sql = 'SELECT * FROM startup_manifests';
    const params: unknown[] = [];

    if (channel) {
      sql += ' WHERE channel = ?';
      params.push(channel);
    }

    sql += ' ORDER BY started_at DESC LIMIT 1';

    const stmt = this.db.prepare(sql);
    const record = stmt.get(...params) as StartupManifestRecord | undefined;

    if (!record) return undefined;

    return {
      id: record.id,
      startedAt: new Date(record.started_at),
      channel: record.channel as Channel,
      workspaceFiles: record.workspace_files ? JSON.parse(record.workspace_files) : [],
      skillsLoaded: record.skills_loaded ? JSON.parse(record.skills_loaded) : [],
      toolsCount: record.tools_count,
      modelDefault: record.model_default,
      durationMs: record.duration_ms,
    };
  }

  /**
   * Get all startup manifests
   */
  getStartupManifests(limit: number = 10): StartupManifest[] {
    const stmt = this.db.prepare('SELECT * FROM startup_manifests ORDER BY started_at DESC LIMIT ?');
    const records = stmt.all(limit) as StartupManifestRecord[];

    return records.map(r => ({
      id: r.id,
      startedAt: new Date(r.started_at),
      channel: r.channel as Channel,
      workspaceFiles: r.workspace_files ? JSON.parse(r.workspace_files) : [],
      skillsLoaded: r.skills_loaded ? JSON.parse(r.skills_loaded) : [],
      toolsCount: r.tools_count,
      modelDefault: r.model_default,
      durationMs: r.duration_ms,
    }));
  }

  // ============ Tool Execution Methods ============

  /**
   * Record a tool execution start
   */
  startToolExecution(execution: Omit<ToolExecutionRecord, 'result' | 'is_error' | 'duration_ms'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, tool_name, arguments, started_at, is_error, result, duration_ms)
      VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
    `);

    stmt.run(
      execution.id,
      execution.session_id,
      execution.tool_name,
      execution.arguments || null,
      execution.started_at
    );
  }

  /**
   * Complete a tool execution
   */
  completeToolExecution(id: string, result: string | null, isError: boolean, durationMs: number): void {
    const stmt = this.db.prepare(`
      UPDATE tool_executions SET result = ?, is_error = ?, duration_ms = ? WHERE id = ?
    `);
    stmt.run(result, isError ? 1 : 0, durationMs, id);
  }

  /**
   * Get tool executions for a session
   */
  getToolExecutions(sessionId: string, limit?: number): ToolExecution[] {
    let sql = 'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY started_at DESC';
    const params: unknown[] = [sessionId];

    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const stmt = this.db.prepare(sql);
    const records = stmt.all(...params) as ToolExecutionRecord[];

    return records.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      toolName: r.tool_name,
      arguments: r.arguments ? JSON.parse(r.arguments) : null,
      result: r.result,
      isError: Boolean(r.is_error),
      startedAt: new Date(r.started_at),
      durationMs: r.duration_ms,
    }));
  }

  /**
   * Get recent tool executions
   */
  getRecentToolExecutions(limit: number = 50): ToolExecution[] {
    const stmt = this.db.prepare('SELECT * FROM tool_executions ORDER BY started_at DESC LIMIT ?');
    const records = stmt.all(limit) as ToolExecutionRecord[];

    return records.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      toolName: r.tool_name,
      arguments: r.arguments ? JSON.parse(r.arguments) : null,
      result: r.result,
      isError: Boolean(r.is_error),
      startedAt: new Date(r.started_at),
      durationMs: r.duration_ms,
    }));
  }

  // ============ Memory Sync Methods ============

  /**
   * Record a session memory sync
   */
  markSessionSynced(
    sessionId: string,
    channel: Channel,
    memoryFile: string,
    messageCount: number,
    summaryHash?: string
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO memory_sync_log (session_id, channel, synced_at, memory_file, summary_hash, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sessionId,
      channel,
      Date.now(),
      memoryFile,
      summaryHash || null,
      messageCount
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get the last sync record for a session
   */
  getLastSessionSync(sessionId: string): MemorySync | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_sync_log WHERE session_id = ? ORDER BY synced_at DESC LIMIT 1
    `);
    const record = stmt.get(sessionId) as MemorySyncRecord | undefined;

    if (!record) return undefined;

    return {
      id: record.id,
      sessionId: record.session_id,
      channel: record.channel as Channel,
      syncedAt: new Date(record.synced_at),
      memoryFile: record.memory_file,
      summaryHash: record.summary_hash,
      messageCount: record.message_count,
    };
  }

  /**
   * Get sessions that need syncing (have new messages since last sync)
   */
  getUnsyncedSessions(options: MemorySyncQueryOptions = {}): SessionRecord[] {
    const params: unknown[] = [];

    // Base query: sessions with messages that haven't been synced or have new messages
    let sql = `
      SELECT s.* FROM sessions s
      LEFT JOIN (
        SELECT session_id, MAX(synced_at) as last_sync, MAX(message_count) as synced_count
        FROM memory_sync_log
        GROUP BY session_id
      ) sync ON s.id = sync.session_id
      WHERE s.message_count > 0
        AND (sync.session_id IS NULL OR s.message_count > sync.synced_count)
    `;

    if (options.channel) {
      sql += ' AND s.channel = ?';
      params.push(options.channel);
    }

    if (options.minIdleMs) {
      const idleCutoff = Date.now() - options.minIdleMs;
      sql += ' AND s.updated_at < ?';
      params.push(idleCutoff);
    }

    if (options.since) {
      const ts = options.since instanceof Date ? options.since.getTime() : options.since;
      sql += ' AND s.updated_at >= ?';
      params.push(ts);
    }

    sql += ' ORDER BY s.updated_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as SessionRecord[];
  }

  /**
   * Get memory sync history
   */
  getMemorySyncHistory(options: { channel?: Channel; limit?: number } = {}): MemorySync[] {
    let sql = 'SELECT * FROM memory_sync_log WHERE 1=1';
    const params: unknown[] = [];

    if (options.channel) {
      sql += ' AND channel = ?';
      params.push(options.channel);
    }

    sql += ' ORDER BY synced_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    const records = stmt.all(...params) as MemorySyncRecord[];

    return records.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      channel: r.channel as Channel,
      syncedAt: new Date(r.synced_at),
      memoryFile: r.memory_file,
      summaryHash: r.summary_hash,
      messageCount: r.message_count,
    }));
  }

  /**
   * Get last sync time for a channel
   */
  getLastSyncTime(channel?: Channel): Date | null {
    let sql = 'SELECT MAX(synced_at) as last_sync FROM memory_sync_log';
    const params: unknown[] = [];

    if (channel) {
      sql += ' WHERE channel = ?';
      params.push(channel);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { last_sync: number | null };

    return result.last_sync ? new Date(result.last_sync) : null;
  }

  /**
   * Get memory sync statistics
   */
  getMemorySyncStats(): { total: number; byChannel: Record<string, number>; lastSync: Date | null } {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM memory_sync_log').get() as { count: number };
    const byChannel = this.db.prepare('SELECT channel, COUNT(*) as count FROM memory_sync_log GROUP BY channel').all() as { channel: string; count: number }[];
    const lastSync = this.getLastSyncTime();

    return {
      total: total.count,
      byChannel: Object.fromEntries(byChannel.map(r => [r.channel, r.count])),
      lastSync,
    };
  }
}

// ============ Logger Class ============

/**
 * Channel-aware event logger
 */
export class Logger {
  private db: LocalBotDB;
  private channel: Channel;
  private sessionId?: string;
  private userId?: string;

  constructor(db: LocalBotDB, channel: Channel, sessionId?: string, userId?: string) {
    this.db = db;
    this.channel = channel;
    this.sessionId = sessionId;
    this.userId = userId;
  }

  /**
   * Create a logger for a specific session
   */
  forSession(sessionId: string, userId?: string): Logger {
    return new Logger(this.db, this.channel, sessionId, userId || this.userId);
  }

  /**
   * Log a debug message
   */
  debug(eventType: EventType, message: string, data?: Record<string, unknown>): void {
    this.log('debug', eventType, message, data);
  }

  /**
   * Log an info message
   */
  info(eventType: EventType, message: string, data?: Record<string, unknown>): void {
    this.log('info', eventType, message, data);
  }

  /**
   * Log a warning
   */
  warn(eventType: EventType, message: string, data?: Record<string, unknown>): void {
    this.log('warn', eventType, message, data);
  }

  /**
   * Log an error
   */
  error(eventType: EventType, message: string, data?: Record<string, unknown>): void {
    this.log('error', eventType, message, data);
  }

  /**
   * Log a message
   */
  private log(level: LogLevel, eventType: EventType, message: string, data?: Record<string, unknown>): void {
    this.db.logEvent({
      event_type: eventType,
      channel: this.channel,
      session_id: this.sessionId || null,
      user_id: this.userId || null,
      level,
      message,
      data: data ? JSON.stringify(data) : null,
    });
  }

  // ============ Convenience Methods ============

  /**
   * Log startup begin
   */
  startupBegin(): void {
    this.info('startup.begin', `Starting ${this.channel} channel`);
  }

  /**
   * Log startup complete
   */
  startupComplete(durationMs: number): void {
    this.info('startup.complete', `${this.channel} started in ${durationMs}ms`, { durationMs });
  }

  /**
   * Log workspace loaded
   */
  workspaceLoaded(files: WorkspaceFileInfo[]): void {
    const loaded = files.filter(f => f.loaded);
    const missing = files.filter(f => !f.loaded);
    this.info('startup.workspace_loaded', `Loaded ${loaded.length} workspace files (${missing.length} missing)`, {
      loaded: loaded.map(f => f.name),
      missing: missing.map(f => f.name),
    });
  }

  /**
   * Log skills loaded
   */
  skillsLoaded(skills: SkillInfo[]): void {
    const byType = skills.reduce((acc, s) => {
      acc[s.type || 'unknown'] = (acc[s.type || 'unknown'] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    this.info('startup.skills_loaded', `Loaded ${skills.length} skills`, { skills, byType });
  }

  /**
   * Log tools loaded
   */
  toolsLoaded(count: number): void {
    this.info('startup.tools_loaded', `Loaded ${count} tools`, { count });
  }

  /**
   * Log session created
   */
  sessionCreated(sessionId: string, userId: string): void {
    this.info('session.created', `Session created: ${sessionId}`, { sessionId, userId });
  }

  /**
   * Log session cleared
   */
  sessionCleared(sessionId: string): void {
    this.info('session.cleared', `Session cleared: ${sessionId}`, { sessionId });
  }

  /**
   * Log model changed
   */
  modelChanged(sessionId: string, oldModel: string, newModel: string): void {
    this.info('session.model_changed', `Model changed from ${oldModel} to ${newModel}`, { sessionId, oldModel, newModel });
  }

  /**
   * Log user message
   */
  userMessage(content: string, tokenCount?: number): void {
    this.info('message.user', content.slice(0, 100), { length: content.length, tokenCount });
  }

  /**
   * Log assistant message
   */
  assistantMessage(content: string, tokenCount?: number): void {
    this.info('message.assistant', content.slice(0, 100), { length: content.length, tokenCount });
  }

  /**
   * Log tool start
   */
  toolStart(toolName: string, args: Record<string, unknown>): void {
    this.info('tool.start', `Tool started: ${toolName}`, { toolName, args });
  }

  /**
   * Log tool success
   */
  toolSuccess(toolName: string, durationMs: number): void {
    this.info('tool.success', `Tool completed: ${toolName} in ${durationMs}ms`, { toolName, durationMs });
  }

  /**
   * Log tool error
   */
  toolError(toolName: string, error: string, durationMs: number): void {
    this.error('tool.error', `Tool failed: ${toolName} - ${error}`, { toolName, error, durationMs });
  }

  /**
   * Log memory sync
   */
  memorySync(files: number, chunks: number): void {
    this.info('memory.sync', `Synced ${files} files, ${chunks} chunks`, { files, chunks });
  }

  /**
   * Log memory search
   */
  memorySearch(query: string, results: number): void {
    this.info('memory.search', `Search: "${query.slice(0, 50)}" - ${results} results`, { query: query.slice(0, 100), results });
  }

  /**
   * Log system error
   */
  systemError(error: Error | string): void {
    const message = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;
    this.error('system.error', message, { stack });
  }
}

// ============ Global Instance ============

let globalDB: LocalBotDB | null = null;

/**
 * Get or create the global database instance
 */
export function getDB(dbPath?: string): LocalBotDB {
  if (!globalDB) {
    globalDB = new LocalBotDB(dbPath);
  }
  return globalDB;
}

/**
 * Create a logger for a channel
 */
export function createLogger(channel: Channel, sessionId?: string, userId?: string): Logger {
  return new Logger(getDB(), channel, sessionId, userId);
}

/**
 * Reset the global database instance (for testing)
 */
export function resetDB(): void {
  if (globalDB) {
    globalDB.close();
    globalDB = null;
  }
}

// Re-export types
export * from './types.js';
