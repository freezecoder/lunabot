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
import { importClaudeSkills, listClaudeSkills, getImportedSkillsPath } from '../skills/claude-importer.js';
import type { SkillEntry } from '../skills/types.js';
import { getClaudeSkillsDir, isClaudeSkillsEnabled, getLocalbotHome } from '../config/paths.js';
import { loadContext, buildSystemPrompt, getContextSummary, type LoadedContext } from '../context/loader.js';
import { readFileSync, existsSync } from 'fs';
import { MODEL_CAPABILITIES } from '../router/router.js';
import { mcpManager, loadMcpConfig, type McpServerConfig } from '../mcp/client.js';
import { globalMetrics } from '../tracking/metrics.js';
import { globalTokenTracker, calculateContextPercentage } from '../tracking/tokens.js';
import { globalSessionManager } from '../session/manager.js';
import { getMemoryManager, setMemoryLoggerChannel } from '../memory/manager.js';
import { getCompactStatus, getFullSystemReport, getOllamaStats, formatBytes, formatUptime } from '../utils/system-monitor.js';
import { logActivity } from '../utils/activity-tracker.js';
import { join } from 'path';
import { getDB, createLogger, type Logger } from '../db/index.js';
import type { SkillInfo, WorkspaceFileInfo } from '../db/types.js';
import { setWorkspaceLoggerChannel } from '../workspace/loader.js';
import { setToolExecutorChannel } from '../tools/executor.js';
import { getProjectManager, type ProjectManager, type ProjectSummary } from '../project/index.js';
import 'dotenv/config';

// Terminal logger
let terminalLogger: Logger;

// Project manager
let projectManager: ProjectManager;

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.121.61.16:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const SKILLS_DIR = process.env.SKILLS_DIR || './skills';
const MCP_CONFIG = process.env.MCP_CONFIG || './config/mcp.yaml';

// These will be set by project manager
let CONTEXT_DIR: string;
let AGENT_DIR: string;

// State
let currentModel = DEFAULT_MODEL;
let agent: Agent;
let provider: OllamaProvider;
let registry: ToolRegistry;
let context: LoadedContext;
let sessionId = 'terminal-default';  // Persistent session ID
let showTools = true;
let memoryContext = '';  // Today's/yesterday's memory loaded on startup

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

  // Check project identity first
  const activeProject = projectManager?.getActiveProject();
  if (activeProject?.config.identity?.name) {
    title = `${activeProject.config.identity.name} CLI`;
    emoji = activeProject.config.identity.emoji || '';
  } else if (context?.identity) {
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

  // Show current project
  if (activeProject) {
    const projectName = activeProject.config.displayName || activeProject.config.name;
    console.log(colors.info(`  Project: ${colors.success(projectName)}`));
    console.log(colors.info(`  WorkDir: ${activeProject.workingDirPath}`));
  }

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

  // Show system stats
  console.log(colors.info(`  System: ${getCompactStatus()}`));

  console.log(colors.info(`  Type ${colors.command('/help')} for commands\n`));
  console.log(chalk.gray('─'.repeat(64)) + '\n');
}

/**
 * Load today's and yesterday's memory files (clawdbot-style)
 */
