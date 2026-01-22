/**
 * Project Manager - Handles project discovery, loading, and switching
 */

import { readFile, writeFile, readdir, stat, mkdir, access } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getDB, createLogger } from '../db/index.js';
import type { Channel } from '../db/types.js';
import {
  type ProjectConfig,
  type ProjectState,
  type ProjectSummary,
  DEFAULT_PROJECT_CONFIG,
  PROJECT_FILES,
} from './types.js';

/**
 * Default projects root directory
 * Defaults to ~/clawd, can be overridden with LOCALBOT_PROJECTS_DIR
 */
function getDefaultProjectsRoot(): string {
  return process.env.LOCALBOT_PROJECTS_DIR || join(homedir(), 'clawd');
}

/**
 * Default global context directory (for fallback)
 */
function getGlobalContextDir(): string {
  return process.env.LOCALBOT_CONTEXT_DIR || process.env.CONTEXT_DIR || join(homedir(), 'clawd');
}

/**
 * Project Manager class
 */
export class ProjectManager {
  private projectsRoot: string;
  private globalContextDir: string;
  private channel: Channel;
  private currentProject: ProjectState | null = null;
  private logger = createLogger('system');

  constructor(options: {
    projectsRoot?: string;
    globalContextDir?: string;
    channel?: Channel;
  } = {}) {
    this.projectsRoot = options.projectsRoot || getDefaultProjectsRoot();
    this.globalContextDir = options.globalContextDir || getGlobalContextDir();
    this.channel = options.channel || 'system';
    this.logger = createLogger(this.channel);
  }

  /**
   * Get the projects root directory
   */
  getProjectsRoot(): string {
    return this.projectsRoot;
  }

  /**
   * Get the global context directory
   */
  getGlobalContextDir(): string {
    return this.globalContextDir;
  }

