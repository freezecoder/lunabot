/**
 * Telegram Bot - Main bot entry point
 * Uses telegraf.js for Telegram Bot API
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Agent, StreamEvent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools, setReminderTelegramChatId } from '../tools/built-in/index.js';
import { loadSkillsFromDirectory } from '../tools/skill-loader.js';
import { loadSkillsFromDirectory as loadMdSkills } from '../skills/loader.js';
import { getImportedSkillsPath } from '../skills/claude-importer.js';
import { SessionManager } from './session/manager.js';
import { getTelegramTools, setTelegramContext } from './tools.js';
import {
  handleDocument,
  handlePhoto,
  handleVoice,
  handleAudio,
  handleVideo,
  formatAttachmentInfo,
  getTextFilePreview,
  type AttachmentInfo,
} from './attachments.js';
import { MODEL_CAPABILITIES } from '../router/router.js';
import { loadContext, buildSystemPrompt } from '../context/loader.js';
import { getSystemStats, getOllamaStats, formatBytes, formatUptime, getCompactStatus } from '../utils/system-monitor.js';
import { logActivity } from '../utils/activity-tracker.js';
import { CronScheduler, type DeliveryHandler } from '../cron/scheduler.js';
import type { CronJob, DeliveryChannel } from '../cron/types.js';
import type { SkillEntry } from '../skills/types.js';
import { getProjectManager, type ProjectManager, type ProjectSummary } from '../project/index.js';
import 'dotenv/config';

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const REASONING_MODEL = process.env.REASONING_MODEL || 'qwen2.5:32b';  // Smarter model for chat/planning
const TOOL_MODEL = process.env.TOOL_MODEL || DEFAULT_MODEL;            // Faster model for tool execution
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';

// These will be set by project manager
let CONTEXT_DIR = process.env.CONTEXT_DIR || '/Users/zayed/clawd';
let AGENT_DIR = process.env.AGENT_DIR || './agent';

// Project manager
let projectManager: ProjectManager;

// Initialize components
const provider = new OllamaProvider({ host: OLLAMA_HOST });
const registry = new ToolRegistry();
const sessions = new SessionManager({ defaultModel: DEFAULT_MODEL });

// Register built-in tools
registry.registerAll(getAllBuiltInTools());

// Register Telegram-specific tools (send files, images, etc.)
registry.registerAll(getTelegramTools());
console.log(`Registered ${getTelegramTools().length} Telegram-specific tools`);

// Agent will be initialized after async skill loading
let agent: Agent;

// Prompt skills for auto-injection
let promptSkills: SkillEntry[] = [];

// Cron scheduler for reminders
let cronScheduler: CronScheduler | null = null;

// Store Telegram API reference for reminder delivery
let telegramApi: Telegraf['telegram'] | null = null;

// Message update throttle (avoid rate limits)
const UPDATE_INTERVAL = 1000; // 1 second
const MIN_CONTENT_CHANGE = 50; // Minimum characters before update

/**
 * Escape markdown special characters for Telegram
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Format tool call for display
 */
