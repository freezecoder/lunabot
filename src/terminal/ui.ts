/**
 * Terminal UI - Interactive chat interface for LocalBot
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { Agent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools } from '../tools/built-in/index.js';
import { loadSkillsFromDirectory } from '../tools/skill-loader.js';
import { loadSkillsFromDirectory as loadMdSkills } from '../skills/loader.js';
import type { SkillEntry } from '../skills/types.js';
import { loadContext, buildSystemPrompt, getContextSummary, type LoadedContext } from '../context/loader.js';
import { readFileSync } from 'fs';
import { MODEL_CAPABILITIES } from '../router/router.js';
import { mcpManager, loadMcpConfig, type McpServerConfig } from '../mcp/client.js';
import { globalMetrics } from '../tracking/metrics.js';
import { globalTokenTracker, calculateContextPercentage } from '../tracking/tokens.js';
import 'dotenv/config';

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';
const AGENT_DIR = process.env.AGENT_DIR || './agent';
const CONTEXT_DIR = process.env.CONTEXT_DIR || '/Users/zayed/clawd';
const MCP_CONFIG = process.env.MCP_CONFIG || './config/mcp.yaml';

// State
let currentModel = DEFAULT_MODEL;
let agent: Agent;
let provider: OllamaProvider;
let registry: ToolRegistry;
let context: LoadedContext;
let sessionId = `terminal-${Date.now()}`;
let showTools = true;

// Skill state
let promptSkills: SkillEntry[] = [];
let activeSkill: SkillEntry | null = null;
let activeSkillContent: string | null = null;

// Colors
const colors = {
  user: chalk.cyan,
  assistant: chalk.green,
  tool: chalk.yellow,
  error: chalk.red,
  info: chalk.gray,
  success: chalk.greenBright,
  model: chalk.magenta,
  command: chalk.blue,
  identity: chalk.yellow,
};

/**
 * Print styled header
 */
function printHeader() {
  console.clear();

  // Get identity info
  let title = '🤖 LocalBot CLI';
  let emoji = '';
  if (context?.identity) {
    const lines = context.identity.content.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes('name:')) {
        const name = line.split(':').slice(1).join(':').trim();
        title = `${name} CLI`;
      }
      if (line.toLowerCase().includes('emoji:')) {
        emoji = line.split(':').slice(1).join(':').trim();
      }
    }
  }

  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════╗
║                    ${emoji} ${title.padEnd(40)}║
╚══════════════════════════════════════════════════════════════╝
`));

  console.log(colors.info(`  Model: ${colors.model(currentModel)}`));
  console.log(colors.info(`  Ollama: ${OLLAMA_HOST}`));
  console.log(colors.info(`  Tools: ${registry?.size || 0} registered`));

  const mcpServers = mcpManager.getAllServers();
  if (mcpServers.length > 0) {
    console.log(colors.info(`  MCP: ${mcpServers.length} server(s), ${mcpManager.getTools().length} tools`));
  }

  if (context) {
    console.log(colors.info(`  Context: ${colors.identity(getContextSummary(context))}`));
  }

  if (promptSkills.length > 0) {
    const activeInfo = activeSkill ? colors.success(` [active: ${activeSkill.name}]`) : '';
    console.log(colors.info(`  Skills: ${promptSkills.length} available${activeInfo}`));
  }

  // Show token usage if available
  const sessionStats = globalTokenTracker.getSessionStats(sessionId);
  if (sessionStats && sessionStats.totalTokens > 0) {
    const lastUsage = globalTokenTracker.getLastUsage(sessionId);
    const ctxPct = lastUsage ? calculateContextPercentage(lastUsage.input, currentModel) : 0;
    console.log(colors.info(`  Tokens: ↓${sessionStats.totalInput} ↑${sessionStats.totalOutput} (ctx: ${ctxPct.toFixed(1)}%)`));
  }

  console.log(colors.info(`  Type ${colors.command('/help')} for commands\n`));
  console.log(chalk.gray('─'.repeat(64)) + '\n');
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
${chalk.bold('Commands:')}
  ${colors.command('/help')}      - Show this help
  ${colors.command('/model')}     - Switch model (e.g., /model llama3.1:8b)
  ${colors.command('/models')}    - List available models
  ${colors.command('/tools')}     - List available tools
  ${colors.command('/skill')}     - Set active skill (e.g., /skill genomics-jobs)
  ${colors.command('/skills')}    - List available skills
  ${colors.command('/tokens')}    - Show token usage statistics
  ${colors.command('/mcp')}       - Show MCP servers and tools
  ${colors.command('/context')}   - Show loaded context files
  ${colors.command('/reload')}    - Reload context and MCP servers
  ${colors.command('/toggle')}    - Toggle tool visibility
  ${colors.command('/clear')}     - Clear conversation
  ${colors.command('/reset')}     - Reset screen
  ${colors.command('/exit')}      - Exit

${chalk.bold('Tips:')}
  • The assistant knows your context from ${CONTEXT_DIR}
  • Tool calls shown in ${colors.tool('yellow')}
  • Token usage: ↓ = input, ↑ = output, ctx = context window %
  • Use /skill <name> to load a skill context (e.g., /skill genomics-jobs)
  • Use /skill off to disable active skill
`);
}

