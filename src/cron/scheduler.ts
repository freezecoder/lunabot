/**
 * Cron Scheduler - runs due jobs and delivers reminders
 */

import { cronStore, CronStore } from './store.js';
import type { CronJob, DeliveryChannel } from './types.js';

/**
 * Delivery handler function type
 */
export type DeliveryHandler = (job: CronJob, channel: DeliveryChannel) => Promise<void>;

/**
 * Scheduler options
 */
export interface SchedulerOptions {
  /** Check interval in ms (default: 60000 = 1 minute) */
  checkIntervalMs?: number;
  /** Custom cron store (default: global cronStore) */
  store?: CronStore;
  /** Delivery handlers by channel kind */
  deliveryHandlers?: Partial<Record<DeliveryChannel['kind'], DeliveryHandler>>;
  /** Default handler when no specific handler */
  defaultHandler?: (job: CronJob) => Promise<void>;
  /** Called when a job runs (for logging) */
  onJobRun?: (job: CronJob, status: 'ok' | 'error', error?: string) => void;
}

/**
 * Cron Scheduler
 * Periodically checks for due jobs and executes them
 */
export class CronScheduler {
  private store: CronStore;
  private checkIntervalMs: number;
  private deliveryHandlers: Map<string, DeliveryHandler> = new Map();
  private defaultHandler?: (job: CronJob) => Promise<void>;
  private onJobRun?: (job: CronJob, status: 'ok' | 'error', error?: string) => void;
  private intervalId?: NodeJS.Timeout;
  private running = false;

  constructor(options: SchedulerOptions = {}) {
    this.store = options.store || cronStore;
    this.checkIntervalMs = options.checkIntervalMs || 60000;
    this.defaultHandler = options.defaultHandler;
    this.onJobRun = options.onJobRun;

    // Register delivery handlers
    if (options.deliveryHandlers) {
      for (const [kind, handler] of Object.entries(options.deliveryHandlers)) {
        if (handler) {
          this.deliveryHandlers.set(kind, handler);
        }
      }
    }
  }

  /**
   * Register a delivery handler
   */
  registerHandler(kind: DeliveryChannel['kind'], handler: DeliveryHandler): void {
    this.deliveryHandlers.set(kind, handler);
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[Cron] Scheduler started (check interval: ${this.checkIntervalMs}ms)`);

    // Run immediately, then on interval
    this.tick();
    this.intervalId = setInterval(() => this.tick(), this.checkIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    console.log('[Cron] Scheduler stopped');
  }

  /**
   * Check and run due jobs
   */
  private async tick(): Promise<void> {
    try {
      const dueJobs = await this.store.getDueJobs();

      for (const job of dueJobs) {
        await this.runJob(job);
      }
    } catch (error) {
      console.error('[Cron] Tick error:', error);
    }
  }

  /**
   * Run a single job
   */
  private async runJob(job: CronJob): Promise<void> {
    console.log(`[Cron] Running job: ${job.name} (${job.id})`);

    try {
      // Determine delivery channel
      const channel = job.delivery;

      if (channel) {
        const handler = this.deliveryHandlers.get(channel.kind);
        if (handler) {
          await handler(job, channel);
        } else {
          console.warn(`[Cron] No handler for channel: ${channel.kind}`);
          // Fall through to default handler
          if (this.defaultHandler) {
            await this.defaultHandler(job);
          }
        }
      } else if (this.defaultHandler) {
        await this.defaultHandler(job);
      } else {
        // Just log the reminder
        console.log(`[Reminder] ${job.name}: ${job.message}`);
      }

      await this.store.markRun(job.id, 'ok');
      this.onJobRun?.(job, 'ok');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Cron] Job failed: ${job.name}`, error);
      await this.store.markRun(job.id, 'error', errorMsg);
      this.onJobRun?.(job, 'error', errorMsg);
    }
  }

  /**
   * Manually trigger a job (for testing or force-run)
   */
  async triggerJob(jobId: string): Promise<boolean> {
    const job = await this.store.get(jobId);
    if (!job) return false;

    await this.runJob(job);
    return true;
  }

  /**
   * Get scheduler status
   */
  async getStatus(): Promise<{
    running: boolean;
    checkIntervalMs: number;
    totalJobs: number;
    enabledJobs: number;
    nextJobAt?: Date;
    handlers: string[];
  }> {
    const allJobs = await this.store.getAll(true);
    const enabledJobs = allJobs.filter((j) => j.enabled);

    // Find next scheduled job
    let nextJobAt: Date | undefined;
    for (const job of enabledJobs) {
      if (job.state.nextRunAtMs) {
        const next = new Date(job.state.nextRunAtMs);
        if (!nextJobAt || next < nextJobAt) {
          nextJobAt = next;
        }
      }
    }

    return {
      running: this.running,
      checkIntervalMs: this.checkIntervalMs,
      totalJobs: allJobs.length,
      enabledJobs: enabledJobs.length,
      nextJobAt,
      handlers: Array.from(this.deliveryHandlers.keys()),
    };
  }
}

/**
 * Create a default scheduler with console logging
 */
export function createDefaultScheduler(options?: SchedulerOptions): CronScheduler {
  return new CronScheduler({
    defaultHandler: async (job) => {
      console.log(`\n========== REMINDER ==========`);
      console.log(`Name: ${job.name}`);
      console.log(`Message: ${job.message}`);
      if (job.description) {
        console.log(`Description: ${job.description}`);
      }
      console.log(`==============================\n`);
    },
    onJobRun: (job, status, error) => {
      if (status === 'ok') {
        console.log(`[Cron] Job completed: ${job.name}`);
      } else {
        console.error(`[Cron] Job failed: ${job.name} - ${error}`);
      }
    },
    ...options,
  });
}

/**
 * Global scheduler instance (lazy-initialized)
 */
let globalScheduler: CronScheduler | null = null;

export function getGlobalScheduler(): CronScheduler {
  if (!globalScheduler) {
    globalScheduler = createDefaultScheduler();
  }
  return globalScheduler;
}

export function setGlobalScheduler(scheduler: CronScheduler): void {
  globalScheduler = scheduler;
}