async function loadDailyMemory(): Promise<string> {
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
 * Print help message
 */
function printHelp() {
  const activeProject = projectManager?.getActiveProject();
  const contextInfo = activeProject
    ? `project ${colors.success(activeProject.config.name)}`
    : `global context (${CONTEXT_DIR})`;

  console.log(`
${chalk.bold('Commands:')}
  ${colors.command('/help')}      - Show this help
  ${colors.command('/status')}    - Show system status (memory, CPU, Ollama)
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

${chalk.bold('Project Commands:')}
  ${colors.command('/projects')}  - List available projects
  ${colors.command('/project')}   - Switch project (e.g., /project myapp)
  ${colors.command('/project off')} - Return to global context
  ${colors.command('/pwd')}       - Show current working directory

${chalk.bold('Session Commands:')}
  ${colors.command('/sessions')}  - List saved sessions
  ${colors.command('/history')}   - Show conversation history
  ${colors.command('/save')}      - Save current conversation to memory
  ${colors.command('/new')}       - Start new session (preserves old)
  ${colors.command('/load')}      - Load a previous session

${chalk.bold('Claude Skills:')}
  ${colors.command('/list-claude')}   - List available Claude skills
  ${colors.command('/import-claude')} - Import Claude skills to LocalBot

${chalk.bold('Tips:')}
  • Currently working in ${contextInfo}
  • Session memory is automatically persisted
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
    if (isClaudeSkillsEnabled()) {
      console.log(colors.info(`  Claude skills dir: ${getClaudeSkillsDir()}`));
    }
    console.log();
    return;
  }

  // Group skills by source
  const bySource = new Map<string, SkillEntry[]>();
  for (const skill of promptSkills) {
    const source = skill.source;
    if (!bySource.has(source)) {
      bySource.set(source, []);
    }
    bySource.get(source)!.push(skill);
  }

  for (const [source, skills] of bySource) {
    const sourceLabel = source === 'claude' ? 'Claude Skills' : source;
    console.log(colors.info(`  [${sourceLabel}]`));
    for (const skill of skills) {
      const isActive = activeSkill?.name === skill.name;
      const status = isActive ? colors.success(' ← active') : '';
      const priority = skill.metadata?.priority ? colors.info(` ⚡${skill.metadata.priority}`) : '';
      console.log(`    ${colors.tool('•')} ${chalk.bold(skill.name)}${priority}${status}`);
      console.log(`      ${colors.info(skill.description.slice(0, 60))}...`);
      if (skill.metadata?.triggers?.length) {
        console.log(`      ${colors.info(`Triggers: ${skill.metadata.triggers.slice(0, 3).join(', ')}`)}`);
      }
    }
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
 * Auto-match a message to a skill based on triggers
 * Returns highest priority skill that matches
 */
function autoMatchSkill(message: string): SkillEntry | null {
  const lower = message.toLowerCase();
  const matches: Array<{ skill: SkillEntry; priority: number }> = [];

  for (const skill of promptSkills) {
    // Check skill metadata triggers (from YAML frontmatter)
    const triggers = skill.metadata?.triggers || [];
    for (const trigger of triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        const priority = skill.metadata?.priority ?? 0;
        matches.push({ skill, priority });
        break;
      }
    }
  }

  if (matches.length === 0) return null;

  // Sort by priority (highest first) and return the best match
  matches.sort((a, b) => b.priority - a.priority);
  return matches[0].skill;
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
  let systemPrompt = buildSystemPrompt(context, registry.getSummary());

  // Inject memory context if available
  if (memoryContext) {
    systemPrompt = `${systemPrompt}\n\n## Recent Memory\n\n${memoryContext}`;
  }

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
  // Reload context files
  context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  memoryContext = await loadDailyMemory();

  // Reload skills
  promptSkills = [];
  const mdSkillsDirs = [`${CONTEXT_DIR}/skills`, `${AGENT_DIR}/skills`, SKILLS_DIR];
  let skillCount = 0;

  for (const skillsPath of mdSkillsDirs) {
    try {
      const skills = await loadMdSkills(skillsPath, 'workspace');
      if (skills.length > 0) {
        promptSkills.push(...skills);
        skillCount += skills.length;
      }
    } catch {}
  }

  // Reload imported Claude skills
  const importedSkillsDir = getImportedSkillsPath();
  try {
    const importedSkills = await loadMdSkills(importedSkillsDir, 'claude');
    if (importedSkills.length > 0) {
      promptSkills.push(...importedSkills);
      skillCount += importedSkills.length;
      console.log(colors.info(`  Imported Claude skills: ${importedSkills.length}`));
    }
  } catch {}

  const mcpCount = await loadMcpServers();
  agent = createAgent();
  console.log(colors.success(`\n✓ Reloaded ${context.files.length} context files, ${skillCount} skills, ${mcpCount} MCP servers\n`));
}

/**
 * List saved sessions
 */
async function listSessions() {
  const sessions = await globalSessionManager.listSessions();
  console.log(`\n${chalk.bold('Saved Sessions:')} (${sessions.length})\n`);

  if (sessions.length === 0) {
    console.log(colors.info('  No saved sessions.'));
    console.log();
    return;
  }

  for (const id of sessions.slice(0, 10)) {
    const stats = await globalSessionManager.getStats(id);
    const isCurrent = id === sessionId ? colors.success(' ← current') : '';
    const msgCount = stats?.messageCount || 0;
    console.log(`  ${colors.tool('•')} ${chalk.bold(id)}${isCurrent}`);
    console.log(colors.info(`    Messages: ${msgCount}`));
  }

  if (sessions.length > 10) {
    console.log(colors.info(`  ... and ${sessions.length - 10} more`));
  }
  console.log();
}

/**
 * Show conversation history
 */
async function showHistory() {
  const messages = globalSessionManager.getMessages(sessionId);
  console.log(`\n${chalk.bold('Conversation History:')} (${messages.length} messages)\n`);

  if (messages.length === 0) {
    console.log(colors.info('  No messages in this session.'));
    console.log();
    return;
  }

  for (const msg of messages.slice(-20)) {  // Last 20 messages
    const role = msg.role === 'user' ? colors.user('You') :
                 msg.role === 'assistant' ? colors.assistant('Assistant') :
                 colors.info(msg.role);

    const content = typeof msg.content === 'string'
      ? msg.content.slice(0, 100)
      : '[complex content]';

    console.log(`  ${role}: ${content}${content.length >= 100 ? '...' : ''}`);
  }

  if (messages.length > 20) {
    console.log(colors.info(`  ... showing last 20 of ${messages.length} messages`));
  }
  console.log();
}

/**
 * Save conversation to memory file
 */
async function saveToMemory() {
  const messages = globalSessionManager.getMessages(sessionId);

  if (messages.length === 0) {
    console.log(colors.error('\nNo messages to save.\n'));
    return;
  }

  // Create summary of conversation
  const summary = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content.slice(0, 200) : '[tool call]';
      return `**${role}:** ${content}`;
    })
    .join('\n\n');

  const memoryManager = await getMemoryManager();
  const filepath = await memoryManager.flush(`## Session Summary\n\n${summary}`);

  console.log(colors.success(`\n✓ Saved to ${filepath}\n`));
}

