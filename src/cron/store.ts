/**
 * Cron job storage - persists reminders to disk
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getLocalbotHome } from '../config/paths.js';
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreData } from './types.js';

const STORE_VERSION = 1;

/**
 * Get cron store file path
 */
export function getCronStorePath(): string {
  return process.env.LOCALBOT_CRON_STORE || join(getLocalbotHome(), 'cron.json');
}

/**
 * Load cron jobs from disk
 */
export async function loadCronJobs(): Promise<CronJob[]> {
  const storePath = getCronStorePath();

  if (!existsSync(storePath)) {
    return [];
  }

  try {
    const content = await readFile(storePath, 'utf-8');
    const data: CronStoreData = JSON.parse(content);

    if (data.version !== STORE_VERSION) {
      console.warn(`Cron store version mismatch: ${data.version} vs ${STORE_VERSION}`);
    }

    return data.jobs || [];
  } catch (error) {
    console.error('Failed to load cron jobs:', error);
    return [];
  }
}

/**
 * Save cron jobs to disk
 */
export async function saveCronJobs(jobs: CronJob[]): Promise<void> {
  const storePath = getCronStorePath();

  // Ensure directory exists
  const dir = join(storePath, '..');
  await mkdir(dir, { recursive: true });

  const data: CronStoreData = {
    version: STORE_VERSION,
    jobs,
    lastUpdated: Date.now(),
  };

  await writeFile(storePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Cron job store with CRUD operations
 */
export class CronStore {
  private jobs: CronJob[] = [];
  private loaded = false;

  /**
   * Ensure jobs are loaded
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.jobs = await loadCronJobs();
      this.loaded = true;
    }
  }

  /**
   * Get all jobs
   */
  async getAll(includeDisabled = false): Promise<CronJob[]> {
    await this.ensureLoaded();
    return includeDisabled ? [...this.jobs] : this.jobs.filter((j) => j.enabled);
  }

  /**
   * Get a job by ID
   */
  async get(id: string): Promise<CronJob | undefined> {
    await this.ensureLoaded();
    return this.jobs.find((j) => j.id === id);
  }

  /**
   * Add a new job
   */
  async add(input: CronJobCreate): Promise<CronJob> {
    await this.ensureLoaded();

    const now = Date.now();
    const job: CronJob = {
      ...input,
      id: uuidv4(),
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        runCount: 0,
        ...input.state,
      },
    };

    // Calculate next run time
    job.state.nextRunAtMs = this.calculateNextRun(job);

    this.jobs.push(job);
    await saveCronJobs(this.jobs);

    return job;
  }

  /**
   * Update a job
   */
  async update(id: string, patch: CronJobPatch): Promise<CronJob | null> {
    await this.ensureLoaded();

    const index = this.jobs.findIndex((j) => j.id === id);
    if (index === -1) return null;

    const updated: CronJob = {
      ...this.jobs[index],
      ...patch,
      id, // Ensure ID doesn't change
      updatedAtMs: Date.now(),
    };

    // Recalculate next run if schedule changed
    if (patch.schedule) {
      updated.state.nextRunAtMs = this.calculateNextRun(updated);
    }

    this.jobs[index] = updated;
    await saveCronJobs(this.jobs);

    return updated;
  }

  /**
   * Remove a job
   */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.jobs.findIndex((j) => j.id === id);
    if (index === -1) return false;

    this.jobs.splice(index, 1);
    await saveCronJobs(this.jobs);

    return true;
  }

  /**
   * Get jobs due to run
   */
  async getDueJobs(): Promise<CronJob[]> {
    await this.ensureLoaded();

    const now = Date.now();
    return this.jobs.filter(
      (j) => j.enabled && j.state.nextRunAtMs && j.state.nextRunAtMs <= now
    );
  }

  /**
   * Mark job as run and update state
   */
  async markRun(id: string, status: 'ok' | 'error', error?: string): Promise<void> {
    await this.ensureLoaded();

    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;

    const now = Date.now();
    job.state.lastRunAtMs = now;
    job.state.lastStatus = status;
    job.state.lastError = error;
    job.state.runCount++;

    // Handle one-time reminders
    if (job.schedule.kind === 'at' && job.deleteAfterRun !== false) {
      await this.remove(id);
      return;
    }

    // Calculate next run for recurring jobs
    job.state.nextRunAtMs = this.calculateNextRun(job);
    job.updatedAtMs = now;

    await saveCronJobs(this.jobs);
  }

  /**
   * Calculate next run time for a job
   */
  private calculateNextRun(job: CronJob): number | undefined {
    const now = Date.now();
    const schedule = job.schedule;

    switch (schedule.kind) {
      case 'at':
        // One-time: return the scheduled time if in future
        return schedule.atMs > now ? schedule.atMs : undefined;

      case 'every': {
        // Interval: calculate next occurrence
        const anchor = schedule.anchorMs || job.createdAtMs;
        const interval = schedule.everyMs;
        const elapsed = now - anchor;
        const periods = Math.floor(elapsed / interval);
        return anchor + (periods + 1) * interval;
      }

      case 'cron': {
        // Cron expression: parse and calculate
        return this.nextCronTime(schedule.expr, now);
      }
    }
  }

  /**
   * Simple cron expression parser
   * Format: minute hour day-of-month month day-of-week
   */
  private nextCronTime(expr: string, after: number): number | undefined {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return undefined;

    const [minExpr, hourExpr, , ,] = parts;

    // Simple implementation: only supports specific numbers and *
    const minute = minExpr === '*' ? -1 : parseInt(minExpr, 10);
    const hour = hourExpr === '*' ? -1 : parseInt(hourExpr, 10);

    // Start from the next minute
    const start = new Date(after);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    // Search up to 366 days ahead
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const candidate = new Date(start.getTime() + i * 60 * 1000);

      const matchMinute = minute === -1 || candidate.getMinutes() === minute;
      const matchHour = hour === -1 || candidate.getHours() === hour;

      if (matchMinute && matchHour) {
        return candidate.getTime();
      }
    }

    return undefined;
  }

  /**
   * Reload from disk (for external changes)
   */
  async reload(): Promise<void> {
    this.jobs = await loadCronJobs();
    this.loaded = true;
  }
}

/**
 * Global cron store instance
 */
export const cronStore = new CronStore();
