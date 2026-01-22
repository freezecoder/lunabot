/**
 * Gateway - Main entry point for running LocalBot as a daemon
 * Runs Telegram bot, cron scheduler, and HTTP/WS server together
 *
 * Inspired by clawdbot's gateway architecture but simplified
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Agent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools, setReminderTelegramChatId } from '../tools/built-in/index.js';
import { loadSkillsFromDirectory } from '../tools/skill-loader.js';
import { loadSkillsFromDirectory as loadMdSkills } from '../skills/loader.js';
import { SessionManager } from '../telegram/session/manager.js';
import { getTelegramTools, setTelegramContext, clearTelegramContext } from '../telegram/tools.js';
import { MODEL_CAPABILITIES } from '../router/router.js';
import { loadContext, buildSystemPrompt } from '../context/loader.js';
import { logActivity } from '../utils/activity-tracker.js';
import { GatewayServer } from './server.js';
import {
  ServicesManager,
  servicesManager,
  createCronService,
  type ServiceDefinition,
} from './services.js';
import { createMemorySyncService } from '../memory/sync-service.js';
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from './types.js';
import type { SkillEntry } from '../skills/types.js';
import { getDB, createLogger, type Logger } from '../db/index.js';
import type { SkillInfo, WorkspaceFileInfo } from '../db/types.js';
import { setWorkspaceLoggerChannel } from '../workspace/loader.js';
import { setMemoryLoggerChannel } from '../memory/manager.js';
import { setToolExecutorChannel } from '../tools/executor.js';
import { getProjectManager, type ProjectManager } from '../project/index.js';
import 'dotenv/config';

// Gateway logger
let gatewayLogger: Logger;

// Project manager
let projectManager: ProjectManager;

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const REASONING_MODEL = process.env.REASONING_MODEL || 'qwen2.5:32b';
const TOOL_MODEL = process.env.TOOL_MODEL || DEFAULT_MODEL;
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';

// These will be set by project manager
let CONTEXT_DIR = process.env.CONTEXT_DIR || '/Users/zayed/clawd';
let AGENT_DIR = process.env.AGENT_DIR || './agent';

// Shared components
const provider = new OllamaProvider({ host: OLLAMA_HOST });
const registry = new ToolRegistry();
const sessions = new SessionManager({ defaultModel: DEFAULT_MODEL });

// Register tools
registry.registerAll(getAllBuiltInTools());
registry.registerAll(getTelegramTools());

// Gateway server instance
let gatewayServer: GatewayServer | null = null;

// Prompt skills for skill matching
let promptSkills: SkillEntry[] = [];

// Agent instance
let agent: Agent;

/**
 * Load skills and context
 * Returns system prompt and skill info for startup manifest
 */
