/**
 * Telegram Bot - Main bot entry point
 * Uses telegraf.js for Telegram Bot API
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { readFileSync } from 'fs';
import { Agent, StreamEvent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools } from '../tools/built-in/index.js';
import { loadSkillsFromDirectory } from '../tools/skill-loader.js';
import { loadSkillsFromDirectory as loadMdSkills } from '../skills/loader.js';
import { SessionManager } from './session/manager.js';
import { MODEL_CAPABILITIES } from '../router/router.js';
import { loadContext, buildSystemPrompt } from '../context/loader.js';
import type { SkillEntry } from '../skills/types.js';
import 'dotenv/config';

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const REASONING_MODEL = process.env.REASONING_MODEL || 'qwen2.5:32b';  // Smarter model for chat/planning
const TOOL_MODEL = process.env.TOOL_MODEL || DEFAULT_MODEL;            // Faster model for tool execution
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';
const CONTEXT_DIR = process.env.CONTEXT_DIR || '/Users/zayed/clawd';
const AGENT_DIR = process.env.AGENT_DIR || './agent';

// Initialize components
const provider = new OllamaProvider({ host: OLLAMA_HOST });
const registry = new ToolRegistry();
const sessions = new SessionManager({ defaultModel: DEFAULT_MODEL });

// Register built-in tools
registry.registerAll(getAllBuiltInTools());

// Agent will be initialized after async skill loading
let agent: Agent;

// Prompt skills for auto-injection
let promptSkills: SkillEntry[] = [];

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
 */
function matchSkillByKeywords(message: string, skills: SkillEntry[]): SkillEntry | null {
  const lower = message.toLowerCase();

  for (const skill of skills) {
    const keywords = SKILL_KEYWORDS[skill.name] || [];
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return skill;
      }
    }
  }
  return null;
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
 * Create the bot
 */
async function createBot(): Promise<Telegraf> {
  // Load YAML/JSON tool skills from multiple directories
  const skillsDirs = [SKILLS_DIR, `${AGENT_DIR}/skills`, `${CONTEXT_DIR}/skills`];
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
      `/clear - Clear conversation\n` +
      `/status - Show current status\n` +
      `/help - Show this help\n\n` +
      `Just send me a message to start chatting!`
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 *LocalBot Help*\n\n` +
      `*Commands:*\n` +
      `/start - Welcome message\n` +
      `/model - Switch model (shows menu)\n` +
      `/models - List all available models\n` +
      `/tools - Show available tools\n` +
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
      `Current model: \`${sessions.getModel(ctx.chat.id)}\``,
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
    let text = `🔧 *Available Tools* (${tools.length})\n\n`;

    for (const tool of tools) {
      text += `• *${tool.name}*: ${tool.description.slice(0, 60)}...\n`;
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
    const stats = sessions.getStats();
    const toolStats = agent.getStats();

    await ctx.reply(
      `📊 *Status*\n\n` +
      `*Your Session:*\n` +
      `Model: \`${session.model}\`\n` +
      `Messages: ${session.messages.length}\n\n` +
      `*Global:*\n` +
      `Active sessions: ${stats.totalSessions}\n` +
      `Total messages: ${stats.totalMessages}\n` +
      `Tool calls: ${toolStats.total}\n` +
      `Success rate: ${((toolStats.successful / (toolStats.total || 1)) * 100).toFixed(0)}%\n\n` +
      `*Connection:*\n` +
      `Ollama: \`${OLLAMA_HOST}\``,
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

  // Handle text messages
  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    let userMessage = ctx.message.text;
    const session = sessions.get(chatId, ctx.from?.username);
    const prefs = sessions.getPreferences(chatId);

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
      await ctx.telegram.editMessageText(
        chatId,
        thinkingMsg.message_id,
        undefined,
        finalContent
      );

      // Add messages to session
      sessions.addMessage(chatId, { role: 'user', content: userMessage });
      sessions.addMessage(chatId, { role: 'assistant', content: lastContent });
      sessions.setLastMessageId(chatId, thinkingMsg.message_id);

    } catch (error) {
      console.error('Message handling error:', error);
      await ctx.telegram.editMessageText(
        chatId,
        thinkingMsg.message_id,
        undefined,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Handle document uploads
  bot.on(message('document'), async (ctx) => {
    await ctx.reply('📄 File upload support coming soon. For now, please share file contents as text.');
  });

  // Handle photos
  bot.on(message('photo'), async (ctx) => {
    await ctx.reply('🖼️ Image analysis not yet supported. Please describe what you see instead.');
  });

  return bot;
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

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n👋 Shutting down...');
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
