/**
 * Path configuration for LocalBot
 * Resolves paths with environment variable overrides
 * Integrates with project system for project-aware paths
 */

import { homedir } from 'os';
import { join } from 'path';
import type { ProjectState } from '../project/types.js';

// Forward reference to avoid circular dependency
interface ProjectManagerLike {
  getActiveProject(): ProjectState | null;
}

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
 * Claude Code skills directory
 * Default: ~/.claude/skills
 * Can be overridden with LOCALBOT_CLAUDE_SKILLS_DIR
 */
export function getClaudeSkillsDir(): string {
  return process.env.LOCALBOT_CLAUDE_SKILLS_DIR || join(homedir(), '.claude', 'skills');
}

/**
 * Check if Claude skills loading is enabled
 * Default: true
 * Can be disabled with LOCALBOT_CLAUDE_SKILLS_ENABLED=false
 */
export function isClaudeSkillsEnabled(): boolean {
  const enabled = process.env.LOCALBOT_CLAUDE_SKILLS_ENABLED;
  if (enabled === undefined || enabled === '') return true;
  return enabled.toLowerCase() !== 'false' && enabled !== '0';
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
 * Get the default projects root directory
 * Defaults to ~/clawd, can be overridden with LOCALBOT_PROJECTS_DIR
 */
export function getProjectsRoot(): string {
  return process.env.LOCALBOT_PROJECTS_DIR || join(homedir(), 'clawd');
}

/**
 * Project-aware path resolver
 * Returns paths based on active project or falls back to global paths
 */
export class ProjectPaths {
  private projectManager: ProjectManagerLike | null = null;

  setProjectManager(manager: ProjectManagerLike): void {
    this.projectManager = manager;
  }

  getActiveProject(): ProjectState | null {
    return this.projectManager?.getActiveProject() || null;
  }

  /**
   * Get the effective context directory (project root or global context)
   */
  getContextDir(): string {
    const project = this.getActiveProject();
    return project?.rootPath || getGlobalContextDir();
  }

  /**
   * Get the effective working directory
   */
  getWorkingDir(): string {
    const project = this.getActiveProject();
    return project?.workingDirPath || getGlobalContextDir();
  }

  /**
   * Get the effective memory directory
   */
  getMemoryDir(): string {
    const project = this.getActiveProject();
    return project?.memoryDirPath || getMemoryDir();
  }

  /**
   * Get the effective skills directory
   */
  getSkillsDir(): string {
    const project = this.getActiveProject();
    return project?.skillsDirPath || join(getGlobalContextDir(), 'skills');
  }

  /**
   * Get all skills directories to load (project + global)
   */
  getAllSkillsDirs(): string[] {
    const dirs = getSkillsDirs();

    // Add global context skills
    const globalSkills = join(getGlobalContextDir(), 'skills');
    dirs.push(globalSkills);

    // Add project skills if active
    const project = this.getActiveProject();
    if (project?.hasLocalSkills) {
      dirs.push(project.skillsDirPath);
    }

    return dirs;
  }

  /**
   * Get the default model for the current context
   */
  getDefaultModel(fallback: string): string {
    const project = this.getActiveProject();
    return project?.config.model || fallback;
  }

  /**
   * Check if a project is active
   */
  hasActiveProject(): boolean {
    return this.getActiveProject() !== null;
  }

  /**
   * Get project info string for display
   */
  getProjectInfo(): string {
    const project = this.getActiveProject();
    if (!project) {
      return `Global context (${getGlobalContextDir()})`;
    }
    const name = project.config.displayName || project.config.name;
    return `${name} (${project.rootPath})`;
  }
}

// Global project paths instance
export const projectPaths = new ProjectPaths();

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
  get projectsRoot() { return getProjectsRoot(); },
  // Claude skills configuration
  get claudeSkillsDir() { return getClaudeSkillsDir(); },
  get claudeSkillsEnabled() { return isClaudeSkillsEnabled(); },
  sessionCacheTtl: getSessionCacheTtl,
  resolve: resolvePath,
  ensureDir,
  // Project-aware paths
  project: projectPaths,
};

export default paths;
