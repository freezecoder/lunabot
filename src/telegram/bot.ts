/**
 * Telegram Bot - Main bot entry point
 * Uses telegraf.js for Telegram Bot API
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { Agent, StreamEvent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools } from '../tools/built-in/index.js';
import { loadSkillsFromDirectory } from '../tools/skill-loader.js';
import { SessionManager } from './session/manager.js';
import { MODEL_CAPABILITIES } from '../router/router.js';
import 'dotenv/config';

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';

// Initialize components
const provider = new OllamaProvider({ host: OLLAMA_HOST });
const registry = new ToolRegistry();
const sessions = new SessionManager({ defaultModel: DEFAULT_MODEL });

// Register built-in tools
registry.registerAll(getAllBuiltInTools());

// Agent will be initialized after async skill loading
let agent: Agent;

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
 * Create the bot
 */
async function createBot(): Promise<Telegraf> {
  // Load skills from directory
  try {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    registry.registerAll(skills);
    console.log(`Loaded ${skills.length} custom skills`);
  } catch (error) {
    console.log('No custom skills loaded:', error);
  }

  // Initialize agent
  agent = new Agent({
    provider,
    registry,
    defaultModel: DEFAULT_MODEL,
    routerConfig: {
      reasoningModel: DEFAULT_MODEL,
      toolCallingModel: DEFAULT_MODEL,
    },
  });

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
    const userMessage = ctx.message.text;
    const session = sessions.get(chatId, ctx.from?.username);
    const prefs = sessions.getPreferences(chatId);

    // Send typing indicator
    await ctx.sendChatAction('typing');

    // Send initial "thinking" message
    const thinkingMsg = await ctx.reply('💭 Thinking...');
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
