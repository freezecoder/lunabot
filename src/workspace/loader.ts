/**
 * Workspace Loader - Load bootstrap files for persona/identity
 */

import { readFile, access, unlink, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { constants } from 'fs';
import {
  BOOTSTRAP_FILES,
  type WorkspaceFile,
  type WorkspaceContext,
  parseIdentity,
  parseUserInfo,
} from './types.js';
import { getGlobalContextDir, getAgentDir } from '../config/paths.js';
import { createLogger, type Logger } from '../db/index.js';
import type { WorkspaceFileInfo, Channel } from '../db/types.js';

// Module-level logger for workspace operations
let workspaceLogger: Logger | null = null;

/**
 * Set the channel for workspace logging
 */
export function setWorkspaceLoggerChannel(channel: Channel): void {
  workspaceLogger = createLogger(channel);
}

/**
 * Get the workspace logger (creates with 'system' channel if not set)
 */
function getLogger(): Logger {
  if (!workspaceLogger) {
    workspaceLogger = createLogger('system');
  }
  return workspaceLogger;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a single file with error handling
 */
async function loadFile(
  path: string,
  name: string,
  filename: string,
  source: 'global' | 'workspace',
  priority: number
): Promise<WorkspaceFile> {
  try {
    const exists = await fileExists(path);
    if (!exists) {
      return {
        name,
        filename,
        path,
        content: '',
        missing: true,
        source,
        priority,
      };
    }

    const content = await readFile(path, 'utf-8');
    return {
      name,
      filename,
      path,
      content,
      missing: false,
      source,
      priority,
    };
  } catch (error) {
    return {
      name,
      filename,
      path,
      content: '',
      missing: true,
      source,
      priority,
    };
  }
}

/**
 * Load bootstrap files from a directory
 */
async function loadBootstrapFromDir(
  dir: string,
  source: 'global' | 'workspace',
  basePriority: number
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];

  for (let i = 0; i < BOOTSTRAP_FILES.length; i++) {
    const filename = BOOTSTRAP_FILES[i];
    const name = filename.replace('.md', '');
    const path = join(dir, filename);
    const priority = basePriority + i;

    const file = await loadFile(path, name, filename, source, priority);
    files.push(file);
  }

  return files;
}

/**
 * Load additional markdown files from a directory (non-bootstrap)
 */
async function loadExtraFiles(
  dir: string,
  source: 'global' | 'workspace',
  basePriority: number
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const bootstrapLower = BOOTSTRAP_FILES.map(f => f.toLowerCase());

    let extraPriority = basePriority;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (bootstrapLower.includes(entry.name.toLowerCase())) continue;

      const path = join(dir, entry.name);
      const name = entry.name.replace('.md', '');

      const file = await loadFile(path, name, entry.name, source, extraPriority++);
      if (!file.missing) {
        files.push(file);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return files;
}

/**
 * Load workspace bootstrap files from global and workspace directories
 *
 * Load order (lowest to highest priority):
 * 1. Global directory bootstrap files
 * 2. Global directory extra files
 * 3. Workspace directory bootstrap files (override global)
 * 4. Workspace directory extra files
 */
export async function loadWorkspaceBootstrapFiles(
  globalDir?: string,
  workspaceDir?: string
): Promise<WorkspaceContext> {
  const resolvedGlobalDir = globalDir || getGlobalContextDir();
  const resolvedWorkspaceDir = workspaceDir || getAgentDir();

  const files: WorkspaceFile[] = [];

  // Load from global directory (priority 0-99)
  const globalBootstrap = await loadBootstrapFromDir(resolvedGlobalDir, 'global', 0);
  files.push(...globalBootstrap);

  const globalExtra = await loadExtraFiles(resolvedGlobalDir, 'global', 50);
  files.push(...globalExtra);

  // Load from workspace directory (priority 100+)
  const workspaceBootstrap = await loadBootstrapFromDir(resolvedWorkspaceDir, 'workspace', 100);
  files.push(...workspaceBootstrap);

  const workspaceExtra = await loadExtraFiles(resolvedWorkspaceDir, 'workspace', 150);
  files.push(...workspaceExtra);

  // Build context
  const context: WorkspaceContext = {
    files,
    workspaceDir: resolvedWorkspaceDir,
    globalDir: resolvedGlobalDir,
  };

  // Parse identity if present
  const identityFile = files.find(
    f => f.filename.toLowerCase() === 'identity.md' && !f.missing
  );
  if (identityFile) {
    context.identity = parseIdentity(identityFile.content);
  }

  // Parse user info if present
  const userFile = files.find(
    f => f.filename.toLowerCase() === 'user.md' && !f.missing
  );
  if (userFile) {
    context.userInfo = parseUserInfo(userFile.content);
  }

  // Log workspace files loaded
  const logger = getLogger();
  const fileInfos: WorkspaceFileInfo[] = files.map(f => ({
    name: f.name,
    path: f.path,
    loaded: !f.missing,
    source: f.source,
  }));
  logger.workspaceLoaded(fileInfos);

  return context;
}

/**
 * Handle BOOTSTRAP.md - run once and delete
 */
export async function processBootstrapFile(context: WorkspaceContext): Promise<{
  content: string | null;
  deleted: boolean;
}> {
  const bootstrapFile = context.files.find(
    f => f.filename.toLowerCase() === 'bootstrap.md' && !f.missing
  );

  if (!bootstrapFile) {
    return { content: null, deleted: false };
  }

  // Mark as processed by deleting
  try {
    await unlink(bootstrapFile.path);
    return { content: bootstrapFile.content, deleted: true };
  } catch {
    return { content: bootstrapFile.content, deleted: false };
  }
}

/**
 * Get a summary of loaded context for display
 */
export function getWorkspaceSummary(context: WorkspaceContext): string {
  const loaded = context.files.filter(f => !f.missing);

  if (loaded.length === 0) {
    return 'No context files loaded';
  }

  const parts: string[] = [];

  if (context.identity) {
    const emoji = context.identity.emoji || '';
    parts.push(`${emoji} ${context.identity.name}`.trim());
  }

  if (context.userInfo?.name) {
    parts.push(`User: ${context.userInfo.name}`);
  }

  const fileCount = loaded.length;
  const sources = new Set(loaded.map(f => f.source));
  const sourceStr = sources.size === 2 ? 'global+workspace' : [...sources][0];

  parts.push(`${fileCount} files (${sourceStr})`);

  return parts.join(' | ');
}

/**
 * Reload workspace context
 */
export async function reloadWorkspace(
  currentContext?: WorkspaceContext
): Promise<WorkspaceContext> {
  return loadWorkspaceBootstrapFiles(
    currentContext?.globalDir,
    currentContext?.workspaceDir
  );
}

// Re-export types
export * from './types.js';