async function loadSkillsAndContext(): Promise<{ systemPrompt: string; skillsInfo: SkillInfo[] }> {
  const skillsInfo: SkillInfo[] = [];

  // Initialize project manager for gateway channel
  projectManager = getProjectManager('gateway');

  // Use project-aware paths
  CONTEXT_DIR = projectManager.getContextDir();
  AGENT_DIR = process.env.AGENT_DIR || './agent';

  console.log(`[Gateway] Context dir: ${CONTEXT_DIR}`);
  console.log(`[Gateway] Working dir: ${projectManager.getWorkingDir()}`);

  // Load YAML/JSON tool skills (including project skills)
  const skillsDirs = [SKILLS_DIR, ...projectManager.getSkillsDirs(), `${AGENT_DIR}/skills`];
  let totalToolSkills = 0;

  for (const skillsPath of skillsDirs) {
    try {
      const skills = await loadSkillsFromDirectory(skillsPath);
      if (skills.length > 0) {
        registry.registerAll(skills);
        totalToolSkills += skills.length;
        console.log(`[Gateway] Loaded ${skills.length} tool skills from ${skillsPath}`);

        // Track for manifest
        for (const skill of skills) {
          skillsInfo.push({ name: skill.name, source: skillsPath, type: 'tool' });
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Load MD prompt skills
  const mdSkillsDirs = [`${CONTEXT_DIR}/skills`, `${AGENT_DIR}/skills`];
  const mdSkills: SkillEntry[] = [];

  for (const skillsPath of mdSkillsDirs) {
    try {
      const skills = await loadMdSkills(skillsPath, 'workspace');
      if (skills.length > 0) {
        mdSkills.push(...skills);
        console.log(`[Gateway] Loaded ${skills.length} prompt skills from ${skillsPath}`);

        // Track for manifest
        for (const skill of skills) {
          skillsInfo.push({ name: skill.name, source: skillsPath, type: 'prompt' });
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  promptSkills = mdSkills;
  console.log(`[Gateway] Total skills: ${totalToolSkills} tools, ${mdSkills.length} prompts`);

  // Log skills loaded
  gatewayLogger.skillsLoaded(skillsInfo);

  // Load context
  const context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  let systemPrompt = buildSystemPrompt(context, registry.getSummary());

  // Add skill descriptions
  if (mdSkills.length > 0) {
    systemPrompt += '\n\n## Available Skills\n';
    for (const skill of mdSkills) {
      systemPrompt += `- **${skill.name}**: ${skill.description.slice(0, 100)}...\n`;
    }
  }

  // Load daily memory
  const memoryDir = join(CONTEXT_DIR, 'memory');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const date of [yesterday, today]) {
    const memFile = join(memoryDir, `${date}.md`);
    if (existsSync(memFile)) {
      try {
        const content = readFileSync(memFile, 'utf-8');
        systemPrompt += `\n\n## Memory (${date})\n${content}`;
      } catch {}
    }
  }

  console.log(`[Gateway] Context loaded from ${context.sources.join(', ')}`);
  return { systemPrompt, skillsInfo };
}

/**
 * Create Telegram bot service
 */
function createTelegramService(): ServiceDefinition {
  let bot: Telegraf | null = null;
  let running = false;

  return {
    name: 'telegram',
    async start() {
      const startTime = Date.now();

      if (!BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN not set');
      }

      gatewayLogger.startupBegin();

      // Load skills and create agent
      const { systemPrompt, skillsInfo } = await loadSkillsAndContext();

      agent = new Agent({
        provider,
        registry,
        systemPrompt,
        defaultModel: REASONING_MODEL,
        routerConfig: {
          reasoningModel: REASONING_MODEL,
          toolCallingModel: TOOL_MODEL,
        },
      });

      // Create bot
      bot = new Telegraf(BOT_TOKEN);
      servicesManager.setTelegramBot(bot);

      // Error handling
      bot.catch((err, ctx) => {
        console.error('[Telegram] Bot error:', err);
        ctx.reply('An error occurred. Please try again.').catch(() => {});
      });

      // Commands
      bot.command('start', async (ctx) => {
        const username = ctx.from?.username || ctx.from?.first_name || 'there';
        await ctx.reply(
          `👋 Hello ${username}!\n\n` +
          `I'm LocalBot, running via the Gateway.\n\n` +
          `Commands: /help, /status, /clear, /model`
        );
      });

      bot.command('help', async (ctx) => {
        await ctx.reply(
          `🤖 *LocalBot Help*\n\n` +
          `Commands:\n` +
          `/start - Welcome\n` +
          `/model - Switch model\n` +
          `/clear - Clear history\n` +
          `/status - Show status\n\n` +
          `Just send a message to chat!`,
          { parse_mode: 'Markdown' }
        );
      });

      bot.command('clear', async (ctx) => {
        sessions.clear(ctx.chat.id);
        await ctx.reply('🗑️ Conversation cleared.');
      });

      bot.command('status', async (ctx) => {
        const services = servicesManager.getAll();
        const serviceStatus = services.map(s => `• ${s.name}: ${s.status}`).join('\n');
        await ctx.reply(
          `📊 *Gateway Status*\n\n` +
          `Services:\n${serviceStatus}\n\n` +
          `Model: \`${sessions.getModel(ctx.chat.id)}\``,
          { parse_mode: 'Markdown' }
        );
      });

      bot.command('model', async (ctx) => {
        const currentModel = sessions.getModel(ctx.chat.id);
        const buttons = Object.entries(MODEL_CAPABILITIES)
          .filter(([_, info]) => info.supportsTools)
          .slice(0, 8)
          .map(([model, _]) => {
            const isCurrent = model === currentModel ? ' ✓' : '';
            return Markup.button.callback(`${model.split(':')[0]}${isCurrent}`, `model:${model}`);
          });

        await ctx.reply(
          `Current: \`${currentModel}\`\nSelect:`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons, { columns: 2 }) }
        );
      });

      bot.action(/^model:(.+)$/, async (ctx) => {
        const model = ctx.match[1];
        sessions.setModel(ctx.chat!.id, model);
        await ctx.answerCbQuery(`Switched to ${model}`);
        await ctx.editMessageText(`Model: \`${model}\``, { parse_mode: 'Markdown' });
      });

      // Message handler
      bot.on(message('text'), async (ctx) => {
        const chatId = ctx.chat.id;
        const userMessage = ctx.message.text;
        const session = sessions.get(chatId, ctx.from?.username);

        setTelegramContext(ctx, chatId);
        setReminderTelegramChatId(chatId);

        await ctx.sendChatAction('typing');
        const thinkingMsg = await ctx.reply('💭 Thinking...');

        let lastContent = '';

        try {
          for await (const event of agent.runStream(userMessage, session.id, session.userId)) {
            if (event.type === 'content' && event.content) {
              lastContent += event.content;
            } else if (event.type === 'error') {
              lastContent = `❌ Error: ${event.error}`;
            }
          }

          const finalContent = lastContent || 'I processed your request.';
          try {
            await ctx.telegram.editMessageText(chatId, thinkingMsg.message_id, undefined, finalContent.slice(0, 4000));
          } catch (e) {
            if (!(e instanceof Error && e.message.includes('message is not modified'))) {
              throw e;
            }
          }

          sessions.addMessage(chatId, { role: 'user', content: userMessage });
          sessions.addMessage(chatId, { role: 'assistant', content: lastContent });

          logActivity({
            source: 'telegram',
            type: 'message',
            sessionId: session.id,
            userId: ctx.from?.username || String(chatId),
            content: userMessage.slice(0, 100),
          });

        } catch (error) {
          console.error('[Telegram] Message error:', error);
          await ctx.telegram.editMessageText(
            chatId,
            thinkingMsg.message_id,
            undefined,
            `❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`
          );
        } finally {
          clearTelegramContext();
        }
      });

      // Start polling
      await bot.launch();
      running = true;

      const durationMs = Date.now() - startTime;

      // Create startup manifest
      const db = getDB();
      db.createStartupManifest({
        started_at: startTime,
        channel: 'telegram',
        workspace_files: null,  // Already logged by workspace loader
        skills_loaded: JSON.stringify(skillsInfo),
        tools_count: registry.size,
        model_default: DEFAULT_MODEL,
        duration_ms: durationMs,
      });

      // Log tools loaded and startup complete
      gatewayLogger.toolsLoaded(registry.size);
      gatewayLogger.startupComplete(durationMs);

      console.log('[Gateway] Telegram bot started');
    },

    async stop() {
      if (bot && running) {
        bot.stop('Gateway shutdown');
        running = false;
        console.log('[Gateway] Telegram bot stopped');
      }
    },

    getStats() {
      return {
        running,
        model: DEFAULT_MODEL,
        tools: registry.size,
      };
    },
  };
}

/**
 * Create HTTP/WS server service
 */
function createHttpService(config: GatewayConfig): ServiceDefinition {
  return {
    name: 'http',
    async start() {
      gatewayServer = new GatewayServer(config);
      await gatewayServer.start();
    },
    async stop() {
      if (gatewayServer) {
        await gatewayServer.stop();
        gatewayServer = null;
      }
    },
    getStats() {
      return {
        port: config.port,
        clients: gatewayServer?.getClientCount() || 0,
      };
    },
  };
}

/**
 * Main gateway entry point
 */
export async function startGateway(config: GatewayConfig = DEFAULT_GATEWAY_CONFIG): Promise<void> {
  // Initialize database and logger first
  const db = getDB();
  gatewayLogger = createLogger('gateway');

  // Set channel for all loggers
  setWorkspaceLoggerChannel('gateway');
  setMemoryLoggerChannel('gateway');
  setToolExecutorChannel('telegram');

  console.log('🚀 Starting LocalBot Gateway...');
  console.log(`📡 Ollama: ${OLLAMA_HOST}`);
  console.log(`🔧 Tools: ${registry.size}`);
  console.log(`💾 Database: ${db.getPath()}`);

  // Register services
  servicesManager.register(createHttpService(config));
  console.log('   📦 HTTP/WS service registered');

  if (config.cron.enabled) {
    servicesManager.register(createCronService(servicesManager));
    console.log('   📦 Cron service registered');
  }

  // Memory sync service (daily memory updates)
  if (config.memorySync?.enabled !== false) {
    servicesManager.register(createMemorySyncService(config.memorySync));
    console.log('   📦 Memory sync service registered');
  }

  // Always try to start Telegram bot if token is available
  const telegramToken = config.telegram.token || process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    servicesManager.register(createTelegramService());
    console.log('   📦 Telegram bot service registered');
  } else {
    console.log('   ⚠️  Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }

  // Start all services
  console.log('\n🔄 Starting services...');
  await servicesManager.startAll();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n👋 Shutting down gateway...');
    await servicesManager.stopAll();
    sessions.saveToDisk();
    console.log('💾 Sessions saved');
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Show running services
  const allServices = servicesManager.getAll();
  const runningServices = allServices.filter(s => s.status === 'running');
  console.log('\n✅ Gateway running!');
  console.log(`   Services: ${runningServices.map(s => s.name).join(', ')}`);
  console.log(`   HTTP/WS: http://${config.host}:${config.port}`);
  console.log(`   Health:  http://${config.host}:${config.port}/health`);
  console.log(`   Status:  http://${config.host}:${config.port}/status`);

  const hasTelegram = runningServices.some(s => s.name === 'telegram');
  if (hasTelegram) {
    console.log(`   🤖 Telegram bot is running!`);
  }
}

// CLI entry point
if (process.argv[1]?.includes('gateway')) {
  startGateway().catch((error) => {
    console.error('Gateway failed:', error);
    process.exit(1);
  });
}

export { GatewayServer, ServicesManager, servicesManager };
export * from './types.js';
