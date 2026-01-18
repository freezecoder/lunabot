/**
 * Context Loader - Load personal context files (SOUL, IDENTITY, USER, etc.)
 * Similar to clawdbot's context system
 *
 * Supports multiple context sources:
 * 1. Global context (e.g., /Users/zayed/clawd) - shared across all projects
 * 2. Agent context (e.g., ./agent) - project-specific personality
 * 3. Skills from agent/skills/ directory
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, extname, resolve } from 'path';

export interface ContextFile {
  name: string;
  content: string;
  path: string;
  source: 'global' | 'agent' | 'project';
}

export interface LoadedContext {
  files: ContextFile[];
  identity?: ContextFile;
  soul?: ContextFile;
  user?: ContextFile;
  tools?: ContextFile;
  custom: ContextFile[];
  sources: string[];
}

// Default directories
const DEFAULT_GLOBAL_CONTEXT = process.env.CONTEXT_DIR || '/Users/zayed/clawd';
const DEFAULT_AGENT_DIR = process.env.AGENT_DIR || './agent';

// Known context file names (case-insensitive)
const KNOWN_FILES = ['identity', 'soul', 'user', 'tools', 'heartbeat', 'skills'];

/**
 * Load a single context file
 */
async function loadContextFile(filePath: string, source: ContextFile['source']): Promise<ContextFile | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return {
      name: basename(filePath, extname(filePath)),
      content: content.trim(),
      path: filePath,
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Load context files from a single directory
 */
async function loadFromDirectory(
  dir: string,
  source: ContextFile['source']
): Promise<ContextFile[]> {
  const files: ContextFile[] = [];

  try {
    const entries = await readdir(dir);

    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') continue;

      const filePath = join(dir, entry);
      const stats = await stat(filePath);
      if (!stats.isFile()) continue;

      const file = await loadContextFile(filePath, source);
      if (file) {
        files.push(file);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return files;
}

/**
 * Load context from multiple directories
 * Agent-local files override global files with the same name
 */
export async function loadContext(
  globalDir: string = DEFAULT_GLOBAL_CONTEXT,
  agentDir: string = DEFAULT_AGENT_DIR
): Promise<LoadedContext> {
  const result: LoadedContext = {
    files: [],
    custom: [],
    sources: [],
  };

  // Load from global context first
  const globalFiles = await loadFromDirectory(globalDir, 'global');
  if (globalFiles.length > 0) {
    result.sources.push(globalDir);
  }

  // Load from agent directory (overrides global)
  const agentPath = resolve(agentDir);
  const agentFiles = await loadFromDirectory(agentPath, 'agent');
  if (agentFiles.length > 0) {
    result.sources.push(agentPath);
  }

  // Merge files - agent files override global files with same name
  const fileMap = new Map<string, ContextFile>();

  for (const file of globalFiles) {
    fileMap.set(file.name.toLowerCase(), file);
  }

  for (const file of agentFiles) {
    fileMap.set(file.name.toLowerCase(), file);
  }

  result.files = Array.from(fileMap.values());

  // Categorize known files
  for (const file of result.files) {
    const nameLower = file.name.toLowerCase();
    if (nameLower === 'identity') {
      result.identity = file;
    } else if (nameLower === 'soul') {
      result.soul = file;
    } else if (nameLower === 'user') {
      result.user = file;
    } else if (nameLower === 'tools') {
      result.tools = file;
    } else if (!KNOWN_FILES.includes(nameLower)) {
      result.custom.push(file);
    }
  }

  return result;
}

/**
 * Build a system prompt from loaded context
 */
export function buildSystemPrompt(context: LoadedContext, toolsSummary: string): string {
  const sections: string[] = [];

  // Identity section
  if (context.identity) {
    const identity = parseIdentity(context.identity.content);
    sections.push(`You are ${identity.name || 'an AI assistant'}${identity.creature ? `, a ${identity.creature}` : ''}.${identity.vibe ? ` Your vibe: ${identity.vibe}.` : ''}${identity.emoji ? ` ${identity.emoji}` : ''}`);
  } else {
    sections.push('You are LocalBot, a helpful AI assistant.');
  }

  // Soul/behavior section
  if (context.soul) {
    sections.push('\n## Behavior Guidelines\n' + extractBullets(context.soul.content));
  }

  // User section
  if (context.user) {
    const user = parseUser(context.user.content);
    let userSection = '\n## User Context';
    if (user.name) userSection += `\n- User's name: ${user.name}`;
    if (user.timezone) userSection += `\n- Timezone: ${user.timezone}`;
    if (user.interests) userSection += `\n- Interests: ${user.interests}`;
    if (user.work) userSection += `\n- Work: ${user.work}`;
    if (user.notes) userSection += `\n- Notes: ${user.notes}`;
    sections.push(userSection);
  }

  // Tools section
  sections.push(`\n## Available Tools\n${toolsSummary}`);

  // Tool notes from context
  if (context.tools) {
    sections.push('\n## Tool Notes\n' + extractContent(context.tools.content));
  }

  // Custom context files
  for (const custom of context.custom) {
    sections.push(`\n## ${custom.name}\n${extractContent(custom.content)}`);
  }

  // Footer
  sections.push(`\nCurrent date: ${new Date().toISOString().split('T')[0]}`);

  return sections.join('\n');
}

/**
 * Parse identity file
 */
function parseIdentity(content: string): { name?: string; creature?: string; vibe?: string; emoji?: string } {
  const result: { name?: string; creature?: string; vibe?: string; emoji?: string } = {};

  const lines = content.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('name:')) {
      result.name = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('creature:')) {
      result.creature = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('vibe:')) {
      result.vibe = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('emoji:')) {
      result.emoji = line.split(':').slice(1).join(':').trim();
    }
  }

  return result;
}

/**
 * Parse user file
 */
function parseUser(content: string): { name?: string; timezone?: string; interests?: string; work?: string; notes?: string } {
  const result: { name?: string; timezone?: string; interests?: string; work?: string; notes?: string } = {};

  const lines = content.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('name:') && !lower.includes('preferred')) {
      result.name = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('preferred address:')) {
      result.name = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('timezone')) {
      result.timezone = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('interests:')) {
      result.interests = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('work:')) {
      result.work = line.split(':').slice(1).join(':').trim();
    } else if (lower.includes('notes:')) {
      result.notes = line.split(':').slice(1).join(':').trim();
    }
  }

  return result;
}

/**
 * Extract bullet points from content
 */
function extractBullets(content: string): string {
  const lines = content.split('\n');
  const bullets = lines.filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));
  return bullets.join('\n');
}

/**
 * Extract main content (skip headers)
 */
function extractContent(content: string): string {
  const lines = content.split('\n');
  return lines
    .filter(l => !l.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Get context summary for display
 */
export function getContextSummary(context: LoadedContext): string {
  const parts: string[] = [];

  if (context.identity) {
    const id = parseIdentity(context.identity.content);
    parts.push(`${id.name || 'Unknown'}${id.emoji ? ' ' + id.emoji : ''}`);
  }

  if (context.user) {
    const user = parseUser(context.user.content);
    if (user.name) parts.push(`User: ${user.name}`);
  }

  parts.push(`${context.files.length} files from ${context.sources.length} source${context.sources.length !== 1 ? 's' : ''}`);

  return parts.join(' | ');
}