/**
 * Show token usage statistics
 */
function showTokens() {
  console.log(`\n${chalk.bold('Token Usage Statistics:')}\n`);

  // Session stats
  const sessionStats = globalTokenTracker.getSessionStats(sessionId);
  if (sessionStats) {
    console.log(colors.info(`  Current Session: ${sessionId}`));
    console.log(colors.info(`    Requests: ${sessionStats.requestCount}`));
    console.log(colors.info(`    Input:  ${sessionStats.totalInput.toLocaleString()} tokens (avg: ${Math.round(sessionStats.averageInput)})`));
    console.log(colors.info(`    Output: ${sessionStats.totalOutput.toLocaleString()} tokens (avg: ${Math.round(sessionStats.averageOutput)})`));
    console.log(colors.info(`    Total:  ${sessionStats.totalTokens.toLocaleString()} tokens`));

    // Show last request context percentage
    const lastUsage = globalTokenTracker.getLastUsage(sessionId);
    if (lastUsage) {
      const ctxPct = calculateContextPercentage(lastUsage.input, currentModel);
      console.log(colors.info(`    Context: ${ctxPct.toFixed(1)}% of window used`));
    }
    console.log();
  } else {
    console.log(colors.info('  No token usage recorded for this session.\n'));
  }

  // Global stats
  const globalStats = globalTokenTracker.getGlobalStats();
  if (globalStats.requestCount > 0) {
    console.log(colors.info(`  Global Statistics:`));
    console.log(colors.info(`    Total requests: ${globalStats.requestCount}`));
    console.log(colors.info(`    Total input:  ${globalStats.totalInput.toLocaleString()} tokens`));
    console.log(colors.info(`    Total output: ${globalStats.totalOutput.toLocaleString()} tokens`));
    console.log(colors.info(`    Total:        ${globalStats.totalTokens.toLocaleString()} tokens`));

    if (globalStats.byModel.size > 0) {
      console.log(colors.info(`\n  By Model:`));
      for (const [model, stats] of globalStats.byModel) {
        console.log(colors.info(`    ${colors.model(model)}: ${stats.count} requests, ↓${stats.input.toLocaleString()} ↑${stats.output.toLocaleString()}`));
      }
    }
    console.log();
  }
}

/**
 * Show loaded context
 */
function showContext() {
  console.log(`\n${chalk.bold('Loaded Context:')}\n`);

  if (context?.sources.length) {
    console.log(colors.info(`  Sources:`));
    for (const src of context.sources) {
      console.log(colors.info(`    • ${src}`));
    }
    console.log();
  }

  if (!context || context.files.length === 0) {
    console.log(colors.info('  No context files loaded.'));
    console.log(colors.info(`  Add .md files to ${CONTEXT_DIR} or ${AGENT_DIR}`));
    console.log();
    return;
  }

  for (const file of context.files) {
    const icon = file.name.toLowerCase() === 'identity' ? '🪪' :
                 file.name.toLowerCase() === 'soul' ? '👻' :
                 file.name.toLowerCase() === 'user' ? '👤' :
                 file.name.toLowerCase() === 'tools' ? '🔧' : '📄';

    const sourceTag = file.source === 'agent' ? colors.model(' [agent]') : colors.info(' [global]');
    console.log(`  ${icon} ${chalk.bold(file.name)}${sourceTag}`);

    // Show preview
    const preview = file.content.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .slice(0, 3)
      .map(l => `     ${colors.info(l.slice(0, 60))}`)
      .join('\n');

    if (preview) console.log(preview);
    console.log();
  }
}

