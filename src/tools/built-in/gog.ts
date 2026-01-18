/**
 * Google CLI (gog) tools - Gmail, Calendar, Drive integration
 */

import { spawn } from 'child_process';
import { defineTool } from '../registry.js';

const GOG_PATH = '/opt/homebrew/bin/gog';

/**
 * Execute gog command and return JSON output
 */
async function execGog(args: string[], timeout = 30000): Promise<{ success: boolean; data?: unknown; error?: string; raw?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(GOG_PATH, [...args, '--json', '--no-input'], {
      timeout,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || `Exit code ${code}`, raw: stdout });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({ success: true, data, raw: stdout });
      } catch {
        // Not JSON, return raw
        resolve({ success: true, raw: stdout.trim() });
      }
    });

    proc.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
  });
}

/**
 * Format email for display
 */
function formatEmail(email: Record<string, unknown>): string {
  const from = email.from || email.From || 'Unknown';
  const subject = email.subject || email.Subject || '(no subject)';
  const date = email.date || email.Date || '';
  const snippet = email.snippet || '';
  const id = email.id || email.threadId || '';

  return `From: ${from}\nSubject: ${subject}\nDate: ${date}\nID: ${id}\n${snippet ? `Preview: ${snippet}` : ''}`;
}

/**
 * Format calendar event for display
 */
function formatEvent(event: Record<string, unknown>): string {
  const summary = event.summary || event.title || '(no title)';
  const start = event.start || {};
  const end = event.end || {};
  const startTime = (start as Record<string, string>).dateTime || (start as Record<string, string>).date || '';
  const endTime = (end as Record<string, string>).dateTime || (end as Record<string, string>).date || '';
  const location = event.location || '';
  const description = event.description || '';
  const id = event.id || '';

  let result = `📅 ${summary}\n   ${startTime}${endTime ? ` → ${endTime}` : ''}`;
  if (location) result += `\n   📍 ${location}`;
  if (description) result += `\n   ${String(description).slice(0, 100)}...`;
  result += `\n   ID: ${id}`;

  return result;
}

// ============ Gmail Tools ============

