/**
 * Activity Tracker - Shared activity log for dashboard monitoring
 * Both terminal and telegram bot write here, dashboard reads
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface ActivityEntry {
  timestamp: number;
  source: 'terminal' | 'telegram' | 'system' | 'cron';
  type: 'message' | 'tool_call' | 'error' | 'session' | 'status' | 'reminder' | 'attachment';
  sessionId: string;
  userId?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityLog {
  entries: ActivityEntry[];
  lastUpdated: number;
  stats: {
    terminal: { messages: number; toolCalls: number; errors: number };
    telegram: { messages: number; toolCalls: number; errors: number };
  };
}

const ACTIVITY_PATH = join(homedir(), '.localbot', 'activity.json');
const MAX_ENTRIES = 100;

/**
 * Ensure activity file exists
 */
function ensureActivityFile(): void {
  const dir = dirname(ACTIVITY_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(ACTIVITY_PATH)) {
    const initial: ActivityLog = {
      entries: [],
      lastUpdated: Date.now(),
      stats: {
        terminal: { messages: 0, toolCalls: 0, errors: 0 },
        telegram: { messages: 0, toolCalls: 0, errors: 0 },
      },
    };
    writeFileSync(ACTIVITY_PATH, JSON.stringify(initial, null, 2));
  }
}

/**
 * Read activity log
 */
export function readActivityLog(): ActivityLog {
  ensureActivityFile();
  try {
    const data = readFileSync(ACTIVITY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      entries: [],
      lastUpdated: Date.now(),
      stats: {
        terminal: { messages: 0, toolCalls: 0, errors: 0 },
        telegram: { messages: 0, toolCalls: 0, errors: 0 },
      },
    };
  }
}

/**
 * Log an activity
 */
export function logActivity(entry: Omit<ActivityEntry, 'timestamp'>): void {
  ensureActivityFile();

  try {
    const log = readActivityLog();

    const fullEntry: ActivityEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    log.entries.push(fullEntry);

    // Trim to max entries
    if (log.entries.length > MAX_ENTRIES) {
      log.entries = log.entries.slice(-MAX_ENTRIES);
    }

    // Update stats
    const source = entry.source === 'terminal' ? 'terminal' : 'telegram';
    if (entry.source !== 'system') {
      if (entry.type === 'message') {
        log.stats[source].messages++;
      } else if (entry.type === 'tool_call') {
        log.stats[source].toolCalls++;
      } else if (entry.type === 'error') {
        log.stats[source].errors++;
      }
    }

    log.lastUpdated = Date.now();

    writeFileSync(ACTIVITY_PATH, JSON.stringify(log, null, 2));
  } catch (err) {
    // Silently fail - don't interrupt main flow
    console.error('[Activity] Failed to log:', err);
  }
}

/**
 * Get recent activity
 */
export function getRecentActivity(limit: number = 20, source?: 'terminal' | 'telegram'): ActivityEntry[] {
  const log = readActivityLog();
  let entries = log.entries;

  if (source) {
    entries = entries.filter(e => e.source === source);
  }

  return entries.slice(-limit);
}

/**
 * Get activity stats
 */
export function getActivityStats(): ActivityLog['stats'] {
  return readActivityLog().stats;
}

/**
 * Clear activity log
 */
export function clearActivityLog(): void {
  const initial: ActivityLog = {
    entries: [],
    lastUpdated: Date.now(),
    stats: {
      terminal: { messages: 0, toolCalls: 0, errors: 0 },
      telegram: { messages: 0, toolCalls: 0, errors: 0 },
    },
  };
  ensureActivityFile();
  writeFileSync(ACTIVITY_PATH, JSON.stringify(initial, null, 2));
}