/**
 * List available models
 */
async function listModels() {
  try {
    const models = await provider.listModels();
    console.log(`\n${chalk.bold('Available Models:')}\n`);
    for (const model of models) {
      const isCurrent = model === currentModel ? colors.success(' ← current') : '';
      const info = MODEL_CAPABILITIES[model];
      const toolsIcon = info?.supportsTools ? '🔧' : '  ';
      console.log(`  ${toolsIcon} ${colors.model(model)}${isCurrent}`);
    }
    console.log();
  } catch (error) {
    console.log(colors.error('Failed to list models. Is Ollama running?'));
  }
}

/**
 * Switch model
 */
async function switchModel(model: string) {
  const models = await provider.listModels();
  const match = models.find(m => m.includes(model) || model.includes(m.split(':')[0]));

  if (match) {
    currentModel = match;
    agent = createAgent();
    sessionId = `terminal-${Date.now()}`;
    console.log(colors.success(`\n✓ Switched to ${colors.model(currentModel)}\n`));
  } else {
    console.log(colors.error(`\nModel "${model}" not found. Use /models to see available models.\n`));
  }
}

/**
 * List tools
 */
function listTools() {
  const tools = registry.getAll();
  console.log(`\n${chalk.bold('Available Tools:')} (${tools.length})\n`);
  for (const tool of tools) {
    console.log(`  ${colors.tool('•')} ${chalk.bold(tool.name)}`);
    console.log(`    ${colors.info(tool.description.slice(0, 70))}...`);
  }
  console.log();
}

/**
 * List available skills
 */
function listSkills() {
  console.log(`\n${chalk.bold('Available Skills:')} (${promptSkills.length})\n`);

  if (promptSkills.length === 0) {
    console.log(colors.info('  No skills loaded.'));
    console.log(colors.info(`  Add SKILL.md files to ${CONTEXT_DIR}/skills/`));
    console.log();
    return;
  }

  for (const skill of promptSkills) {
    const isActive = activeSkill?.name === skill.name;
    const status = isActive ? colors.success(' ← active') : '';
    console.log(`  ${colors.tool('•')} ${chalk.bold(skill.name)}${status}`);
    console.log(`    ${colors.info(skill.description.slice(0, 70))}...`);
    console.log(`    ${colors.info(`Source: ${skill.source}`)}`);
  }
  console.log();

  if (activeSkill) {
    console.log(colors.info(`  Active skill: ${colors.success(activeSkill.name)}`));
    console.log(colors.info(`  Use /skill off to disable`));
    console.log();
  }
}

/**
 * Set active skill
 */
function setSkill(skillName: string) {
  if (skillName === 'off' || skillName === 'none' || skillName === 'clear') {
    activeSkill = null;
    activeSkillContent = null;
    console.log(colors.success('\n✓ Skill disabled. Using normal mode.\n'));
    return;
  }

  const skill = promptSkills.find(s =>
    s.name.toLowerCase() === skillName.toLowerCase() ||
    s.name.toLowerCase().includes(skillName.toLowerCase())
  );

  if (!skill) {
    console.log(colors.error(`\nSkill "${skillName}" not found.`));
    console.log(colors.info('Use /skills to see available skills.\n'));
    return;
  }

  try {
    activeSkillContent = readFileSync(skill.path, 'utf-8');
    activeSkill = skill;
    console.log(colors.success(`\n✓ Active skill: ${colors.model(skill.name)}`));
    console.log(colors.info(`  All messages will be processed with this skill context.`));
    console.log(colors.info(`  Use /skill off to disable.\n`));
  } catch (e) {
    console.log(colors.error(`\nFailed to load skill from ${skill.path}\n`));
  }
}

/**
 * Show MCP servers and their tools
 */
function showMcp() {
  const servers = mcpManager.getAllServers();

  console.log(`\n${chalk.bold('MCP Servers:')} (${servers.length})\n`);

  if (servers.length === 0) {
    console.log(colors.info('  No MCP servers connected.'));
    console.log(colors.info(`  Configure servers in ${MCP_CONFIG}`));
    console.log();
    return;
  }

  for (const server of servers) {
    const status = server.isConnected() ? colors.success('●') : colors.error('○');
    console.log(`  ${status} ${chalk.bold(server.name)}`);

    if (server.tools.length > 0) {
      console.log(colors.info(`    Tools (${server.tools.length}):`));
      for (const tool of server.tools.slice(0, 5)) {
        console.log(colors.info(`      • ${tool.name}`));
      }
      if (server.tools.length > 5) {
        console.log(colors.info(`      ... and ${server.tools.length - 5} more`));
      }
    }

    if (server.resources.length > 0) {
      console.log(colors.info(`    Resources: ${server.resources.length}`));
    }

    console.log();
  }
}