/**
 * Start new session
 */
async function startNewSession() {
  const newId = `terminal-${Date.now()}`;
  await globalSessionManager.getSession(newId);
  sessionId = newId;
  agent = createAgent();
  console.log(colors.success(`\n✓ Started new session: ${sessionId}\n`));
}

/**
 * Show system status
 */
async function showStatus() {
  console.log(`\n${chalk.bold('System Status:')}\n`);

  const report = await getFullSystemReport(OLLAMA_HOST);
  console.log(colors.info(report));

  // Add session info
  const stats = await globalSessionManager.getStats(sessionId);
  console.log(colors.info(`\n### Session`));
  console.log(colors.info(`  ID: ${sessionId}`));
  console.log(colors.info(`  Messages: ${stats?.messageCount || 0}`));
  console.log(colors.info(`  Model: ${currentModel}`));

  // Tool stats
  const toolStats = agent.getStats();
  console.log(colors.info(`\n### Tools`));
  console.log(colors.info(`  Registered: ${registry.size}`));
  console.log(colors.info(`  Calls: ${toolStats.total} (${toolStats.successful} successful)`));

  console.log();
}

/**
 * Load a previous session
 */
async function loadSession(targetId: string) {
  const sessions = await globalSessionManager.listSessions();

  // Find matching session
  const match = sessions.find(s => s === targetId || s.includes(targetId));

  if (!match) {
    console.log(colors.error(`\nSession "${targetId}" not found.`));
    console.log(colors.info('Use /sessions to see available sessions.\n'));
    return;
  }

  await globalSessionManager.getSession(match);
  sessionId = match;
  agent = createAgent();

  const stats = await globalSessionManager.getStats(sessionId);
  console.log(colors.success(`\n✓ Loaded session: ${sessionId}`));
  console.log(colors.info(`  Messages: ${stats?.messageCount || 0}\n`));
}

/**
 * List available projects
 */
