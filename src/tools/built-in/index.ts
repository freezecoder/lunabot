/**
 * Built-in tools index
 */

export { bashTool } from './bash.js';
export { readFileTool, writeFileTool, editFileTool, listFilesTool, fileTools } from './files.js';
export { webFetchTool, webSearchTool, webTools } from './web.js';
export { browserTool, browserTools } from './browser.js';
export { gogTools, gmailSearchTool, gmailGetTool, gmailSendTool, calendarListTool, calendarCreateTool, calendarFreebusyTool } from './gog.js';
export { apiTools, apiRequestTool, curlTool, jqTool, graphqlTool } from './api.js';
export { documentTools, readDocumentTool, fetchDocumentTool, summarizeInstructionsTool } from './documents.js';
export { memoryTools, memorySearchTool, memoryGetTool, memorySyncTool, memorySaveTool, memoryStatusTool } from './memory.js';
export { reminderTool, setReminderTelegramChatId } from './reminder.js';

import { bashTool } from './bash.js';
import { fileTools } from './files.js';
import { webTools } from './web.js';
import { browserTools } from './browser.js';
import { gogTools } from './gog.js';
import { apiTools } from './api.js';
import { documentTools } from './documents.js';
import { memoryTools } from './memory.js';
import { reminderTool } from './reminder.js';
import type { Tool } from '../../types.js';

/**
 * Get default tools (excludes memory - opt-in via LOCALBOT_ENABLE_MEMORY=true)
 */
export function getAllBuiltInTools(): Tool[] {
  const tools = [
    bashTool,
    ...fileTools,
    ...webTools,
    ...browserTools,
    ...gogTools,
    ...apiTools,
    ...documentTools,
    reminderTool,
  ];

  // Only include memory tools if explicitly enabled
  if (process.env.LOCALBOT_ENABLE_MEMORY === 'true') {
    tools.push(...memoryTools);
  }

  return tools;
}

/**
 * Get core tools (bash + files only)
 */
export function getCoreTools(): Tool[] {
  return [
    bashTool,
    ...fileTools,
  ];
}

/**
 * Get safe tools (read-only operations)
 */
export function getSafeTools(): Tool[] {
  return [
    fileTools[0], // read_file
    fileTools[3], // list_files
    ...webTools,
    ...documentTools,
  ];
}

/**
 * Get productivity tools (google + api + reminders)
 */
export function getProductivityTools(): Tool[] {
  return [
    ...gogTools,
    ...apiTools,
    ...documentTools,
    reminderTool,
  ];
}

/**
 * Get tools by category
 */
export function getToolsByCategory(categories: string[]): Tool[] {
  const tools: Tool[] = [];

  for (const cat of categories) {
    switch (cat.toLowerCase()) {
      case 'core':
      case 'bash':
        tools.push(bashTool);
        break;
      case 'files':
        tools.push(...fileTools);
        break;
      case 'web':
        tools.push(...webTools);
        break;
      case 'browser':
        tools.push(...browserTools);
        break;
      case 'google':
      case 'gog':
      case 'gmail':
      case 'calendar':
        tools.push(...gogTools);
        break;
      case 'api':
      case 'http':
        tools.push(...apiTools);
        break;
      case 'documents':
      case 'docs':
        tools.push(...documentTools);
        break;
      case 'memory':
        tools.push(...memoryTools);
        break;
      case 'reminder':
      case 'reminders':
      case 'cron':
        tools.push(reminderTool);
        break;
      case 'all':
        return getAllBuiltInTools();
    }
  }

  return tools;
}