  /**
   * List all available projects
   */
  async listProjects(): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];

    // Ensure projects directory exists
    if (!existsSync(this.projectsRoot)) {
      await mkdir(this.projectsRoot, { recursive: true });
      return projects;
    }

    const entries = await readdir(this.projectsRoot, { withFileTypes: true });
    const activeProject = this.currentProject?.config.name;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const projectPath = join(this.projectsRoot, entry.name);
      const configPath = join(projectPath, PROJECT_FILES.config);

      let config: Partial<ProjectConfig> = {};
      let hasConfig = false;

      try {
        const content = await readFile(configPath, 'utf-8');
        config = JSON.parse(content);
        hasConfig = true;
      } catch {
        // No config file - use directory name
      }

      projects.push({
        name: entry.name,
        displayName: config.displayName || entry.name,
        description: config.description,
        path: projectPath,
        hasConfig,
        isActive: entry.name === activeProject,
      });
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get a project by name
   */
  async getProject(name: string): Promise<ProjectState | null> {
    const projectPath = join(this.projectsRoot, name);

    if (!existsSync(projectPath)) {
      return null;
    }

    return this.loadProject(projectPath);
  }

  /**
   * Load a project from a path
   */
  async loadProject(projectPath: string): Promise<ProjectState> {
    const absolutePath = resolve(projectPath);
    const name = basename(absolutePath);

    // Load or create config
    let config: ProjectConfig = { name, ...DEFAULT_PROJECT_CONFIG };
    const configPath = join(absolutePath, PROJECT_FILES.config);

    try {
      const content = await readFile(configPath, 'utf-8');
      config = { ...config, ...JSON.parse(content) };
    } catch {
      // No config file - use defaults
    }

    // Resolve paths
    const workingDirPath = config.workingDir
      ? resolve(absolutePath, config.workingDir)
      : absolutePath;

    const memoryDirPath = config.memory?.dir
      ? resolve(absolutePath, config.memory.dir)
      : join(absolutePath, 'memory');

    const skillsDirPath = join(absolutePath, 'skills');

    // Check for local files
    const hasLocalIdentity = existsSync(join(absolutePath, PROJECT_FILES.identity)) ||
                             existsSync(join(absolutePath, PROJECT_FILES.soul));
    const hasLocalSkills = existsSync(skillsDirPath);

    const state: ProjectState = {
      config,
      rootPath: absolutePath,
      workingDirPath,
      memoryDirPath,
      skillsDirPath,
      hasLocalIdentity,
      hasLocalSkills,
      loadedAt: Date.now(),
    };

    return state;
  }

  /**
   * Set the current active project
   */
  async setActiveProject(nameOrPath: string): Promise<ProjectState> {
    let project: ProjectState | null;

    // Check if it's a path or a name
    if (nameOrPath.includes('/') || nameOrPath.includes('\\')) {
      project = await this.loadProject(nameOrPath);
    } else {
      project = await this.getProject(nameOrPath);
    }

    if (!project) {
      throw new Error(`Project not found: ${nameOrPath}`);
    }

    this.currentProject = project;

    // Store in database
    const db = getDB();
    db.logEvent({
      event_type: 'session.model_changed',
      channel: this.channel,
      session_id: null,
      user_id: null,
      level: 'info',
      message: `Switched to project: ${project.config.name}`,
      data: JSON.stringify({ projectName: project.config.name, projectPath: project.rootPath }),
    });

    this.logger.info('session.loaded', `Project loaded: ${project.config.name}`, {
      project: project.config.name,
      path: project.rootPath,
    });

    return project;
  }

  /**
   * Get the current active project
   */
  getActiveProject(): ProjectState | null {
    return this.currentProject;
  }

  /**
   * Get the effective working directory
   */
  getWorkingDir(): string {
    if (this.currentProject) {
      return this.currentProject.workingDirPath;
    }
    return this.globalContextDir;
  }

  /**
   * Get the effective context directory (for loading identity files)
   */
  getContextDir(): string {
    if (this.currentProject) {
      return this.currentProject.rootPath;
    }
    return this.globalContextDir;
  }

  /**
   * Get the effective memory directory
   */
  getMemoryDir(): string {
    if (this.currentProject) {
      return this.currentProject.memoryDirPath;
    }
    return join(this.globalContextDir, 'memory');
  }

  /**
   * Get the effective skills directory
   */
  getSkillsDir(): string {
    if (this.currentProject) {
      return this.currentProject.skillsDirPath;
    }
    return join(this.globalContextDir, 'skills');
  }

  /**
   * Get all skills directories to load (project + global)
   */
  getSkillsDirs(): string[] {
    const dirs: string[] = [];

    // Global skills first (lower priority)
    const globalSkills = join(this.globalContextDir, 'skills');
    if (existsSync(globalSkills)) {
      dirs.push(globalSkills);
    }

    // Project skills (higher priority)
    if (this.currentProject?.hasLocalSkills) {
      dirs.push(this.currentProject.skillsDirPath);
    }

    return dirs;
  }

  /**
   * Get the default model for the current context
   */
  getDefaultModel(fallback: string): string {
    if (this.currentProject?.config.model) {
      return this.currentProject.config.model;
    }
    return fallback;
  }

  /**
   * Create a new project
   */
  async createProject(name: string, options: Partial<ProjectConfig> = {}): Promise<ProjectState> {
    const projectPath = join(this.projectsRoot, name);

    if (existsSync(projectPath)) {
      throw new Error(`Project already exists: ${name}`);
    }

    // Create project directory
    await mkdir(projectPath, { recursive: true });

    // Create subdirectories
    await mkdir(join(projectPath, 'memory'), { recursive: true });
    await mkdir(join(projectPath, 'skills'), { recursive: true });

    // Create config file
    const config: ProjectConfig = {
      name,
      displayName: options.displayName || name,
      description: options.description,
      model: options.model,
      ...DEFAULT_PROJECT_CONFIG,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await writeFile(
      join(projectPath, PROJECT_FILES.config),
      JSON.stringify(config, null, 2),
      'utf-8'
    );

    // Create README
    const readme = `# ${config.displayName || name}

${config.description || 'A LocalBot project.'}

## Structure

- \`project.json\` - Project configuration
- \`memory/\` - Project-specific memory files
- \`skills/\` - Project-specific skills
- \`IDENTITY.md\` - Optional: Project-specific identity
- \`SOUL.md\` - Optional: Project-specific personality

## Usage

Switch to this project in the terminal:
\`\`\`
/project ${name}
\`\`\`
`;

    await writeFile(join(projectPath, PROJECT_FILES.readme), readme, 'utf-8');

    this.logger.info('session.created', `Project created: ${name}`, { project: name });

    return this.loadProject(projectPath);
  }

  /**
   * Save the current project config
   */
  async saveProjectConfig(): Promise<void> {
    if (!this.currentProject) {
      throw new Error('No active project');
    }

    const config = {
      ...this.currentProject.config,
      updatedAt: Date.now(),
    };

    await writeFile(
      join(this.currentProject.rootPath, PROJECT_FILES.config),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
  }

  /**
   * Update the current project config
   */
  async updateProjectConfig(updates: Partial<ProjectConfig>): Promise<void> {
    if (!this.currentProject) {
      throw new Error('No active project');
    }

    this.currentProject.config = {
      ...this.currentProject.config,
      ...updates,
      updatedAt: Date.now(),
    };

    await this.saveProjectConfig();
  }

  /**
   * Clear the active project (return to global context)
   */
  clearActiveProject(): void {
    const previousProject = this.currentProject?.config.name;
    this.currentProject = null;

    if (previousProject) {
      this.logger.info('session.cleared', `Project cleared: ${previousProject}`, {
        previousProject,
      });
    }
  }

  /**
   * Get project info string for display
   */
  getProjectInfo(): string {
    if (!this.currentProject) {
      return `Global context (${this.globalContextDir})`;
    }

    const p = this.currentProject;
    const name = p.config.displayName || p.config.name;
    return `${name} (${p.rootPath})`;
  }

  /**
   * Get a summary of the current context for the system prompt
   */
  getContextSummary(): string {
    if (!this.currentProject) {
      return 'Working in global context.';
    }

    const p = this.currentProject;
    const parts = [
      `Project: ${p.config.displayName || p.config.name}`,
    ];

    if (p.config.description) {
      parts.push(`Description: ${p.config.description}`);
    }

    parts.push(`Working directory: ${p.workingDirPath}`);

    if (p.config.identity?.role) {
      parts.push(`Role: ${p.config.identity.role}`);
    }

    return parts.join('\n');
  }
}

// Global project manager instance (lazy initialized per channel)
const projectManagers = new Map<Channel, ProjectManager>();

/**
 * Get or create a project manager for a channel
 */
export function getProjectManager(channel: Channel = 'system'): ProjectManager {
  let manager = projectManagers.get(channel);

  if (!manager) {
    manager = new ProjectManager({ channel });
    projectManagers.set(channel, manager);
  }

  return manager;
}

/**
 * Initialize project manager with custom options
 */
export function initProjectManager(channel: Channel, options: {
  projectsRoot?: string;
  globalContextDir?: string;
}): ProjectManager {
  const manager = new ProjectManager({ ...options, channel });
  projectManagers.set(channel, manager);
  return manager;
}