/**
 * Create agent with current settings
 */
function createAgent(): Agent {
  const systemPrompt = buildSystemPrompt(context, registry.getSummary());

  return new Agent({
    provider,
    registry,
    defaultModel: currentModel,
    systemPrompt,
    routerConfig: {
      reasoningModel: currentModel,
      toolCallingModel: currentModel,
    },
  });
}

/**
 * Load MCP servers from config
 */
async function loadMcpServers() {
  try {
    const mcpConfig = await loadMcpConfig(MCP_CONFIG);

    // Stop existing servers
    mcpManager.stopAll();

    // Start new servers
    let connected = 0;
    for (const serverConfig of mcpConfig.servers || []) {
      try {
        await mcpManager.addServer(serverConfig);
        connected++;
      } catch (error) {
        console.log(colors.error(`  Failed to connect MCP server ${serverConfig.name}: ${error instanceof Error ? error.message : error}`));
      }
    }

    // Register MCP tools in the registry
    const mcpTools = mcpManager.getTools();
    for (const tool of mcpTools) {
      registry.register(tool);
    }

    return connected;
  } catch (error) {
    return 0;
  }
}

/**
 * Reload context and MCP servers
 */
async function reloadContext() {
  context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  const mcpCount = await loadMcpServers();
  agent = createAgent();
  console.log(colors.success(`\n✓ Reloaded ${context.files.length} context files, ${mcpCount} MCP servers\n`));
}

/**
 * Process user input
 */
async function processInput(input: string, rl: readline.Interface) {
  const trimmed = input.trim();

  // Handle commands
  if (trimmed.startsWith('/')) {
    const [cmd, ...args] = trimmed.slice(1).split(' ');

    switch (cmd.toLowerCase()) {
      case 'help':
        printHelp();
        return;
      case 'model':
        if (args[0]) {
          await switchModel(args[0]);
        } else {
          console.log(colors.info(`Current model: ${colors.model(currentModel)}`));
          console.log(colors.info('Usage: /model <model_name>'));
        }
        return;
      case 'models':
        await listModels();
        return;
      case 'tools':
        listTools();
        return;
      case 'skill':
        if (args[0]) {
          setSkill(args.join(' '));
        } else {
          if (activeSkill) {
            console.log(colors.info(`\nActive skill: ${colors.success(activeSkill.name)}`));
            console.log(colors.info('Use /skill off to disable, or /skill <name> to switch.'));
          } else {
            console.log(colors.info('\nNo active skill. Use /skill <name> to set one.'));
          }
          console.log(colors.info('Use /skills to see available skills.\n'));
        }
        return;
      case 'skills':
        listSkills();
        return;
      case 'tokens':
        showTokens();
        return;
      case 'mcp':
        showMcp();
        return;
      case 'context':
        showContext();
        return;
      case 'reload':
        await reloadContext();
        return;
      case 'toggle':
        showTools = !showTools;
        console.log(colors.info(`\nTool visibility: ${showTools ? 'ON' : 'OFF'}\n`));
        return;
      case 'clear':
        sessionId = `terminal-${Date.now()}`;
        console.log(colors.success('\n✓ Conversation cleared\n'));
        return;
      case 'reset':
        printHeader();
        return;
      case 'exit':
      case 'quit':
        console.log(colors.info('\nGoodbye! 👋\n'));
        rl.close();
        process.exit(0);
      default:
        console.log(colors.error(`Unknown command: /${cmd}. Type /help for commands.`));
        return;
    }
  }

  if (!trimmed) return;

  // Inject skill content if active
  let messageToSend = trimmed;
  if (activeSkill && activeSkillContent) {
    messageToSend = `## SKILL CONTEXT: ${activeSkill.name}

${activeSkillContent}

## USER REQUEST
${trimmed}

IMPORTANT: Use the bash tool to execute any commands from the skill instructions. Show real output, don't just explain.`;
    console.log(colors.info(`  [Using skill: ${activeSkill.name}]\n`));
  }

  // Process message
  console.log();
  process.stdout.write(colors.assistant('Assistant: '));

  let content = '';
  let toolsUsed: string[] = [];
  let lastTokenUsage: { input: number; output: number; total: number } | undefined;

  try {
    for await (const event of agent.runStream(messageToSend, sessionId)) {
      switch (event.type) {
        case 'content':
          if (event.content) {
            content += event.content;
            process.stdout.write(event.content);
          }
          break;

        case 'tool_start':
          if (showTools && event.toolCall) {
            const name = event.toolCall.function.name;
            let args = '';
            try {
              const parsed = JSON.parse(event.toolCall.function.arguments);
              args = Object.entries(parsed)
                .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
                .join(', ');
            } catch {}

            console.log(`\n${colors.tool(`  ⚡ ${name}`)}${args ? colors.info(` (${args})`) : ''}`);
            toolsUsed.push(name);
          }
          break;

        case 'tool_end':
          if (showTools && event.toolCall) {
            const preview = event.toolResult?.slice(0, 60).replace(/\n/g, ' ') || 'done';
            console.log(colors.info(`     → ${preview}...`));
            process.stdout.write(colors.assistant('  '));
          }
          break;

        case 'done':
          if (event.tokenUsage) {
            lastTokenUsage = event.tokenUsage;
          }
          break;

        case 'error':
          console.log(colors.error(`\n\nError: ${event.error}`));
          break;
      }
    }

    console.log('\n');

    // Show usage info
    const usageInfo: string[] = [];
    if (toolsUsed.length > 0 && showTools) {
      usageInfo.push(`Used: ${toolsUsed.join(', ')}`);
    }
    if (lastTokenUsage) {
      const ctxPct = calculateContextPercentage(lastTokenUsage.input, currentModel);
      usageInfo.push(`↓${lastTokenUsage.input} ↑${lastTokenUsage.output} (ctx: ${ctxPct.toFixed(1)}%)`);
    }
    if (usageInfo.length > 0) {
      console.log(colors.info(`  [${usageInfo.join(' | ')}]`));
      console.log();
    }

  } catch (error) {
    console.log(colors.error(`\n\nError: ${error instanceof Error ? error.message : error}\n`));
  }
}

