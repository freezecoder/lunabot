/**
 * Database types for LocalBot logging and persistence system
 */

// ============ Event Types ============

/**
 * All event types that can be logged
 */
export type EventType =
  // Startup events
  | 'startup.begin'
  | 'startup.complete'
  | 'startup.workspace_loaded'
  | 'startup.skills_loaded'
  | 'startup.tools_loaded'
  | 'startup.mcp_loaded'
  // Session events
  | 'session.created'
  | 'session.cleared'
  | 'session.model_changed'
  | 'session.loaded'
  // Message events
  | 'message.user'
  | 'message.assistant'
  // Tool events
  | 'tool.start'
  | 'tool.success'
  | 'tool.error'
  // Memory events
  | 'memory.sync'
  | 'memory.search'
  | 'memory.flush'
  // Cron events
  | 'cron.triggered'
  | 'cron.completed'
  | 'cron.error'
  // System events
  | 'system.error'
  | 'system.warning';

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Channel types
 */
export type Channel = 'terminal' | 'telegram' | 'gateway' | 'system';

// ============ Database Records ============

/**
 * Session record stored in SQLite
 */
export interface SessionRecord {
  id: string;
  user_id: string;
  channel: Channel;
  model: string;
  token_input: number;
  token_output: number;
  message_count: number;
  metadata: string | null;  // JSON
  created_at: number;  // Unix timestamp
  updated_at: number;  // Unix timestamp
}

/**
 * Message record stored in SQLite
 */
export interface MessageRecord {
  id?: number;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;  // JSON
  tool_call_id: string | null;
  name: string | null;
  created_at: number;  // Unix timestamp
}

/**
 * Event record stored in SQLite
 */
export interface EventRecord {
  id?: number;
  timestamp: number;  // Unix timestamp
  event_type: EventType;
  channel: Channel | null;
  session_id: string | null;
  user_id: string | null;
  level: LogLevel;
  message: string;
  data: string | null;  // JSON
}

/**
 * Startup manifest record
 */
export interface StartupManifestRecord {
  id?: number;
  started_at: number;  // Unix timestamp
  channel: Channel;
  workspace_files: string | null;  // JSON: [{name, path, loaded}]
  skills_loaded: string | null;    // JSON: [{name, source}]
  tools_count: number;
  model_default: string | null;
  duration_ms: number | null;
}

/**
 * Tool execution record
 */
export interface ToolExecutionRecord {
  id: string;
  session_id: string;
  tool_name: string;
  arguments: string | null;  // JSON
  result: string | null;
  is_error: boolean;
  started_at: number;  // Unix timestamp
  duration_ms: number | null;
}

/**
 * Memory sync record stored in SQLite
 */
export interface MemorySyncRecord {
  id?: number;
  session_id: string;
  channel: string;
  synced_at: number;  // Unix timestamp
  memory_file: string;
  summary_hash: string | null;
  message_count: number;
}

// ============ API Types ============

/**
 * Workspace file info for startup manifest
 */
export interface WorkspaceFileInfo {
  name: string;
  path: string;
  loaded: boolean;
  source?: 'global' | 'workspace';
}

/**
 * Skill info for startup manifest
 */
export interface SkillInfo {
  name: string;
  source: string;
  type?: 'tool' | 'prompt';
}

/**
 * Startup manifest for API
 */
export interface StartupManifest {
  id?: number;
  startedAt: Date;
  channel: Channel;
  workspaceFiles: WorkspaceFileInfo[];
  skillsLoaded: SkillInfo[];
  toolsCount: number;
  modelDefault: string | null;
  durationMs: number | null;
}

/**
 * Event for API
 */
export interface Event {
  id?: number;
  timestamp: Date;
  eventType: EventType;
  channel: Channel | null;
  sessionId: string | null;
  userId: string | null;
  level: LogLevel;
  message: string;
  data: Record<string, unknown> | null;
}

/**
 * Session with messages for API
 */
export interface SessionWithMessages {
  id: string;
  userId: string;
  channel: Channel;
  model: string;
  tokenInput: number;
  tokenOutput: number;
  messageCount: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id?: number;
    role: string;
    content: string;
    toolCalls: unknown[] | null;
    toolCallId: string | null;
    name: string | null;
    createdAt: Date;
  }>;
}

/**
 * Tool execution for API
 */
export interface ToolExecution {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;
  result: string | null;
  isError: boolean;
  startedAt: Date;
  durationMs: number | null;
}

/**
 * Memory sync for API
 */
export interface MemorySync {
  id?: number;
  sessionId: string;
  channel: Channel;
  syncedAt: Date;
  memoryFile: string;
  summaryHash: string | null;
  messageCount: number;
}

// ============ Query Options ============

/**
 * Options for querying events
 */
export interface EventQueryOptions {
  channel?: Channel;
  eventType?: EventType;
  sessionId?: string;
  userId?: string;
  level?: LogLevel;
  since?: Date | number;
  until?: Date | number;
  limit?: number;
  offset?: number;
}

/**
 * Options for querying sessions
 */
export interface SessionQueryOptions {
  channel?: Channel;
  userId?: string;
  since?: Date | number;
  until?: Date | number;
  limit?: number;
  offset?: number;
}

/**
 * Options for querying unsynced sessions for memory sync
 */
export interface MemorySyncQueryOptions {
  channel?: Channel;
  minIdleMs?: number;  // Minimum idle time before syncing
  since?: Date | number;
  limit?: number;
}

// ============ Statistics ============

/**
 * Event statistics
 */
export interface EventStats {
  total: number;
  byType: Record<string, number>;
  byChannel: Record<string, number>;
  byLevel: Record<string, number>;
  recentErrors: number;
}

/**
 * Session statistics
 */
export interface SessionStats {
  total: number;
  active: number;  // Sessions with messages in last 24h
  byChannel: Record<string, number>;
  totalMessages: number;
  totalTokensInput: number;
  totalTokensOutput: number;
}
