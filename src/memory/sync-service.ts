/**
 * Memory Sync Service - Periodically syncs sessions to memory files
 *
 * Runs in the gateway to automatically:
 * 1. Find sessions with new messages
 * 2. Generate LLM summaries
 * 3. Flush to dated memory files
 * 4. Track synced sessions
 */

import type { ServiceDefinition } from '../gateway/services.js';
import type { Channel, SessionWithMessages } from '../db/types.js';
import { getDB, createLogger, type Logger } from '../db/index.js';
import { getMemoryManager } from './manager.js';
import { SessionSummarizer, type SessionSummary, type SummarizerConfig } from './summarizer.js';

/**
 * Memory sync service configuration
 */
export interface MemorySyncConfig {
  enabled: boolean;
  intervalMs: number;       // How often to sync (default: 30 min)
  minIdleMs: number;        // Min time since last message before syncing (default: 5 min)
  batchSize: number;        // Max sessions per sync cycle (default: 10)
  channels: Channel[];      // Which channels to sync
  summarizer?: Partial<SummarizerConfig>;
}

const DEFAULT_CONFIG: MemorySyncConfig = {
  enabled: process.env.LOCALBOT_MEMORY_SYNC_ENABLED !== 'false',
  intervalMs: parseInt(process.env.LOCALBOT_MEMORY_SYNC_INTERVAL || '1800000', 10), // 30 min
  minIdleMs: parseInt(process.env.LOCALBOT_MEMORY_SYNC_MIN_AGE || '300000', 10),    // 5 min
  batchSize: 10,
  channels: ['telegram', 'terminal'],
};

/**
 * Memory Sync Service
 */
export class MemorySyncService {
  private config: MemorySyncConfig;
  private summarizer: SessionSummarizer;
  private logger: Logger;
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;
  private lastSyncTime: Date | null = null;
  private syncCount = 0;
  private errorCount = 0;

  constructor(config?: Partial<MemorySyncConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.summarizer = new SessionSummarizer(config?.summarizer);
    this.logger = createLogger('gateway');
  }

  /**
   * Start the sync service
   */
  start(): void {
    if (this.running) return;

    console.log(`[MemorySync] Starting service (interval: ${this.config.intervalMs}ms, idle: ${this.config.minIdleMs}ms)`);
    this.running = true;

    // Run initial sync
    this.runSync().catch(err => {
      console.error('[MemorySync] Initial sync error:', err);
    });

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync().catch(err => {
        console.error('[MemorySync] Sync error:', err);
      });
    }, this.config.intervalMs);
  }

  /**
   * Stop the sync service
   */
  stop(): void {
    if (!this.running) return;

    console.log('[MemorySync] Stopping service');
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run a sync cycle
   */
  async runSync(): Promise<{ synced: number; errors: number }> {
    const db = getDB();
    let synced = 0;
    let errors = 0;

    try {
      // Find sessions that need syncing
      const unsyncedSessions = db.getUnsyncedSessions({
        minIdleMs: this.config.minIdleMs,
        limit: this.config.batchSize,
      });

      // Filter by configured channels
      const sessionsToSync = unsyncedSessions.filter(s =>
        this.config.channels.includes(s.channel as Channel)
      );

      if (sessionsToSync.length === 0) {
        console.log('[MemorySync] No sessions to sync');
        return { synced: 0, errors: 0 };
      }

      console.log(`[MemorySync] Found ${sessionsToSync.length} sessions to sync`);

      // Process each session
      const summaries: SessionSummary[] = [];

      for (const sessionRecord of sessionsToSync) {
        try {
          // Get full session with messages
          const session = db.getSessionWithMessages(sessionRecord.id);
          if (!session || session.messages.length === 0) continue;

          // Generate summary
          console.log(`[MemorySync] Summarizing session ${session.id.slice(0, 8)}...`);
          const summary = await this.summarizer.summarize(session);
          summaries.push(summary);

          // Track sync
          synced++;
        } catch (error) {
          console.error(`[MemorySync] Error summarizing session ${sessionRecord.id}:`, error);
          errors++;
          this.errorCount++;
        }
      }

      // Flush all summaries to memory file
      if (summaries.length > 0) {
        await this.flushSummaries(summaries);
      }

      this.lastSyncTime = new Date();
      this.syncCount += synced;

      console.log(`[MemorySync] Sync complete: ${synced} synced, ${errors} errors`);
      this.logger.info('memory.sync', `Synced ${synced} sessions to memory`, { synced, errors });

      return { synced, errors };

    } catch (error) {
      console.error('[MemorySync] Sync cycle error:', error);
      this.errorCount++;
      throw error;
    }
  }

  /**
   * Flush summaries to memory file and track in database
   */
  private async flushSummaries(summaries: SessionSummary[]): Promise<void> {
    const db = getDB();
    const memoryManager = await getMemoryManager();

    // Format all summaries for memory file
    const content = this.summarizer.formatDailySummaries(summaries);

    // Flush to memory file
    const memoryFile = await memoryManager.flush(content);
    console.log(`[MemorySync] Flushed ${summaries.length} summaries to ${memoryFile}`);

    // Track each session as synced
    for (const summary of summaries) {
      db.markSessionSynced(
        summary.sessionId,
        summary.channel,
        memoryFile,
        summary.messageCount,
        summary.hash
      );
    }
  }

  /**
   * Force sync a specific session
   */
  async syncSession(sessionId: string): Promise<SessionSummary | null> {
    const db = getDB();
    const session = db.getSessionWithMessages(sessionId);

    if (!session || session.messages.length === 0) {
      console.log(`[MemorySync] Session ${sessionId} not found or empty`);
      return null;
    }

    try {
      console.log(`[MemorySync] Force syncing session ${sessionId.slice(0, 8)}...`);
      const summary = await this.summarizer.summarize(session);
      await this.flushSummaries([summary]);
      this.syncCount++;
      return summary;
    } catch (error) {
      console.error(`[MemorySync] Error syncing session ${sessionId}:`, error);
      this.errorCount++;
      throw error;
    }
  }

  /**
   * Get service statistics
   */
  getStats(): Record<string, unknown> {
    const db = getDB();
    const syncStats = db.getMemorySyncStats();

    return {
      running: this.running,
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
      minIdleMs: this.config.minIdleMs,
      channels: this.config.channels,
      lastSyncTime: this.lastSyncTime?.toISOString() || null,
      totalSynced: this.syncCount,
      totalErrors: this.errorCount,
      dbStats: syncStats,
    };
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// Global instance
let globalSyncService: MemorySyncService | null = null;

/**
 * Get or create the global memory sync service
 */
export function getMemorySyncService(config?: Partial<MemorySyncConfig>): MemorySyncService {
  if (!globalSyncService) {
    globalSyncService = new MemorySyncService(config);
  }
  return globalSyncService;
}

/**
 * Create a service definition for the gateway
 */
export function createMemorySyncService(config?: Partial<MemorySyncConfig>): ServiceDefinition {
  const service = new MemorySyncService(config);

  return {
    name: 'memory-sync',
    async start() {
      if (!service.isRunning()) {
        service.start();
      }
    },
    async stop() {
      service.stop();
      // Final sync on shutdown
      try {
        console.log('[MemorySync] Running final sync before shutdown...');
        await service.runSync();
      } catch (error) {
        console.error('[MemorySync] Final sync failed:', error);
      }
    },
    getStats() {
      return service.getStats();
    },
  };
}