/**
 * Main entry point
 */
async function main() {
  // Initialize provider
  provider = new OllamaProvider({ host: OLLAMA_HOST });

  // Initialize registry
  registry = new ToolRegistry();
  registry.registerAll(getAllBuiltInTools());

  // Load tool skills (YAML/JSON) from multiple directories
  for (const skillsPath of [SKILLS_DIR, `${AGENT_DIR}/skills`]) {
    try {
      const skills = await loadSkillsFromDirectory(skillsPath);
      if (skills.length > 0) {
        registry.registerAll(skills);
        console.log(`Loaded ${skills.length} tool skills from ${skillsPath}`);
      }
    } catch {}
  }

  // Load prompt skills (MD files with SKILL.md pattern)
  const mdSkillsDirs = [`${CONTEXT_DIR}/skills`, `${AGENT_DIR}/skills`, SKILLS_DIR];
  for (const skillsPath of mdSkillsDirs) {
    try {
      const skills = await loadMdSkills(skillsPath, 'workspace');
      if (skills.length > 0) {
        promptSkills.push(...skills);
        console.log(`Loaded ${skills.length} prompt skills from ${skillsPath}`);
      }
    } catch {}
  }

  // Load context from global + agent directories
  context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  console.log(`Loaded ${context.files.length} context files from ${context.sources.join(', ') || 'no sources'}`);

  // Load MCP servers
  const mcpServersCount = await loadMcpServers();
  if (mcpServersCount > 0) {
    console.log(`Connected to ${mcpServersCount} MCP server(s)`);
  }

  // Create agent
  agent = createAgent();

  // Print header
  printHeader();

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Handle input
  const prompt = () => {
    rl.question(colors.user('You: '), async (input) => {
      await processInput(input, rl);
      prompt();
    });
  };

  // Handle close
  rl.on('close', () => {
    console.log(colors.info('\nGoodbye! 👋\n'));
    process.exit(0);
  });

  // Start prompt
  prompt();
}

main().catch(err => {
  console.error(chalk.red('Failed to start:'), err);
  process.exit(1);
});