function formatToolCall(name: string, args: Record<string, unknown>): string {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 50)}`)
    .join(', ');
  return `🔧 ${name}(${argsStr})`;
}

/**
 * Format content with tool visibility
 */
function formatMessage(content: string, toolInfo?: string): string {
  let result = content;
  if (toolInfo) {
    result = `${toolInfo}\n\n${content}`;
  }
  // Truncate if too long for Telegram (4096 limit)
  if (result.length > 4000) {
    result = result.slice(0, 3997) + '...';
  }
  return result;
}

/**
 * Keyword patterns for skill matching
 */
const SKILL_KEYWORDS: Record<string, string[]> = {
  'genomics-report': ['genomics report', 'pipeline report', 'job report', 'status report', 'generate report', 'summarize job', 'analyze job', 'daily report', 'failure report'],
  'genomics-jobs': ['tibanna', 'genomics', 'amplicon', 'wgs', 'basespace', 'sequencing', 'pipeline job', 'showjobs', 'show job', 'cromwell', 'ec2 job', 'aws job'],
  'gog': ['gmail', 'google calendar', 'google drive', 'calendar event', 'google sheets', 'google docs'],
  'slack-monitor': ['slack message', 'slack mention', 'check slack'],
  'openhands': ['openhands', 'coding agent', 'autonomous coding'],
};

/**
 * Direct command mappings for common skill queries
 * Maps user intent patterns to specific bash commands
 */
const SKILL_COMMANDS: Record<string, Array<{ patterns: string[]; command: string; description: string }>> = {
  'genomics-report': [
    { patterns: ['generate report', 'create report', 'make report', 'status report', 'daily report', 'pipeline report'],
      command: '/Users/zayed/clawd/scripts/genomics-report.sh',
      description: 'Generate a comprehensive genomics pipeline status report' },
    { patterns: ['failure report', 'failed report', 'what failed', 'analyze failure'],
      command: '/Users/zayed/clawd/scripts/genomics-report.sh "What jobs failed and what might have caused them?"',
      description: 'Generate a report focused on failures' },
    { patterns: ['quick report', 'fast report', 'job report'],
      command: '/Users/zayed/clawd/scripts/genomics-report.sh "job summary" --jobs-only',
      description: 'Quick jobs-only report' },
  ],
  'genomics-jobs': [
    // Basic job listing
    { patterns: ['show job', 'check job', 'job status', 'my job', 'tibanna status', 'tibanna job', 'what job', 'any job', 'jobs running', 'list job'],
      command: 'showjobs -short -n 20',
      description: 'Show recent Tibanna jobs (compact view)' },
    // Summary/counts
    { patterns: ['job summary', 'summary', 'job count', 'how many job', 'status count', 'status summary'],
      command: `showjobs -n 50 2>&1 | grep -E '^\\|[^-]' | awk -F'|' '{print $7}' | sed 's/ //g' | grep -v jstatus | sort | uniq -c`,
      description: 'Summary count of jobs by status' },
    // Failed jobs
    { patterns: ['failed job', 'job fail', 'what fail', 'error job', 'failure'],
      command: 'showjobs -n 30 -status failed -fields jobid,description,modified',
      description: 'Show recent failed jobs' },
    // Running jobs
    { patterns: ['running job', 'active job', 'in progress', 'currently running'],
      command: 'showjobs -status running -fields jobid,description,projectid,time',
      description: 'Show currently running jobs' },
    // Completed jobs
    { patterns: ['completed job', 'finished job', 'done job', 'successful job'],
      command: 'showjobs -n 30 -status completed -fields jobid,description,time',
      description: 'Show recently completed jobs' },
    // EC2 instances
    { patterns: ['show ec2', 'ec2 instance', 'running instance', 'instance status'],
      command: 'showec2',
      description: 'Show EC2 instances running genomics jobs' },
    // Logs
    { patterns: ['tibanna log', 'job log', 'workflow log', 'get log'],
      command: 'tibanna log -j <JOB_ID>',
      description: 'Get logs for a specific Tibanna job (need job ID)' },
    // BaseSpace
    { patterns: ['list project', 'basespace project', 'sequencing run', 'find project', 'bs project', 'illumina project'],
      command: `ssh -i /Users/zayed/hsnri/hsnri.pem ubuntu@18.233.64.31 'bash -l -c "bs list projects"'`,
      description: 'List BaseSpace projects (runs on remote server)' },
    // Tibanna stats
    { patterns: ['tibanna stat', 'stat -n', 'recent run'],
      command: 'tibanna stat -n 10',
      description: 'Show statistics for the 10 most recent Tibanna runs' },
    // Today's jobs
    { patterns: ['today job', 'job today', 'today summary', 'today status'],
      command: `showjobs -n 100 2>&1 | grep "$(date +%Y-%m-%d)" | awk -F'|' '{print $7}' | sed 's/ //g' | sort | uniq -c`,
      description: 'Summary of today\'s jobs by status' },
  ],
};

/**
 * Find a direct command match for a user query
 */
function findDirectCommand(message: string, skillName: string): { command: string; description: string } | null {
  const lower = message.toLowerCase();
  const commands = SKILL_COMMANDS[skillName];
  if (!commands) return null;

  for (const { patterns, command, description } of commands) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        return { command, description };
      }
    }
  }
  return null;
}

/**
 * Match a message to a skill based on keywords
 * Checks both hardcoded SKILL_KEYWORDS and skill metadata triggers
 * Returns highest priority skill that matches
 */
function matchSkillByKeywords(message: string, skills: SkillEntry[]): SkillEntry | null {
  const lower = message.toLowerCase();
  const matches: Array<{ skill: SkillEntry; priority: number }> = [];

  for (const skill of skills) {
    let matched = false;

    // Check hardcoded keywords first (for backward compatibility)
    const hardcodedKeywords = SKILL_KEYWORDS[skill.name] || [];
    for (const keyword of hardcodedKeywords) {
      if (lower.includes(keyword)) {
        matched = true;
        break;
      }
    }

    // Check skill metadata triggers (from YAML frontmatter)
    if (!matched) {
      const metadataTriggers = skill.metadata?.triggers || [];
      for (const trigger of metadataTriggers) {
        if (lower.includes(trigger.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      const priority = skill.metadata?.priority ?? 0;
      matches.push({ skill, priority });
    }
  }

  if (matches.length === 0) return null;

  // Sort by priority (highest first) and return the best match
  matches.sort((a, b) => b.priority - a.priority);
  console.log(`[Skill] Matched ${matches.length} skill(s), using: ${matches[0].skill.name} (priority: ${matches[0].priority})`);
  return matches[0].skill;
}

/**
 * Build skills section for system prompt (brief listing)
 */
function buildSkillsPromptSection(skills: SkillEntry[]): string {
  if (skills.length === 0) return '';

  const lines = [
    '\n\n## Available Skills',
    '',
  ];

  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description.slice(0, 100)}...`);
  }

  return lines.join('\n');
}

/**
 * Load today's and yesterday's memory files (clawdbot-style)
 */
