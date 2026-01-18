/**
 * Path configuration for LocalBot
 * Resolves paths with environment variable overrides
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Default LocalBot home directory
 */
export function getLocalbotHome(): string {
  return process.env.LOCALBOT_HOME || join(homedir(), '.localbot');
}

/**
 * Session storage directory
 */
export function getSessionsDir(): string {
  return process.env.LOCALBOT_SESSIONS_DIR || join(getLocalbotHome(), 'sessions');
}

/**
 * Skills directories with precedence
 */
export function getSkillsDirs(): string[] {
  const dirs: string[] = [];

  // Extra directories from environment (lowest priority)
  const extraDirs = process.env.LOCALBOT_EXTRA_SKILLS_DIRS;
  if (extraDirs) {
    dirs.push(...extraDirs.split(':').filter(Boolean));
  }

  // Bundled skills
  dirs.push(join(getLocalbotHome(), 'skills-bundled'));

  // Managed skills
  dirs.push(join(getLocalbotHome(), 'skills'));

  // Workspace skills (highest priority) - added by caller
  return dirs;
}

/**
 * Memory database directory
 */
export function getMemoryDir(): string {
  return process.env.LOCALBOT_MEMORY_DIR || join(getLocalbotHome(), 'memory');
}

/**
 * Context/workspace directory
 */
export function getGlobalContextDir(): string {
  return process.env.LOCALBOT_CONTEXT_DIR || process.env.CONTEXT_DIR || join(homedir(), 'clawd');
}

/**
 * Agent-local directory
 */
export function getAgentDir(): string {
  return process.env.LOCALBOT_AGENT_DIR || process.env.AGENT_DIR || './agent';
}

/**
 * Cache directory for temporary files
 */
export function getCacheDir(): string {
  return process.env.LOCALBOT_CACHE_DIR || join(getLocalbotHome(), 'cache');
}

/**
 * Log directory
 */
export function getLogsDir(): string {
  return process.env.LOCALBOT_LOGS_DIR || join(getLocalbotHome(), 'logs');
}

/**
 * Session cache TTL in milliseconds
 */
export function getSessionCacheTtl(): number {
  const ttl = process.env.LOCALBOT_SESSION_CACHE_TTL_MS;
  return ttl ? parseInt(ttl, 10) : 45000; // 45 seconds default
}

/**
 * Resolve a path relative to LocalBot home
 */
export function resolvePath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('$HOME/')) {
    return join(homedir(), path.slice(6));
  }
  if (path.startsWith('$LOCALBOT_HOME/')) {
    return join(getLocalbotHome(), path.slice(15));
  }
  return path;
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(dir, { recursive: true });
}

/**
 * All path configuration
 */
export const paths = {
  get home() { return getLocalbotHome(); },
  get sessions() { return getSessionsDir(); },
  get memory() { return getMemoryDir(); },
  get globalContext() { return getGlobalContextDir(); },
  get agentDir() { return getAgentDir(); },
  get cache() { return getCacheDir(); },
  get logs() { return getLogsDir(); },
  get skillsDirs() { return getSkillsDirs(); },
  sessionCacheTtl: getSessionCacheTtl,
  resolve: resolvePath,
  ensureDir,
};

export default paths;