export const gmailSearchTool = defineTool({
  name: 'gmail_search',
  description: `Search Gmail using Gmail query syntax. Returns matching email threads.

Query examples:
- "is:unread" - unread emails
- "from:someone@example.com" - from specific sender
- "subject:meeting" - subject contains "meeting"
- "after:2024/01/01" - after date
- "has:attachment" - with attachments
- "in:inbox is:unread" - unread in inbox`,

  parameters: {
    query: {
      type: 'string',
      description: 'Gmail search query (e.g., "is:unread", "from:boss@company.com")',
      isRequired: true,
    },
    limit: {
      type: 'number',
      description: 'Maximum results to return (default: 10)',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const query = args.query as string;
    const limit = (args.limit as number) || 10;

    const result = await execGog(['gmail', 'search', query, '--max', String(limit)]);

    if (!result.success) {
      return `Error searching Gmail: ${result.error}`;
    }

    if (!result.data) {
      return result.raw || 'No results found.';
    }

    const threads = Array.isArray(result.data) ? result.data : [result.data];
    if (threads.length === 0) {
      return 'No emails found matching your query.';
    }

    let output = `Found ${threads.length} email(s):\n\n`;
    for (const thread of threads.slice(0, limit)) {
      output += formatEmail(thread as Record<string, unknown>) + '\n\n';
    }

    return output.trim();
  },
});

export const gmailGetTool = defineTool({
  name: 'gmail_get',
  description: 'Get full content of a specific email message by ID.',

  parameters: {
    message_id: {
      type: 'string',
      description: 'The message ID to retrieve',
      isRequired: true,
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const messageId = args.message_id as string;

    const result = await execGog(['gmail', 'get', messageId]);

    if (!result.success) {
      return `Error getting email: ${result.error}`;
    }

    if (result.data) {
      const email = result.data as Record<string, unknown>;
      let output = formatEmail(email);

      // Add body if available
      const body = email.body || email.text || email.html;
      if (body) {
        output += `\n\nBody:\n${String(body).slice(0, 5000)}`;
        if (String(body).length > 5000) output += '\n...[truncated]';
      }

      return output;
    }

    return result.raw || 'Email not found.';
  },
});

export const gmailSendTool = defineTool({
  name: 'gmail_send',
  description: 'Send an email via Gmail. ALWAYS confirm with user before sending.',

  parameters: {
    to: {
      type: 'string',
      description: 'Recipient email address',
      isRequired: true,
    },
    subject: {
      type: 'string',
      description: 'Email subject',
      isRequired: true,
    },
    body: {
      type: 'string',
      description: 'Email body text',
      isRequired: true,
    },
    cc: {
      type: 'string',
      description: 'CC recipients (comma-separated)',
    },
  },
  timeout: 30000,
  requiresConfirmation: true,

  async execute(args): Promise<string> {
    const to = args.to as string;
    const subject = args.subject as string;
    const body = args.body as string;
    const cc = args.cc as string | undefined;

    const gogArgs = ['gmail', 'send', '--to', to, '--subject', subject, '--body', body];
    if (cc) {
      gogArgs.push('--cc', cc);
    }

    const result = await execGog(gogArgs);

    if (!result.success) {
      return `Error sending email: ${result.error}`;
    }

    return `✅ Email sent to ${to}\nSubject: ${subject}`;
  },
});

// ============ Calendar Tools ============

export const calendarListTool = defineTool({
  name: 'calendar_events',
  description: `List upcoming calendar events. Can filter by date range and calendar.`,

  parameters: {
    days: {
      type: 'number',
      description: 'Number of days to look ahead (default: 7)',
    },
    calendar_id: {
      type: 'string',
      description: 'Specific calendar ID (default: primary)',
    },
    query: {
      type: 'string',
      description: 'Search query to filter events',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const days = (args.days as number) || 7;
    const calendarId = (args.calendar_id as string) || 'primary';
    const query = args.query as string | undefined;

    // Calculate date range
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const fromDate = now.toISOString().split('T')[0];
    const toDate = future.toISOString().split('T')[0];

    let gogArgs: string[];
    if (query) {
      gogArgs = ['calendar', 'search', query, '--from', fromDate, '--to', toDate];
    } else {
      gogArgs = ['calendar', 'events', calendarId, '--from', fromDate, '--to', toDate];
    }

    const result = await execGog(gogArgs);

    if (!result.success) {
      return `Error fetching calendar: ${result.error}`;
    }

    if (!result.data) {
      return result.raw || 'No events found.';
    }

    const events = Array.isArray(result.data) ? result.data : [result.data];
    if (events.length === 0) {
      return `No events in the next ${days} days.`;
    }

    let output = `📆 Events (next ${days} days):\n\n`;
    for (const event of events) {
      output += formatEvent(event as Record<string, unknown>) + '\n\n';
    }

    return output.trim();
  },
});

export const calendarCreateTool = defineTool({
  name: 'calendar_create',
  description: 'Create a new calendar event. ALWAYS confirm details with user first.',

  parameters: {
    title: {
      type: 'string',
      description: 'Event title/summary',
      isRequired: true,
    },
    start: {
      type: 'string',
      description: 'Start time (ISO 8601 or natural: "2024-01-15T10:00:00", "tomorrow 2pm")',
      isRequired: true,
    },
    end: {
      type: 'string',
      description: 'End time (ISO 8601 or natural)',
    },
    duration: {
      type: 'string',
      description: 'Duration if no end time (e.g., "1h", "30m")',
    },
    location: {
      type: 'string',
      description: 'Event location',
    },
    description: {
      type: 'string',
      description: 'Event description',
    },
    calendar_id: {
      type: 'string',
      description: 'Calendar ID (default: primary)',
    },
  },
  timeout: 30000,
  requiresConfirmation: true,

  async execute(args): Promise<string> {
    const title = args.title as string;
    const start = args.start as string;
    const end = args.end as string | undefined;
    const duration = args.duration as string | undefined;
    const location = args.location as string | undefined;
    const description = args.description as string | undefined;
    const calendarId = (args.calendar_id as string) || 'primary';

    const gogArgs = ['calendar', 'create', calendarId, '--title', title, '--start', start];

    if (end) gogArgs.push('--end', end);
    else if (duration) gogArgs.push('--duration', duration);
    if (location) gogArgs.push('--location', location);
    if (description) gogArgs.push('--description', description);

    const result = await execGog(gogArgs);

    if (!result.success) {
      return `Error creating event: ${result.error}`;
    }

    return `✅ Created event: ${title}\nStart: ${start}${location ? `\nLocation: ${location}` : ''}`;
  },
});

export const calendarFreebusyTool = defineTool({
  name: 'calendar_freebusy',
  description: 'Check free/busy status for a time range.',

  parameters: {
    from: {
      type: 'string',
      description: 'Start of range (ISO 8601 or date)',
      isRequired: true,
    },
    to: {
      type: 'string',
      description: 'End of range (ISO 8601 or date)',
      isRequired: true,
    },
    calendars: {
      type: 'string',
      description: 'Calendar IDs to check (comma-separated, default: primary)',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const from = args.from as string;
    const to = args.to as string;
    const calendars = (args.calendars as string) || 'primary';

    const result = await execGog(['calendar', 'freebusy', calendars, '--from', from, '--to', to]);

    if (!result.success) {
      return `Error checking availability: ${result.error}`;
    }

    return result.raw || JSON.stringify(result.data, null, 2);
  },
});

// ============ All gog tools ============

export const gogTools = [
  gmailSearchTool,
  gmailGetTool,
  gmailSendTool,
  calendarListTool,
  calendarCreateTool,
  calendarFreebusyTool,
];