function loadDailyMemory(): string {
  const memoryDir = join(CONTEXT_DIR, 'memory');
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  const todayFile = join(memoryDir, `${formatDate(today)}.md`);
  const yesterdayFile = join(memoryDir, `${formatDate(yesterday)}.md`);

  let memoryContent = '';

  // Load yesterday first if exists
  if (existsSync(yesterdayFile)) {
    try {
      const content = readFileSync(yesterdayFile, 'utf-8');
      memoryContent += `## Yesterday's Memory (${formatDate(yesterday)})\n\n${content}\n\n`;
    } catch {}
  }

  // Load today if exists
  if (existsSync(todayFile)) {
    try {
      const content = readFileSync(todayFile, 'utf-8');
      memoryContent += `## Today's Memory (${formatDate(today)})\n\n${content}\n\n`;
    } catch {}
  }

  return memoryContent;
}

/**
 * Create the bot
 */
async function createBot(): Promise<Telegraf> {
  // Initialize project manager for Telegram channel
  projectManager = getProjectManager('telegram');

  // Use project-aware paths
  CONTEXT_DIR = projectManager.getContextDir();
  AGENT_DIR = process.env.AGENT_DIR || './agent';

  console.log(`[Project] Context dir: ${CONTEXT_DIR}`);
  console.log(`[Project] Working dir: ${projectManager.getWorkingDir()}`);

  // Load YAML/JSON tool skills from multiple directories (including project skills)
  const skillsDirs = [SKILLS_DIR, ...projectManager.getSkillsDirs(), `${AGENT_DIR}/skills`];
  let totalToolSkills = 0;

  for (const skillsPath of skillsDirs) {
    try {
      const skills = await loadSkillsFromDirectory(skillsPath);
      if (skills.length > 0) {
        registry.registerAll(skills);
        totalToolSkills += skills.length;
        console.log(`Loaded ${skills.length} tool skills from ${skillsPath}`);
      }
    } catch {
      // Directory doesn't exist or no skills found
    }
  }

  // Load MD prompt skills (SKILL.md files with YAML frontmatter)
  const mdSkillsDirs = [`${CONTEXT_DIR}/skills`, `${AGENT_DIR}/skills`];
  const mdSkills: SkillEntry[] = [];

  for (const skillsPath of mdSkillsDirs) {
    try {
      const skills = await loadMdSkills(skillsPath, 'workspace');
      if (skills.length > 0) {
        mdSkills.push(...skills);
        console.log(`Loaded ${skills.length} prompt skills from ${skillsPath}`);
      }
    } catch {
      // Directory doesn't exist or no skills found
    }
  }

  // Load imported Claude skills (from ~/.localbot/skills/claude-imported/)
  const importedSkillsDir = getImportedSkillsPath();
  try {
    const importedSkills = await loadMdSkills(importedSkillsDir, 'claude');
    if (importedSkills.length > 0) {
      mdSkills.push(...importedSkills);
      console.log(`Loaded ${importedSkills.length} imported Claude skills from ${importedSkillsDir}`);
    }
  } catch {
    // Imported skills dir may not exist yet - run /import-claude in terminal to import
  }

  console.log(`Total skills: ${totalToolSkills} tools, ${mdSkills.length} prompts`);

  // Store for message-level skill injection
  promptSkills = mdSkills;

  // Load context (SOUL, IDENTITY, USER, etc.)
  const context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  let systemPrompt = buildSystemPrompt(context, registry.getSummary());

  // Append skill descriptions to system prompt
  if (mdSkills.length > 0) {
    const skillsSection = buildSkillsPromptSection(mdSkills);
    systemPrompt += skillsSection;
  }

  // Load daily memory (clawdbot-style: today + yesterday)
  const memoryContent = loadDailyMemory();
  if (memoryContent) {
    systemPrompt += `\n\n## Recent Memory\n\n${memoryContent}`;
    console.log(`Loaded daily memory from ${CONTEXT_DIR}/memory`);
  }

  console.log(`Loaded context from ${context.sources.length} source(s): ${context.sources.join(', ')}`);

  // Initialize agent with context-aware system prompt
  agent = new Agent({
    provider,
    registry,
    systemPrompt,
    defaultModel: REASONING_MODEL,
    routerConfig: {
      reasoningModel: REASONING_MODEL,   // qwen2.5:32b - for understanding, planning, reading skills
      toolCallingModel: TOOL_MODEL,       // llama3.1:8b - for fast tool execution
    },
  });

  console.log(`Hybrid router: reasoning=${REASONING_MODEL}, tools=${TOOL_MODEL}`);

  const bot = new Telegraf(BOT_TOKEN);

  // Error handling
  bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('An error occurred. Please try again.').catch(() => {});
  });

  // /start command
  bot.command('start', async (ctx) => {
    const username = ctx.from?.username || ctx.from?.first_name || 'there';
    await ctx.reply(
      `👋 Hello ${username}!\n\n` +
      `I'm LocalBot, an AI assistant powered by local LLMs.\n\n` +
      `Commands:\n` +
      `/model - Switch model\n` +
      `/models - List available models\n` +
      `/tools - Show available tools\n` +
      `/skills - Show available skills\n` +
      `/projects - List projects\n` +
      `/project - Switch project\n` +
      `/clear - Clear conversation\n` +
      `/status - Show current status\n` +
      `/help - Show this help\n\n` +
      `Just send me a message to start chatting!`
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    const activeProject = projectManager.getActiveProject();
    const projectInfo = activeProject
      ? `Project: \`${activeProject.config.displayName || activeProject.config.name}\``
      : `_Using global context_`;

    await ctx.reply(
      `🤖 *LocalBot Help*\n\n` +
      `*Commands:*\n` +
      `/start - Welcome message\n` +
      `/model - Switch model (shows menu)\n` +
      `/models - List all available models\n` +
      `/tools - Show available tools\n` +
      `/skills - Show available skills (Claude + project)\n` +
      `/projects - List available projects\n` +
      `/project <name> - Switch to a project\n` +
      `/pwd - Show working directory\n` +
      `/clear - Clear conversation history\n` +
      `/status - Show bot status\n` +
      `/settings - Configure preferences\n\n` +
      `*Usage:*\n` +
      `Just send any message and I'll respond. ` +
      `I can use tools to help with tasks like:\n` +
      `- Running commands\n` +
      `- Reading/writing files\n` +
      `- Searching the web\n` +
      `- Browser automation\n\n` +
      `Current model: \`${sessions.getModel(ctx.chat.id)}\`\n` +
      `${projectInfo}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /model command - show model selection
  bot.command('model', async (ctx) => {
    const currentModel = sessions.getModel(ctx.chat.id);
    const buttons = Object.entries(MODEL_CAPABILITIES)
      .filter(([_, info]) => info.supportsTools)
      .slice(0, 8) // Limit to 8 models
      .map(([model, info]) => {
        const isCurrent = model === currentModel ? ' ✓' : '';
        return Markup.button.callback(
          `${model.split(':')[0]}${isCurrent}`,
          `model:${model}`
        );
      });

    await ctx.reply(
      `Current model: \`${currentModel}\`\n\nSelect a model:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons, { columns: 2 }),
      }
    );
  });

  // Handle model selection callback
  bot.action(/^model:(.+)$/, async (ctx) => {
    const model = ctx.match[1];
    sessions.setModel(ctx.chat!.id, model);
    await ctx.answerCbQuery(`Switched to ${model}`);
    await ctx.editMessageText(`Model switched to: \`${model}\``, { parse_mode: 'Markdown' });
  });

  // /models command - list all models
  bot.command('models', async (ctx) => {
    try {
      const models = await provider.listModels();
      const currentModel = sessions.getModel(ctx.chat.id);

      let text = `📋 *Available Models*\n\nCurrent: \`${currentModel}\`\n\n`;

      for (const model of models.slice(0, 20)) {
        const info = MODEL_CAPABILITIES[model];
        const toolsIcon = info?.supportsTools ? '🔧' : '';
        text += `• \`${model}\` ${toolsIcon}\n`;
      }

      if (models.length > 20) {
        text += `\n_...and ${models.length - 20} more_`;
      }

      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply('Failed to list models. Is Ollama running?');
    }
  });

  // /tools command
  bot.command('tools', async (ctx) => {
    const tools = registry.getAll();
    const telegramTools = tools.filter(t => t.name.startsWith('telegram_'));
    const otherTools = tools.filter(t => !t.name.startsWith('telegram_'));

    let text = `🔧 *Available Tools* (${tools.length})\n\n`;

    text += `*Telegram Tools:*\n`;
    for (const tool of telegramTools) {
      text += `• *${tool.name.replace('telegram_', '')}*: ${tool.description.slice(0, 50)}...\n`;
    }

    text += `\n*General Tools:*\n`;
    for (const tool of otherTools.slice(0, 15)) {
      text += `• *${tool.name}*: ${tool.description.slice(0, 50)}...\n`;
    }

    if (otherTools.length > 15) {
      text += `\n_...and ${otherTools.length - 15} more_`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /skills command
  bot.command('skills', async (ctx) => {
    if (promptSkills.length === 0) {
      await ctx.reply('📚 No skills loaded.');
      return;
    }

    // Group skills by source
    const projectSkills = promptSkills.filter(s => s.source === 'workspace');
    const claudeSkills = promptSkills.filter(s => s.source === 'claude');
    const otherSkills = promptSkills.filter(s => s.source !== 'workspace' && s.source !== 'claude');

    let text = `📚 *Available Skills* (${promptSkills.length})\n\n`;

    if (claudeSkills.length > 0) {
      text += `*Claude Skills:*\n`;
      for (const skill of claudeSkills) {
        const priority = skill.metadata?.priority ? ` ⚡${skill.metadata.priority}` : '';
        const triggers = skill.metadata?.triggers?.slice(0, 3).join(', ') || '';
        text += `• *${skill.name}*${priority}\n  ${skill.description.slice(0, 60)}...\n  _Triggers: ${triggers}_\n`;
      }
      text += '\n';
    }

    if (projectSkills.length > 0) {
      text += `*Project Skills:*\n`;
      for (const skill of projectSkills) {
        const priority = skill.metadata?.priority ? ` ⚡${skill.metadata.priority}` : '';
        text += `• *${skill.name}*${priority}: ${skill.description.slice(0, 50)}...\n`;
      }
      text += '\n';
    }

    if (otherSkills.length > 0) {
      text += `*Other Skills:*\n`;
      for (const skill of otherSkills) {
        text += `• *${skill.name}*: ${skill.description.slice(0, 50)}...\n`;
      }
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /clear command
  bot.command('clear', async (ctx) => {
    sessions.clear(ctx.chat.id);
    await ctx.reply('🗑️ Conversation cleared.');
  });

  // /status command
  bot.command('status', async (ctx) => {
    const session = sessions.get(ctx.chat.id);
    const sessionStats = sessions.getStats();
    const toolStats = agent.getStats();
    const sysStats = getSystemStats();
    const ollamaStats = await getOllamaStats(OLLAMA_HOST);

    const memPct = sysStats.memoryPercent.toFixed(0);
    const load = sysStats.cpuLoad[0].toFixed(2);

    let ollamaStatus = ollamaStats.running ? '✅ Running' : '❌ Not responding';
    if (ollamaStats.activeModel) {
      ollamaStatus += `\nActive: \`${ollamaStats.activeModel}\``;
    }
    if (ollamaStats.vram) {
      ollamaStatus += `\nVRAM: ${formatBytes(ollamaStats.vram)}`;
    }

    await ctx.reply(
      `📊 *System Status*\n\n` +
      `*System:*\n` +
      `Memory: ${formatBytes(sysStats.memoryUsed)} / ${formatBytes(sysStats.memoryTotal)} (${memPct}%)\n` +
      `CPU Load: ${load} (${sysStats.cpuCount} cores)\n` +
      `Uptime: ${formatUptime(sysStats.uptime)}\n\n` +
      `*Ollama:*\n` +
      `${ollamaStatus}\n` +
      `Host: \`${OLLAMA_HOST}\`\n\n` +
      `*Your Session:*\n` +
      `Model: \`${session.model}\`\n` +
      `Messages: ${session.messages.length}\n\n` +
      `*Bot Stats:*\n` +
      `Sessions: ${sessionStats.totalSessions}\n` +
      `Total messages: ${sessionStats.totalMessages}\n` +
      `Tool calls: ${toolStats.total} (${((toolStats.successful / (toolStats.total || 1)) * 100).toFixed(0)}% success)\n` +
      `Process mem: ${formatBytes(sysStats.processMemory)}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /settings command
  bot.command('settings', async (ctx) => {
    const prefs = sessions.getPreferences(ctx.chat.id);

    const buttons = [
      Markup.button.callback(
        `Tool visibility: ${prefs.showToolCalls ? '✅' : '❌'}`,
        'toggle:showToolCalls'
      ),
      Markup.button.callback(
        `Streaming: ${prefs.streamingEnabled ? '✅' : '❌'}`,
        'toggle:streamingEnabled'
      ),
    ];

    await ctx.reply('⚙️ *Settings*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons, { columns: 1 }),
    });
  });

  // Handle settings toggles
  bot.action(/^toggle:(.+)$/, async (ctx) => {
    const setting = ctx.match[1] as keyof typeof sessions.getPreferences;
    const prefs = sessions.getPreferences(ctx.chat!.id);
    const newValue = !prefs[setting as keyof typeof prefs];

    sessions.setPreferences(ctx.chat!.id, { [setting]: newValue });
    await ctx.answerCbQuery(`${setting} ${newValue ? 'enabled' : 'disabled'}`);

    // Update the settings message
    const updatedPrefs = sessions.getPreferences(ctx.chat!.id);
    const buttons = [
      Markup.button.callback(
        `Tool visibility: ${updatedPrefs.showToolCalls ? '✅' : '❌'}`,
        'toggle:showToolCalls'
      ),
      Markup.button.callback(
        `Streaming: ${updatedPrefs.streamingEnabled ? '✅' : '❌'}`,
        'toggle:streamingEnabled'
      ),
    ];

    await ctx.editMessageText('⚙️ *Settings*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons, { columns: 1 }),
    });
  });

  // /projects command - list available projects
  bot.command('projects', async (ctx) => {
    try {
      const projects = await projectManager.listProjects();

      if (projects.length === 0) {
        await ctx.reply(
          `📁 *No Projects Found*\n\n` +
          `Projects directory: \`${projectManager.getProjectsRoot()}\`\n\n` +
          `Create projects by adding directories with \`project.json\` files.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let text = `📁 *Available Projects*\n\n`;
      for (const p of projects) {
        const status = p.isActive ? ' ✅' : '';
        const desc = p.description ? ` - ${p.description.slice(0, 40)}` : '';
        text += `• \`${p.name}\`${status}${desc}\n`;
      }

      text += `\nUse /project <name> to switch projects.`;

      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`❌ Error listing projects: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // /project command - switch to a project
  bot.command('project', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

    if (!args) {
      // Show current project info
      const active = projectManager.getActiveProject();
      if (active) {
        await ctx.reply(
          `📂 *Current Project*\n\n` +
          `Name: \`${active.config.displayName || active.config.name}\`\n` +
          `Path: \`${active.rootPath}\`\n` +
          `Working dir: \`${active.workingDirPath}\`\n` +
          (active.config.description ? `\n${active.config.description}` : ''),
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          `📂 *No Active Project*\n\n` +
          `Using global context: \`${projectManager.getGlobalContextDir()}\`\n\n` +
          `Use /projects to list available projects.`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // Handle 'clear' to return to global context
    if (args === 'clear' || args === 'none') {
      projectManager.clearActiveProject();
      await ctx.reply('🔄 Cleared project. Using global context.');
      return;
    }

    try {
      const project = await projectManager.setActiveProject(args);

      // Update context directories
      CONTEXT_DIR = projectManager.getContextDir();

      await ctx.reply(
        `✅ Switched to project: *${project.config.displayName || project.config.name}*\n\n` +
        `Working dir: \`${project.workingDirPath}\`\n` +
        (project.config.description ? `\n${project.config.description}` : ''),
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      await ctx.reply(`❌ Failed to switch project: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // /pwd command - show current working directory
  bot.command('pwd', async (ctx) => {
    const workingDir = projectManager.getWorkingDir();
    const contextDir = projectManager.getContextDir();
    const active = projectManager.getActiveProject();

    let text = `📍 *Working Directory*\n\n`;
    text += `Working: \`${workingDir}\`\n`;
    text += `Context: \`${contextDir}\`\n`;

    if (active) {
      text += `\nProject: *${active.config.displayName || active.config.name}*`;
    } else {
      text += `\n_Using global context_`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // Handle text messages
  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    let userMessage = ctx.message.text;
    const session = sessions.get(chatId, ctx.from?.username);
    const prefs = sessions.getPreferences(chatId);

    // Set Telegram context for tools (allows sending files, images, etc.)
    setTelegramContext(ctx, chatId);

    // Set chat ID for reminder delivery
    setReminderTelegramChatId(chatId);

    // Auto-inject skill content if keywords match
    const matchedSkill = matchSkillByKeywords(userMessage, promptSkills);
    let directCommand: { command: string; description: string } | null = null;

    if (matchedSkill) {
      // First, check for a direct command match (more targeted)
      directCommand = findDirectCommand(userMessage, matchedSkill.name);

      if (directCommand) {
        // Direct command match - give model a simple, direct instruction
        userMessage = `EXECUTE THIS COMMAND NOW using the bash tool:

\`\`\`bash
${directCommand.command}
\`\`\`

Purpose: ${directCommand.description}

Original request: ${userMessage}

INSTRUCTION: Call the bash tool with exactly this command. Show the real output. Do not explain - just run it.`;
        console.log(`[Skill] Direct command match: ${directCommand.command}`);
      } else {
        // No direct match - inject full skill for complex queries
        try {
          const skillContent = readFileSync(matchedSkill.path, 'utf-8');
          userMessage = `## SKILL INSTRUCTIONS (${matchedSkill.name})
${skillContent}

## YOUR TASK
${userMessage}

IMPORTANT: Use the bash tool to EXECUTE the commands from the skill above. Do NOT just explain or show code - actually RUN the commands and show the real output.`;
          console.log(`[Skill] Auto-injected full skill: ${matchedSkill.name}`);
        } catch (e) {
          console.error(`[Skill] Failed to load ${matchedSkill.path}:`, e);
        }
      }
    }

    // Send typing indicator
    await ctx.sendChatAction('typing');

    // Send initial "thinking" message
    let thinkingText = '💭 Thinking...';
    if (directCommand) {
      thinkingText = `⚡ Running: \`${directCommand.command.slice(0, 50)}...\``;
    } else if (matchedSkill) {
      thinkingText = `🔧 Using skill: ${matchedSkill.name}...`;
    }
    const thinkingMsg = await ctx.reply(thinkingText, { parse_mode: 'Markdown' });
    let lastContent = '';
    let lastUpdate = Date.now();
    let toolInfo = '';

    try {
      // Stream the response
      for await (const event of agent.runStream(userMessage, session.id, session.userId)) {
        switch (event.type) {
          case 'content':
            if (event.content) {
              lastContent += event.content;

              // Throttle updates
              const now = Date.now();
              const contentChanged = lastContent.length - (lastContent.length - (event.content?.length || 0));

              if (now - lastUpdate > UPDATE_INTERVAL || contentChanged > MIN_CONTENT_CHANGE) {
                try {
                  const displayContent = formatMessage(lastContent, prefs.showToolCalls ? toolInfo : undefined);
                  await ctx.telegram.editMessageText(
                    chatId,
                    thinkingMsg.message_id,
                    undefined,
                    displayContent || '...'
                  );
                  lastUpdate = now;
                } catch (e) {
                  // Ignore edit errors (message not modified, etc.)
                }
              }
            }
            break;

          case 'tool_start':
            if (event.toolCall && prefs.showToolCalls) {
              const args = JSON.parse(event.toolCall.function.arguments || '{}');
              const toolDisplay = formatToolCall(event.toolCall.function.name, args);
              toolInfo += (toolInfo ? '\n' : '') + toolDisplay;

              try {
                await ctx.telegram.editMessageText(
                  chatId,
                  thinkingMsg.message_id,
                  undefined,
                  formatMessage(lastContent || 'Processing...', toolInfo)
                );
              } catch (e) {
                // Ignore edit errors
              }
            }
            // Send typing while tool executes
            await ctx.sendChatAction('typing');
            break;

          case 'tool_end':
            if (event.toolCall && prefs.showToolCalls) {
              // Update tool info with result indicator
              const resultPreview = event.toolResult?.slice(0, 50) || 'done';
              toolInfo = toolInfo.replace(
                new RegExp(`🔧 ${event.toolCall.function.name}\\([^)]*\\)$`, 'm'),
                `✅ ${event.toolCall.function.name}: ${resultPreview}...`
              );
            }
            break;

          case 'error':
            lastContent = `❌ Error: ${event.error}`;
            break;

          case 'done':
            break;
        }
      }

      // Final update
      const finalContent = formatMessage(lastContent || 'I processed your request.', prefs.showToolCalls ? toolInfo : undefined);
      try {
        await ctx.telegram.editMessageText(
          chatId,
          thinkingMsg.message_id,
          undefined,
          finalContent
        );
      } catch (e) {
        // Ignore "message not modified" error - happens when content hasn't changed
        if (!(e instanceof Error && e.message.includes('message is not modified'))) {
          throw e;
        }
      }

      // Add messages to session
      sessions.addMessage(chatId, { role: 'user', content: userMessage });
      sessions.addMessage(chatId, { role: 'assistant', content: lastContent });
      sessions.setLastMessageId(chatId, thinkingMsg.message_id);

      // Log activity for dashboard
      logActivity({
        source: 'telegram',
        type: 'message',
        sessionId: session.id,
        userId: ctx.from?.username || String(chatId),
        content: ctx.message.text.slice(0, 100),
      });

      if (toolInfo) {
        logActivity({
          source: 'telegram',
          type: 'tool_call',
          sessionId: session.id,
          content: toolInfo.slice(0, 100),
        });
      }

    } catch (error) {
      console.error('Message handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        thinkingMsg.message_id,
        undefined,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
    // Note: Don't clear context here - tool calls may still be pending
    // Context will be overwritten by next message anyway
  });

  // Handle document uploads
  bot.on(message('document'), async (ctx) => {
    const chatId = ctx.chat.id;
    const document = ctx.message.document;
    const caption = ctx.message.caption;

    console.log(`[Telegram] Document received: ${document.file_name} from chat ${chatId}`);

    // Send processing indicator
    const processingMsg = await ctx.reply('📄 Downloading file...');

    try {
      const result = await handleDocument(ctx, document, caption);

      if (!result.success || !result.attachment) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          `❌ Failed to download file: ${result.error}`
        );
        return;
      }

      const info = result.attachment;
      const infoText = formatAttachmentInfo(info);

      // Check if it's a text file we can preview
      const textPreview = await getTextFilePreview(info.localPath);

      // Set Telegram context for tools
      setTelegramContext(ctx, chatId);
      setReminderTelegramChatId(chatId);

      const session = sessions.get(chatId, ctx.from?.username);

      // Build context message for the agent
      let contextMessage = `User uploaded a file:\n${infoText}\nSaved to: ${info.localPath}`;
      if (caption) {
        contextMessage += `\nCaption: ${caption}`;
      }
      if (textPreview) {
        contextMessage += `\n\nFile preview:\n\`\`\`\n${textPreview}\n\`\`\``;
      }

      // Update status
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `✅ File saved: ${info.fileName}\n${infoText}`
      );

      // Process with agent if there's a caption (user wants something done)
      if (caption) {
        const thinkingMsg = await ctx.reply('💭 Processing your request...');
        let lastContent = '';

        try {
          for await (const event of agent.runStream(contextMessage, session.id, session.userId)) {
            if (event.type === 'content' && event.content) {
              lastContent += event.content;
            }
          }

          await ctx.telegram.editMessageText(
            chatId,
            thinkingMsg.message_id,
            undefined,
            lastContent || 'File processed.'
          );

          sessions.addMessage(chatId, { role: 'user', content: contextMessage });
          sessions.addMessage(chatId, { role: 'assistant', content: lastContent });
        } catch (error) {
          await ctx.telegram.editMessageText(
            chatId,
            thinkingMsg.message_id,
            undefined,
            `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      } else {
        // Just acknowledge the file
        await ctx.reply(
          `📄 File received and saved.\n` +
          `You can ask me to read, analyze, or work with this file.\n` +
          `Path: \`${info.localPath}\``,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      console.error('[Telegram] Document handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `❌ Error processing file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Handle photos
  bot.on(message('photo'), async (ctx) => {
    const chatId = ctx.chat.id;
    const photos = ctx.message.photo;
    const caption = ctx.message.caption;

    console.log(`[Telegram] Photo received from chat ${chatId}`);

    const processingMsg = await ctx.reply('🖼️ Downloading photo...');

    try {
      const result = await handlePhoto(ctx, photos, caption);

      if (!result.success || !result.attachment) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          `❌ Failed to download photo: ${result.error}`
        );
        return;
      }

      const info = result.attachment;
      const infoText = formatAttachmentInfo(info);

      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `✅ Photo saved\n${infoText}`
      );

      // Note: Vision/image analysis would require a multimodal model
      await ctx.reply(
        `🖼️ Photo received and saved.\n` +
        `Path: \`${info.localPath}\`\n\n` +
        `_Note: Image analysis requires a vision-capable model. ` +
        `For now, please describe what's in the image if you need help with it._`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('[Telegram] Photo handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `❌ Error processing photo: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Handle voice messages
  bot.on(message('voice'), async (ctx) => {
    const chatId = ctx.chat.id;
    const voice = ctx.message.voice;

    console.log(`[Telegram] Voice message received from chat ${chatId} (${voice.duration}s)`);

    const processingMsg = await ctx.reply('🎤 Downloading voice message...');

    try {
      const result = await handleVoice(ctx, voice);

      if (!result.success || !result.attachment) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          `❌ Failed to download voice: ${result.error}`
        );
        return;
      }

      const info = result.attachment;
      const infoText = formatAttachmentInfo(info);

      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `✅ Voice message saved\n${infoText}`
      );

      await ctx.reply(
        `🎤 Voice message received and saved.\n` +
        `Duration: ${info.duration}s\n` +
        `Path: \`${info.localPath}\`\n\n` +
        `_Note: Voice transcription requires additional setup. ` +
        `The audio file is saved for future processing._`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('[Telegram] Voice handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `❌ Error processing voice: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Handle audio files
  bot.on(message('audio'), async (ctx) => {
    const chatId = ctx.chat.id;
    const audio = ctx.message.audio;
    const caption = ctx.message.caption;

    console.log(`[Telegram] Audio file received: ${audio.file_name} from chat ${chatId}`);

    const processingMsg = await ctx.reply('🎵 Downloading audio...');

    try {
      const result = await handleAudio(ctx, audio, caption);

      if (!result.success || !result.attachment) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          `❌ Failed to download audio: ${result.error}`
        );
        return;
      }

      const info = result.attachment;
      const infoText = formatAttachmentInfo(info);

      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `✅ Audio saved: ${info.fileName}\n${infoText}`
      );

      await ctx.reply(
        `🎵 Audio file received and saved.\n` +
        `Path: \`${info.localPath}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('[Telegram] Audio handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `❌ Error processing audio: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Handle video files
  bot.on(message('video'), async (ctx) => {
    const chatId = ctx.chat.id;
    const video = ctx.message.video;
    const caption = ctx.message.caption;

    console.log(`[Telegram] Video received from chat ${chatId}`);

    const processingMsg = await ctx.reply('🎬 Downloading video...');

    try {
      const result = await handleVideo(ctx, video, caption);

      if (!result.success || !result.attachment) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          `❌ Failed to download video: ${result.error}`
        );
        return;
      }

      const info = result.attachment;
      const infoText = formatAttachmentInfo(info);

      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `✅ Video saved\n${infoText}`
      );

      await ctx.reply(
        `🎬 Video received and saved.\n` +
        `Path: \`${info.localPath}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('[Telegram] Video handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        `❌ Error processing video: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  return bot;
}

/**
 * Create Telegram delivery handler for reminders
 */
function createTelegramDeliveryHandler(): DeliveryHandler {
  return async (job: CronJob, channel: DeliveryChannel) => {
    if (channel.kind !== 'telegram' || !telegramApi) {
      throw new Error('Telegram API not available');
    }

    const chatId = channel.chatId;
    const message = `🔔 **Reminder: ${job.name}**\n\n${job.message}`;

    await telegramApi.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    logActivity({
      source: 'cron',
      type: 'reminder',
      sessionId: `cron-${job.id}`,
      content: `Delivered reminder: ${job.name}`,
    });
  };
}

/**
 * Start the cron scheduler
 */
function startCronScheduler(): void {
  cronScheduler = new CronScheduler({
    checkIntervalMs: 60000, // Check every minute
    deliveryHandlers: {
      telegram: createTelegramDeliveryHandler(),
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

  cronScheduler.start();
  console.log('⏰ Cron scheduler started');
}

/**
 * Main entry point
 */
async function main() {
  if (!BOT_TOKEN) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable not set');
    console.log('\nTo set up:');
    console.log('1. Talk to @BotFather on Telegram');
    console.log('2. Create a new bot with /newbot');
    console.log('3. Copy the token');
    console.log('4. Set TELEGRAM_BOT_TOKEN=your_token in .env file');
    process.exit(1);
  }

  console.log('🤖 Starting LocalBot...');
  console.log(`📡 Ollama endpoint: ${OLLAMA_HOST}`);
  console.log(`🧠 Default model: ${DEFAULT_MODEL}`);
  console.log(`🔧 Tools registered: ${registry.size}`);

  try {
    const bot = await createBot();

    // Store Telegram API reference for reminder delivery
    telegramApi = bot.telegram;

    // Start cron scheduler for reminders
    startCronScheduler();

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n👋 Shutting down...');
      // Stop cron scheduler
      if (cronScheduler) {
        cronScheduler.stop();
        console.log('⏰ Cron scheduler stopped');
      }
      // Save sessions before exit
      sessions.saveToDisk();
      console.log('💾 Sessions saved to disk');
      bot.stop('SIGTERM');
      process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    // Start polling
    await bot.launch();
    console.log('✅ Bot is running!');
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Run if this is the main module
main();
