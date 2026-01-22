/**
 * Reminder Tool - allows the agent to set and manage reminders
 */

import type { Tool } from '../../types.js';
import {
  cronStore,
  parseTimeExpression,
  formatSchedule,
  type CronJobCreate,
  type CronSchedule,
} from '../../cron/index.js';

/**
 * Current Telegram chat ID for delivery (set by bot)
 */
let currentTelegramChatId: number | null = null;

/**
 * Set the current Telegram chat ID for reminder delivery
 */
export function setReminderTelegramChatId(chatId: number | null): void {
  currentTelegramChatId = chatId;
}

/**
 * Reminder tool - set, list, and manage reminders
 */
export const reminderTool: Tool = {
  name: 'reminder',
  description: `Manage reminders and scheduled tasks. Actions:
- add: Create a new reminder (requires: message, when; optional: name)
- list: Show all reminders
- remove: Delete a reminder (requires: id)
- status: Show scheduler status

Time formats for "when":
- "in 5 minutes", "in 2 hours", "in 1 day"
- "at 9am", "at 3:30pm", "at 14:00"
- "tomorrow at 9am"
- "every day at 9am", "daily at 10:30am"
- "every 30 minutes", "every 2 hours"`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'remove', 'status'],
        description: 'The action to perform',
      },
      message: {
        type: 'string',
        description: 'The reminder message (for add action)',
      },
      when: {
        type: 'string',
        description: 'When to remind (e.g., "in 5 minutes", "at 9am", "every day at 9am")',
      },
      name: {
        type: 'string',
        description: 'Optional name for the reminder',
      },
      id: {
        type: 'string',
        description: 'Reminder ID (for remove action)',
      },
    },
    required: ['action'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    switch (action) {
      case 'add':
        return await addReminder(args);
      case 'list':
        return await listReminders();
      case 'remove':
        return await removeReminder(args);
      case 'status':
        return await getStatus();
      default:
        return `Unknown action: ${action}. Use add, list, remove, or status.`;
    }
  },
};

/**
 * Add a new reminder
 */
async function addReminder(args: Record<string, unknown>): Promise<string> {
  const message = args.message as string | undefined;
  const when = args.when as string | undefined;
  const name = args.name as string | undefined;

  if (!message) {
    return 'Error: message is required for add action';
  }

  if (!when) {
    return 'Error: when is required for add action (e.g., "in 5 minutes", "at 9am", "every day at 9am")';
  }

  // Parse the time expression
  const schedule = parseTimeExpression(when);
  if (!schedule) {
    return `Error: Could not parse time expression "${when}". Try formats like:
- "in 5 minutes", "in 2 hours"
- "at 9am", "at 3:30pm"
- "tomorrow at 9am"
- "every day at 9am"
- "every 30 minutes"`;
  }

  // Create the job
  const jobInput: CronJobCreate = {
    name: name || `Reminder: ${message.slice(0, 30)}${message.length > 30 ? '...' : ''}`,
    message,
    enabled: true,
    schedule,
    deleteAfterRun: schedule.kind === 'at', // One-time reminders auto-delete
  };

  // Set delivery channel if we have a Telegram chat ID
  if (currentTelegramChatId) {
    jobInput.delivery = {
      kind: 'telegram',
      chatId: currentTelegramChatId,
    };
  }

  try {
    const job = await cronStore.add(jobInput);

    const scheduleDesc = formatSchedule(schedule);
    let response = `Reminder set! (ID: ${job.id.slice(0, 8)})\n`;
    response += `Message: ${message}\n`;
    response += `Schedule: ${scheduleDesc}`;

    if (job.state.nextRunAtMs) {
      const nextRun = new Date(job.state.nextRunAtMs);
      response += `\nNext reminder: ${nextRun.toLocaleString()}`;
    }

    if (jobInput.delivery?.kind === 'telegram') {
      response += `\nDelivery: Telegram (chat ${currentTelegramChatId})`;
    }

    return response;
  } catch (error) {
    return `Error creating reminder: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * List all reminders
 */
async function listReminders(): Promise<string> {
  try {
    const jobs = await cronStore.getAll(true);

    if (jobs.length === 0) {
      return 'No reminders set.';
    }

    const lines: string[] = [`Found ${jobs.length} reminder(s):\n`];

    for (const job of jobs) {
      const status = job.enabled ? '✓' : '✗';
      const scheduleDesc = formatSchedule(job.schedule);
      const nextRun = job.state.nextRunAtMs
        ? new Date(job.state.nextRunAtMs).toLocaleString()
        : 'N/A';

      lines.push(`[${status}] ${job.name}`);
      lines.push(`    ID: ${job.id.slice(0, 8)}`);
      lines.push(`    Message: ${job.message.slice(0, 50)}${job.message.length > 50 ? '...' : ''}`);
      lines.push(`    Schedule: ${scheduleDesc}`);
      lines.push(`    Next run: ${nextRun}`);
      if (job.state.lastRunAtMs) {
        const lastRun = new Date(job.state.lastRunAtMs).toLocaleString();
        lines.push(`    Last run: ${lastRun} (${job.state.lastStatus})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  } catch (error) {
    return `Error listing reminders: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Remove a reminder
 */
async function removeReminder(args: Record<string, unknown>): Promise<string> {
  const id = args.id as string | undefined;

  if (!id) {
    return 'Error: id is required for remove action';
  }

  try {
    // Try to find by partial ID
    const jobs = await cronStore.getAll(true);
    const job = jobs.find((j) => j.id === id || j.id.startsWith(id));

    if (!job) {
      return `Reminder not found with ID: ${id}`;
    }

    const removed = await cronStore.remove(job.id);
    if (removed) {
      return `Reminder "${job.name}" removed successfully.`;
    } else {
      return `Failed to remove reminder with ID: ${id}`;
    }
  } catch (error) {
    return `Error removing reminder: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * Get scheduler status
 */
async function getStatus(): Promise<string> {
  try {
    const jobs = await cronStore.getAll(true);
    const enabledJobs = jobs.filter((j) => j.enabled);

    // Find next scheduled job
    let nextJob: { name: string; time: Date } | null = null;
    for (const job of enabledJobs) {
      if (job.state.nextRunAtMs) {
        const time = new Date(job.state.nextRunAtMs);
        if (!nextJob || time < nextJob.time) {
          nextJob = { name: job.name, time };
        }
      }
    }

    const lines = [
      'Reminder System Status',
      '─────────────────────',
      `Total reminders: ${jobs.length}`,
      `Enabled: ${enabledJobs.length}`,
      `Disabled: ${jobs.length - enabledJobs.length}`,
    ];

    if (nextJob) {
      lines.push(`Next reminder: ${nextJob.name}`);
      lines.push(`  at ${nextJob.time.toLocaleString()}`);
    }

    if (currentTelegramChatId) {
      lines.push(`Telegram delivery: chat ${currentTelegramChatId}`);
    }

    return lines.join('\n');
  } catch (error) {
    return `Error getting status: ${error instanceof Error ? error.message : error}`;
  }
}

export default reminderTool;
