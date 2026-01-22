/**
 * Cron/Reminder types for LocalBot
 * Simplified version inspired by clawdbot's cron system
 */

/**
 * Schedule types:
 * - at: One-time reminder at specific timestamp
 * - every: Recurring interval (e.g., every 30 minutes)
 * - cron: Standard cron expression (e.g., "0 9 * * *" for 9am daily)
 */
export type CronSchedule =
  | { kind: 'at'; atMs: number }                           // One-time at timestamp
  | { kind: 'every'; everyMs: number; anchorMs?: number }  // Recurring interval
  | { kind: 'cron'; expr: string; tz?: string };           // Cron expression

/**
 * Where to deliver the reminder
 */
export type DeliveryChannel =
  | { kind: 'telegram'; chatId: number }
  | { kind: 'terminal' }
  | { kind: 'webhook'; url: string };

/**
 * Reminder/cron job state
 */
export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  runCount: number;
}

/**
 * A scheduled reminder/cron job
 */
export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;  // For one-time reminders
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  message: string;           // The reminder message
  delivery?: DeliveryChannel;
  state: CronJobState;
}

/**
 * Storage format for cron jobs
 */
export interface CronStoreData {
  version: number;
  jobs: CronJob[];
  lastUpdated: number;
}

/**
 * Create job input (without auto-generated fields)
 */
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  state?: Partial<CronJobState>;
};

/**
 * Update job input
 */
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs'>>;

/**
 * Parse human-readable time expressions
 * Examples: "in 5 minutes", "at 9am", "every day at 9am", "tomorrow at 3pm"
 */
export function parseTimeExpression(expr: string): CronSchedule | null {
  const now = Date.now();
  const lower = expr.toLowerCase().trim();

  // "in X minutes/hours/days"
  const inMatch = lower.match(/^in\s+(\d+)\s+(minute|hour|day|week)s?$/);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    const multipliers: Record<string, number> = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
    };
    return { kind: 'at', atMs: now + amount * multipliers[unit] };
  }

  // "every X minutes/hours"
  const everyMatch = lower.match(/^every\s+(\d+)\s+(minute|hour|day)s?$/);
  if (everyMatch) {
    const amount = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2];
    const multipliers: Record<string, number> = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };
    return { kind: 'every', everyMs: amount * multipliers[unit], anchorMs: now };
  }

  // "every day at Xam/pm" or "daily at X"
  const dailyMatch = lower.match(/^(?:every\s+day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    const period = dailyMatch[3];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;

    return { kind: 'cron', expr: `${minute} ${hour} * * *` };
  }

  // "at Xam/pm" (one-time today or tomorrow)
  const atMatch = lower.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atMatch) {
    let hour = parseInt(atMatch[1], 10);
    const minute = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const period = atMatch[3];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;

    const target = new Date();
    target.setHours(hour, minute, 0, 0);

    // If the time has passed today, schedule for tomorrow
    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }

    return { kind: 'at', atMs: target.getTime() };
  }

  // "tomorrow at Xam/pm"
  const tomorrowMatch = lower.match(/^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tomorrowMatch) {
    let hour = parseInt(tomorrowMatch[1], 10);
    const minute = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const period = tomorrowMatch[3];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;

    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(hour, minute, 0, 0);

    return { kind: 'at', atMs: target.getTime() };
  }

  // Raw cron expression (5 fields)
  const cronMatch = lower.match(/^(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)$/);
  if (cronMatch) {
    return { kind: 'cron', expr: lower };
  }

  return null;
}

/**
 * Format schedule for display
 */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `once at ${new Date(schedule.atMs).toLocaleString()}`;
    case 'every': {
      const ms = schedule.everyMs;
      if (ms >= 24 * 60 * 60 * 1000) {
        return `every ${Math.round(ms / (24 * 60 * 60 * 1000))} day(s)`;
      }
      if (ms >= 60 * 60 * 1000) {
        return `every ${Math.round(ms / (60 * 60 * 1000))} hour(s)`;
      }
      return `every ${Math.round(ms / (60 * 1000))} minute(s)`;
    }
    case 'cron':
      return `cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
}
