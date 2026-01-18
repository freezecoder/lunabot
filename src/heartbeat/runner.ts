/**
 * Heartbeat Runner - Periodic background polling mechanism
 */

import { EventEmitter } from 'events';
import {
  HeartbeatConfig,
  DEFAULT_HEARTBEAT_CONFIG,
  HEARTBEAT_OK,
  loadHeartbeatConfig,
} from './config.js';

/**
 * Heartbeat result
 */
export interface HeartbeatResult {
  timestamp: Date;
  response: string;
  needsDelivery: boolean;
  triggeredBy: 'schedule' | 'manual' | 'request';
  error?: string;
}

/**
 * Heartbeat handler function type
 */
export type HeartbeatHandler = (prompt: string) => Promise<string>;

/**
 * Delivery function type
 */
export type DeliveryHandler = (result: HeartbeatResult) => Promise<void>;

/**
 * Heartbeat Runner class
 */
export class HeartbeatRunner extends EventEmitter {
  private config: HeartbeatConfig;
  private handler: HeartbeatHandler | null = null;
  private deliveryHandler: DeliveryHandler | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private startTimeoutId: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private lastResult: HeartbeatResult | null = null;
  private pendingRequest: { reason: string; resolve: (result: HeartbeatResult) => void } | null = null;

  constructor(config?: Partial<HeartbeatConfig>) {
    super();
    this.config = {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...loadHeartbeatConfig(),
      ...config,
    };
  }

  /**
   * Set the heartbeat handler (processes the prompt and returns response)
   */
  setHandler(handler: HeartbeatHandler): void {
    this.handler = handler;
  }

  /**
   * Set the delivery handler (called when response needs delivery)
   */
  setDeliveryHandler(handler: DeliveryHandler): void {
    this.deliveryHandler = handler;
  }

  /**
   * Start the heartbeat runner
   */
  start(): void {
    if (this.running || !this.config.enabled) {
      return;
    }

    if (!this.handler) {
      console.warn('Heartbeat: No handler set, cannot start');
      return;
    }

    this.running = true;
    this.emit('started');

    // Apply start delay if configured
    const startDelay = (this.config.startDelay || 0) * 60 * 1000;

    if (startDelay > 0) {
      this.startTimeoutId = setTimeout(() => {
        this.scheduleNext();
        this.runOnce('schedule').catch(console.error);
      }, startDelay);
    } else {
      this.scheduleNext();
    }
  }

  /**
   * Stop the heartbeat runner
   */
  stop(): void {
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.startTimeoutId) {
      clearTimeout(this.startTimeoutId);
      this.startTimeoutId = null;
    }

    this.emit('stopped');
  }

  /**
   * Run a single heartbeat
   */
  async runOnce(triggeredBy: HeartbeatResult['triggeredBy'] = 'manual'): Promise<HeartbeatResult> {
    if (!this.handler) {
      const result: HeartbeatResult = {
        timestamp: new Date(),
        response: '',
        needsDelivery: false,
        triggeredBy,
        error: 'No handler configured',
      };
      this.emit('error', result);
      return result;
    }

    try {
      this.emit('running', { triggeredBy });

      // Run the handler
      const response = await this.handler(this.config.prompt);

      // Check if delivery is needed
      const needsDelivery = this.checkNeedsDelivery(response);

      const result: HeartbeatResult = {
        timestamp: new Date(),
        response,
        needsDelivery,
        triggeredBy,
      };

      this.lastResult = result;
      this.emit('completed', result);

      // Deliver if needed
      if (needsDelivery && this.deliveryHandler) {
        try {
          await this.deliveryHandler(result);
          this.emit('delivered', result);
        } catch (error) {
          this.emit('deliveryError', { result, error });
        }
      }

      // Resolve any pending manual request
      if (this.pendingRequest) {
        this.pendingRequest.resolve(result);
        this.pendingRequest = null;
      }

      return result;

    } catch (error) {
      const result: HeartbeatResult = {
        timestamp: new Date(),
        response: '',
        needsDelivery: false,
        triggeredBy,
        error: error instanceof Error ? error.message : String(error),
      };

      this.lastResult = result;
      this.emit('error', result);

      if (this.pendingRequest) {
        this.pendingRequest.resolve(result);
        this.pendingRequest = null;
      }

      return result;
    }
  }

  /**
   * Request immediate heartbeat (e.g., from user command)
   */
  requestNow(reason: string = 'user request'): Promise<HeartbeatResult> {
    return new Promise((resolve) => {
      this.pendingRequest = { reason, resolve };
      this.runOnce('request').catch((error) => {
        resolve({
          timestamp: new Date(),
          response: '',
          needsDelivery: false,
          triggeredBy: 'request',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /**
   * Check if response needs delivery
   */
  private checkNeedsDelivery(response: string): boolean {
    const trimmed = response.trim();

    // Check for explicit OK response
    if (trimmed === HEARTBEAT_OK) {
      return false;
    }

    // Check if short response contains OK
    if (trimmed.length <= this.config.ackMaxChars && trimmed.includes(HEARTBEAT_OK)) {
      return false;
    }

    // Any other response needs delivery
    return true;
  }

  /**
   * Schedule next heartbeat
   */
  private scheduleNext(): void {
    if (!this.running) return;

    const intervalMs = this.config.every * 60 * 1000;

    this.intervalId = setInterval(() => {
      this.runOnce('schedule').catch(console.error);
    }, intervalMs);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HeartbeatConfig>): void {
    const wasRunning = this.running;

    if (wasRunning) {
      this.stop();
    }

    this.config = { ...this.config, ...config };

    if (wasRunning && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): HeartbeatConfig {
    return { ...this.config };
  }

  /**
   * Get last result
   */
  getLastResult(): HeartbeatResult | null {
    return this.lastResult;
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get status
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    intervalMinutes: number;
    lastRun?: Date;
    nextRun?: Date;
  } {
    return {
      running: this.running,
      enabled: this.config.enabled,
      intervalMinutes: this.config.every,
      lastRun: this.lastResult?.timestamp,
      nextRun: this.running
        ? new Date(Date.now() + this.config.every * 60 * 1000)
        : undefined,
    };
  }
}

// Global heartbeat runner instance
let globalHeartbeatRunner: HeartbeatRunner | null = null;

/**
 * Get or create global heartbeat runner
 */
export function getHeartbeatRunner(config?: Partial<HeartbeatConfig>): HeartbeatRunner {
  if (!globalHeartbeatRunner) {
    globalHeartbeatRunner = new HeartbeatRunner(config);
  }
  return globalHeartbeatRunner;
}

/**
 * Reset global heartbeat runner (for testing)
 */
export function resetHeartbeatRunner(): void {
  if (globalHeartbeatRunner) {
    globalHeartbeatRunner.stop();
    globalHeartbeatRunner = null;
  }
}