async function listProjects() {
  const projects = await projectManager.listProjects();

  console.log(`\n${chalk.bold('Available Projects:')} (${projects.length})\n`);

  if (projects.length === 0) {
    console.log(colors.info('  No projects found.'));
    console.log(colors.info(`  Create a project directory in ${projectManager.getProjectsRoot()}/`));
    console.log(colors.info(`  Or use: /project /path/to/your/project\n`));
    return;
  }

  for (const project of projects) {
    const status = project.isActive ? colors.success(' ← active') : '';
    const configBadge = project.hasConfig ? '' : colors.info(' (no config)');
    console.log(`  ${colors.tool('•')} ${chalk.bold(project.displayName)}${status}${configBadge}`);
    if (project.description) {
      console.log(colors.info(`    ${project.description.slice(0, 60)}...`));
    }
    console.log(colors.info(`    ${project.path}`));
  }

  console.log();
  console.log(colors.info('  Use /project <name> to switch projects'));
  console.log(colors.info('  Use /project off to return to global context'));
  console.log();
}

/**
 * Switch to a project
 */
async function switchProject(nameOrPath: string) {
  // Handle 'off' command
  if (nameOrPath === 'off' || nameOrPath === 'none' || nameOrPath === 'clear') {
    projectManager.clearActiveProject();

    // Reset to global context
    CONTEXT_DIR = projectManager.getGlobalContextDir();
    AGENT_DIR = './agent';

    // Reload context
    await reloadContext();

    console.log(colors.success('\n✓ Returned to global context\n'));
    return;
  }

  try {
    const project = await projectManager.setActiveProject(nameOrPath);

    // Update context directories
    CONTEXT_DIR = project.rootPath;
    AGENT_DIR = project.rootPath;

    // Update model if project specifies one
    if (project.config.model) {
      currentModel = project.config.model;
    }

    // Reload context with new project
    await reloadContext();

    const displayName = project.config.displayName || project.config.name;
    console.log(colors.success(`\n✓ Switched to project: ${colors.model(displayName)}`));
    console.log(colors.info(`  Working directory: ${project.workingDirPath}`));
    if (project.hasLocalIdentity) {
      console.log(colors.info(`  Project has local identity files`));
    }
    if (project.hasLocalSkills) {
      console.log(colors.info(`  Project has local skills`));
    }
    console.log();
  } catch (error) {
    console.log(colors.error(`\nFailed to switch project: ${error instanceof Error ? error.message : error}`));
    console.log(colors.info('Use /projects to see available projects.\n'));
  }
}

/**
 * Show current project info
 */
function showCurrentProject() {
  const project = projectManager.getActiveProject();

  if (!project) {
    console.log(colors.info(`\nNo active project. Using global context.`));
    console.log(colors.info(`  Context: ${CONTEXT_DIR}`));
    console.log(colors.info('  Use /projects to see available projects.\n'));
    return;
  }

  const displayName = project.config.displayName || project.config.name;
  console.log(`\n${chalk.bold('Current Project:')} ${colors.success(displayName)}\n`);
  if (project.config.description) {
    console.log(colors.info(`  ${project.config.description}`));
  }
  console.log(colors.info(`  Root: ${project.rootPath}`));
  console.log(colors.info(`  Working dir: ${project.workingDirPath}`));
  console.log(colors.info(`  Memory dir: ${project.memoryDirPath}`));
  if (project.config.model) {
    console.log(colors.info(`  Model: ${project.config.model}`));
  }
  console.log(colors.info(`  Local identity: ${project.hasLocalIdentity ? 'yes' : 'no'}`));
  console.log(colors.info(`  Local skills: ${project.hasLocalSkills ? 'yes' : 'no'}`));
  console.log();
}

/**
 * Show current working directory
 */
function showWorkingDirectory() {
  const project = projectManager.getActiveProject();
  const workDir = project ? project.workingDirPath : CONTEXT_DIR;

  console.log(colors.info(`\n  Working directory: ${workDir}\n`));
}

/**
 * Import Claude skills
 */
