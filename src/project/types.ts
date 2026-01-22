/**
 * Project Types - Configuration and state for LocalBot projects
 */

/**
 * Project configuration stored in project.json
 */
export interface ProjectConfig {
  /** Project name (directory name) */
  name: string;

  /** Display name for the project */
  displayName?: string;

  /** Project description */
  description?: string;

  /** Working directory for file operations (defaults to project root) */
  workingDir?: string;

  /** Default model for this project */
  model?: string;

  /** Project-specific environment variables */
  env?: Record<string, string>;

  /** Skills to load (in addition to global) */
  skills?: string[];

  /** Tools to enable (defaults to 'all') */
  tools?: 'all' | 'safe' | 'core' | string[];

  /** Memory settings */
  memory?: {
    /** Enable project-scoped memory */
    enabled?: boolean;
    /** Directory for memory files (relative to project root) */
    dir?: string;
  };

  /** Identity overrides */
  identity?: {
    /** Name to use for this project */
    name?: string;
    /** Emoji for this project */
    emoji?: string;
    /** Role description */
    role?: string;
  };

  /** Telegram settings */
  telegram?: {
    /** Allowed chat IDs (if restricted) */
    allowedChats?: number[];
  };

  /** Created timestamp */
  createdAt?: number;

  /** Last updated timestamp */
  updatedAt?: number;
}

/**
 * Runtime project state
 */
export interface ProjectState {
  /** Current project config */
  config: ProjectConfig;

  /** Absolute path to project root */
  rootPath: string;

  /** Absolute path to working directory */
  workingDirPath: string;

  /** Absolute path to memory directory */
  memoryDirPath: string;

  /** Absolute path to skills directory */
  skillsDirPath: string;

  /** Whether project has local identity files */
  hasLocalIdentity: boolean;

  /** Whether project has local skills */
  hasLocalSkills: boolean;

  /** When this project was loaded */
  loadedAt: number;
}

/**
 * Project summary for listing
 */
export interface ProjectSummary {
  name: string;
  displayName: string;
  description?: string;
  path: string;
  hasConfig: boolean;
  isActive: boolean;
}

/**
 * Active project info stored in database
 */
export interface ActiveProjectRecord {
  channel: 'terminal' | 'telegram' | 'gateway';
  projectName: string;
  setAt: number;
}

/**
 * Default project configuration
 */
export const DEFAULT_PROJECT_CONFIG: Partial<ProjectConfig> = {
  tools: 'all',
  memory: {
    enabled: true,
    dir: 'memory',
  },
};

/**
 * Project file names
 */
export const PROJECT_FILES = {
  config: 'project.json',
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  tools: 'TOOLS.md',
  readme: 'README.md',
} as const;
