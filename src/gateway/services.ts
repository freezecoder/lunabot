/**
 * Gateway Services Manager
 * Manages lifecycle of all LocalBot services (Telegram, Cron, etc.)
 */

import { Telegraf } from 'telegraf';
import type { ServiceInfo, ServiceStatus } from './types.js';
import { CronScheduler, cronStore, type DeliveryHandler } from '../cron/index.js';
import type { CronJob, DeliveryChannel } from '../cron/types.js';
import { logActivity } from '../utils/activity-tracker.js';

/**
 * Service definition
 */
export interface ServiceDefinition {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getStats?: () => Record<string, unknown>;
}

/**
 * Managed service with state
 */
interface ManagedService {
  definition: ServiceDefinition;
  status: ServiceStatus;
  error?: string;
  startedAt?: number;
}

/**
 * Services Manager - orchestrates all services
 */
export class ServicesManager {
  private services: Map<string, ManagedService> = new Map();
  private telegramBot: Telegraf | null = null;
  private cronScheduler: CronScheduler | null = null;

  /**
   * Register a service
   */
  register(definition: ServiceDefinition): void {
    this.services.set(definition.name, {
      definition,
      status: 'stopped',
    });
  }

  /**
   * Start a service by name
   */
  async start(name: string): Promise<boolean> {
    const service = this.services.get(name);
    if (!service) {
      console.error(`[Gateway] Service not found: ${name}`);
      return false;
    }

    if (service.status === 'running') {
      console.log(`[Gateway] Service already running: ${name}`);
      return true;
    }

    service.status = 'starting';
    console.log(`[Gateway] Starting service: ${name}`);

    try {
      await service.definition.start();
      service.status = 'running';
      service.startedAt = Date.now();
      service.error = undefined;
      console.log(`[Gateway] Service started: ${name}`);
      return true;
    } catch (error) {
      service.status = 'error';
      service.error = error instanceof Error ? error.message : String(error);
      console.error(`[Gateway] Failed to start service ${name}:`, error);
      return false;
    }
  }

  /**
   * Stop a service by name
   */
  async stop(name: string): Promise<boolean> {
    const service = this.services.get(name);
    if (!service) {
      console.error(`[Gateway] Service not found: ${name}`);
      return false;
    }

    if (service.status === 'stopped') {
      console.log(`[Gateway] Service already stopped: ${name}`);
      return true;
    }

    console.log(`[Gateway] Stopping service: ${name}`);

    try {
      await service.definition.stop();
      service.status = 'stopped';
      service.startedAt = undefined;
      console.log(`[Gateway] Service stopped: ${name}`);
      return true;
    } catch (error) {
      service.status = 'error';
      service.error = error instanceof Error ? error.message : String(error);
      console.error(`[Gateway] Failed to stop service ${name}:`, error);
      return false;
    }
  }

  /**
   * Restart a service
   */
  async restart(name: string): Promise<boolean> {
    await this.stop(name);
    return this.start(name);
  }

  /**
   * Start all registered services
   */
  async startAll(): Promise<void> {
    for (const name of this.services.keys()) {
      await this.start(name);
    }
  }

  /**
   * Stop all registered services
   */
  async stopAll(): Promise<void> {
    // Stop in reverse order
    const names = Array.from(this.services.keys()).reverse();
    for (const name of names) {
      await this.stop(name);
    }
  }

  /**
   * Get all service info
   */
  getAll(): ServiceInfo[] {
    return Array.from(this.services.entries()).map(([name, service]) => ({
      name,
      status: service.status,
      error: service.error,
      startedAt: service.startedAt,
      stats: service.definition.getStats?.(),
    }));
  }

  /**
   * Get a specific service info
   */
  get(name: string): ServiceInfo | undefined {
    const service = this.services.get(name);
    if (!service) return undefined;

    return {
      name,
      status: service.status,
      error: service.error,
      startedAt: service.startedAt,
      stats: service.definition.getStats?.(),
    };
  }

  /**
   * Get Telegram bot instance (for reminder delivery)
   */
  getTelegramBot(): Telegraf | null {
    return this.telegramBot;
  }

  /**
   * Set Telegram bot instance
   */
  setTelegramBot(bot: Telegraf): void {
    this.telegramBot = bot;
  }

  /**
   * Get cron scheduler instance
   */
  getCronScheduler(): CronScheduler | null {
    return this.cronScheduler;
  }

  /**
   * Set cron scheduler instance
   */
  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }
}

/**
 * Create Telegram delivery handler for reminders
 */
export function createTelegramDeliveryHandler(manager: ServicesManager): DeliveryHandler {
  return async (job: CronJob, channel: DeliveryChannel) => {
    if (channel.kind !== 'telegram') {
      throw new Error('Not a Telegram channel');
    }

    const bot = manager.getTelegramBot();
    if (!bot) {
      throw new Error('Telegram bot not available');
    }

    const chatId = channel.chatId;
    const message = `🔔 **Reminder: ${job.name}**\n\n${job.message}`;

    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    logActivity({
      source: 'cron',
      type: 'reminder',
      sessionId: `cron-${job.id}`,
      content: `Delivered reminder: ${job.name}`,
    });
  };
}

/**
 * Create the cron scheduler service
 */
export function createCronService(manager: ServicesManager): ServiceDefinition {
  let scheduler: CronScheduler | null = null;

  return {
    name: 'cron',
    async start() {
      scheduler = new CronScheduler({
        checkIntervalMs: 60000,
        deliveryHandlers: {
          telegram: createTelegramDeliveryHandler(manager),
        },
        defaultHandler: async (job) => {
          console.log(`[Reminder] ${job.name}: ${job.message}`);
        },
        onJobRun: (job, status, error) => {
          if (status === 'ok') {
            console.log(`[Cron] Reminder delivered: ${job.name}`);
          } else {
            console.error(`[Cron] Reminder failed: ${job.name} - ${error}`);
          }
        },
      });

      manager.setCronScheduler(scheduler);
      scheduler.start();
    },
    async stop() {
      if (scheduler) {
        scheduler.stop();
        scheduler = null;
      }
    },
    getStats() {
      return {
        running: scheduler !== null,
      };
    },
  };
}

/**
 * Global services manager instance
 */
export const servicesManager = new ServicesManager();