async function importClaudeSkillsCommand() {
  console.log(colors.info(`\nImporting Claude skills from ${getClaudeSkillsDir()}...`));

  try {
    const results = await importClaudeSkills();

    if (results.length === 0) {
      console.log(colors.info('No Claude skills found to import.'));
      console.log(colors.info(`Claude skills directory: ${getClaudeSkillsDir()}`));
      console.log();
      return;
    }

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(colors.success(`\n✓ Imported ${successful.length} Claude skills:`));
    for (const skill of successful) {
      const scriptInfo = skill.hasScript ? ` (with script)` : '';
      console.log(colors.info(`  • ${skill.name}${scriptInfo}`));
    }

    if (failed.length > 0) {
      console.log(colors.error(`\n✗ Failed to import ${failed.length} skills:`));
      for (const skill of failed) {
        console.log(colors.error(`  • ${skill.name}: ${skill.error}`));
      }
    }

    console.log(colors.info(`\nImported to: ${getImportedSkillsPath()}`));
    console.log(colors.info('Run /reload to load the imported skills.\n'));
  } catch (error) {
    console.log(colors.error(`\nFailed to import Claude skills: ${error instanceof Error ? error.message : error}\n`));
  }
}

/**
 * List available Claude skills (not yet imported)
 */
async function listClaudeSkillsCommand() {
  console.log(colors.info(`\nClaude skills directory: ${getClaudeSkillsDir()}\n`));

  try {
    const skills = await listClaudeSkills();

    if (skills.length === 0) {
      console.log(colors.info('No Claude skills found.'));
      console.log();
      return;
    }

    console.log(chalk.bold(`Available Claude skills (${skills.length}):\n`));
    for (const skill of skills) {
      console.log(colors.info(`  • ${skill}`));
    }

    console.log(colors.info(`\nUse /import-claude to import these skills.\n`));
  } catch (error) {
    console.log(colors.error(`\nFailed to list Claude skills: ${error instanceof Error ? error.message : error}\n`));
  }
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
      case 'status':
        await showStatus();
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
        await globalSessionManager.clearSession(sessionId);
        console.log(colors.success('\n✓ Conversation cleared\n'));
        return;
      case 'reset':
        printHeader();
        return;
      case 'sessions':
        await listSessions();
        return;
      case 'history':
        await showHistory();
        return;
      case 'save':
        await saveToMemory();
        return;
      case 'new':
        await startNewSession();
        return;
      case 'load':
        if (args[0]) {
          await loadSession(args.join(' '));
        } else {
          console.log(colors.info('Usage: /load <session_id>'));
          console.log(colors.info('Use /sessions to see available sessions.\n'));
        }
        return;
      case 'projects':
        await listProjects();
        return;
      case 'project':
        if (args[0]) {
          await switchProject(args.join(' '));
        } else {
          showCurrentProject();
        }
        return;
      case 'pwd':
        showWorkingDirectory();
        return;
      case 'import-claude':
        await importClaudeSkillsCommand();
        return;
      case 'list-claude':
        await listClaudeSkillsCommand();
        return;
      case 'exit':
      case 'quit':
        // Persist session before exit
        await globalSessionManager.persistAll();
        console.log(colors.info('\nGoodbye! 👋\n'));
        rl.close();
        process.exit(0);
      default:
        console.log(colors.error(`Unknown command: /${cmd}. Type /help for commands.`));
        return;
    }
  }

  if (!trimmed) return;

  // Inject skill content if active (manual or auto-matched)
  let messageToSend = trimmed;
  let usedSkill: SkillEntry | null = null;
  let usedSkillContent: string | null = null;

  if (activeSkill && activeSkillContent) {
    // Use manually activated skill
    usedSkill = activeSkill;
    usedSkillContent = activeSkillContent;
  } else {
    // Try auto-matching based on triggers
    const matched = autoMatchSkill(trimmed);
    if (matched) {
      try {
        usedSkillContent = readFileSync(matched.path, 'utf-8');
        usedSkill = matched;
      } catch {}
    }
  }

  if (usedSkill && usedSkillContent) {
    messageToSend = `## SKILL CONTEXT: ${usedSkill.name}

${usedSkillContent}

## USER REQUEST
${trimmed}

IMPORTANT: Use the bash tool to execute any commands from the skill instructions. Show real output, don't just explain.`;
    const autoLabel = activeSkill ? '' : ' (auto)';
    console.log(colors.info(`  [Using skill: ${usedSkill.name}${autoLabel}]\n`));
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

    // Auto-persist messages to session store
    await globalSessionManager.addMessage(sessionId, { role: 'user', content: trimmed });
    if (content) {
      await globalSessionManager.addMessage(sessionId, { role: 'assistant', content });
    }

    // Log activity for dashboard
    logActivity({
      source: 'terminal',
      type: 'message',
      sessionId,
      content: trimmed.slice(0, 100),
    });

    if (toolsUsed.length > 0) {
      logActivity({
        source: 'terminal',
        type: 'tool_call',
        sessionId,
        content: `Used: ${toolsUsed.join(', ')}`,
        metadata: { tools: toolsUsed },
      });
    }

  } catch (error) {
    console.log(colors.error(`\n\nError: ${error instanceof Error ? error.message : error}\n`));
  }
}

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();
  const skillsInfo: SkillInfo[] = [];

  // Initialize database and logger
  const db = getDB();
  terminalLogger = createLogger('terminal');

  // Set channel for all loggers
  setWorkspaceLoggerChannel('terminal');
  setMemoryLoggerChannel('terminal');
  setToolExecutorChannel('terminal');

  terminalLogger.startupBegin();

  // Initialize project manager
  projectManager = getProjectManager('terminal');
  CONTEXT_DIR = projectManager.getGlobalContextDir();
  AGENT_DIR = process.env.AGENT_DIR || './agent';

  console.log(`Projects root: ${projectManager.getProjectsRoot()}`);
  console.log(`Global context: ${CONTEXT_DIR}`);

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
        for (const skill of skills) {
          skillsInfo.push({ name: skill.name, source: skillsPath, type: 'tool' });
        }
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
        for (const skill of skills) {
          skillsInfo.push({ name: skill.name, source: skillsPath, type: 'prompt' });
        }
      }
    } catch {}
  }

  // Load imported Claude skills from ~/.localbot/skills/claude-imported/
  const importedSkillsDir = getImportedSkillsPath();
  try {
    const importedSkills = await loadMdSkills(importedSkillsDir, 'claude');
    if (importedSkills.length > 0) {
      promptSkills.push(...importedSkills);
      console.log(`Loaded ${importedSkills.length} imported Claude skills from ${importedSkillsDir}`);
      for (const skill of importedSkills) {
        skillsInfo.push({ name: skill.name, source: importedSkillsDir, type: 'prompt' });
      }
    }
  } catch {
    // No imported skills yet
  }

  // Log skills loaded
  terminalLogger.skillsLoaded(skillsInfo);

  // Load context from global + agent directories
  context = await loadContext(CONTEXT_DIR, AGENT_DIR);
  console.log(`Loaded ${context.files.length} context files from ${context.sources.join(', ') || 'no sources'}`);

  // Load daily memory (clawdbot-style: today + yesterday)
  memoryContext = await loadDailyMemory();
  if (memoryContext) {
    console.log(`Loaded daily memory from ${CONTEXT_DIR}/memory`);
  }

  // Load or create session (persistent)
  await globalSessionManager.getSession(sessionId);
  const stats = await globalSessionManager.getStats(sessionId);
  if (stats && stats.messageCount > 0) {
    console.log(`Restored session with ${stats.messageCount} messages`);
  }

  // Load MCP servers
  const mcpServersCount = await loadMcpServers();
  if (mcpServersCount > 0) {
    console.log(`Connected to ${mcpServersCount} MCP server(s)`);
  }

  // Create agent
  agent = createAgent();

  // Log tools loaded and calculate duration
  terminalLogger.toolsLoaded(registry.size);
  const durationMs = Date.now() - startTime;

  // Create startup manifest
  db.createStartupManifest({
    started_at: startTime,
    channel: 'terminal',
    workspace_files: null,  // Already logged by workspace loader
    skills_loaded: JSON.stringify(skillsInfo),
    tools_count: registry.size,
    model_default: currentModel,
    duration_ms: durationMs,
  });

  terminalLogger.startupComplete(durationMs);

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
