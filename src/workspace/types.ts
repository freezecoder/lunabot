/**
 * Workspace types for LocalBot identity/persona system
 */

/**
 * Bootstrap file names in load order (lowest to highest priority for overrides)
 */
export const BOOTSTRAP_FILES = [
  'AGENTS.md',      // Workspace overview & safety defaults
  'SOUL.md',        // Persona & boundaries (tone, rules, voice)
  'TOOLS.md',       // User notes about external tools
  'IDENTITY.md',    // Agent identity (Name, Creature, Vibe, Emoji)
  'USER.md',        // User profile (name, timezone, pronouns)
  'HEARTBEAT.md',   // Optional heartbeat checklist
  'BOOTSTRAP.md',   // One-time setup ritual (deleted after use)
] as const;

/**
 * Files that should be included for subagents (minimal context)
 */
export const SUBAGENT_FILES = ['AGENTS.md', 'TOOLS.md'] as const;

/**
 * Workspace file loaded from disk
 */
export interface WorkspaceFile {
  name: string;           // File name without .md extension
  filename: string;       // Full filename (e.g., IDENTITY.md)
  path: string;           // Full path to file
  content: string;        // File content
  missing: boolean;       // True if file doesn't exist
  source: 'global' | 'workspace';  // Where the file came from
  priority: number;       // Load order priority (higher = loaded later = overrides)
}

/**
 * Complete workspace context
 */
export interface WorkspaceContext {
  files: WorkspaceFile[];
  workspaceDir: string;
  globalDir: string;
  identity?: IdentityInfo;
  userInfo?: UserInfo;
}

/**
 * Parsed identity information from IDENTITY.md
 */
export interface IdentityInfo {
  name: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
  raw: string;
}

/**
 * Parsed user information from USER.md
 */
export interface UserInfo {
  name?: string;
  timezone?: string;
  pronouns?: string;
  raw: string;
}

/**
 * Parse identity information from IDENTITY.md content
 */
export function parseIdentity(content: string): IdentityInfo {
  const lines = content.split('\n');
  const info: IdentityInfo = {
    name: 'LocalBot',
    raw: content,
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const getValue = () => line.split(':').slice(1).join(':').trim();

    if (lower.includes('name:')) {
      info.name = getValue() || info.name;
    } else if (lower.includes('creature:')) {
      info.creature = getValue();
    } else if (lower.includes('vibe:')) {
      info.vibe = getValue();
    } else if (lower.includes('emoji:')) {
      info.emoji = getValue();
    }
  }

  return info;
}

/**
 * Parse user information from USER.md content
 */
export function parseUserInfo(content: string): UserInfo {
  const lines = content.split('\n');
  const info: UserInfo = {
    raw: content,
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const getValue = () => line.split(':').slice(1).join(':').trim();

    if (lower.includes('name:')) {
      info.name = getValue();
    } else if (lower.includes('timezone:')) {
      info.timezone = getValue();
    } else if (lower.includes('pronouns:')) {
      info.pronouns = getValue();
    }
  }

  return info;
}

/**
 * Get the effective file from workspace context (handles overrides)
 */
export function getEffectiveFile(
  context: WorkspaceContext,
  filename: string
): WorkspaceFile | undefined {
  // Return highest priority file with this name
  return context.files
    .filter(f => f.filename.toLowerCase() === filename.toLowerCase() && !f.missing)
    .sort((a, b) => b.priority - a.priority)[0];
}

/**
 * Get all effective files (with overrides applied)
 */
export function getEffectiveFiles(context: WorkspaceContext): WorkspaceFile[] {
  const fileMap = new Map<string, WorkspaceFile>();

  // Process in order, letting higher priority override
  for (const file of context.files.sort((a, b) => a.priority - b.priority)) {
    if (!file.missing) {
      fileMap.set(file.filename.toLowerCase(), file);
    }
  }

  return Array.from(fileMap.values())
    .sort((a, b) => BOOTSTRAP_FILES.indexOf(a.filename as any) - BOOTSTRAP_FILES.indexOf(b.filename as any));
}

/**
 * Filter files for subagent context (minimal set)
 */
export function filterForSubagent(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.filter(f =>
    SUBAGENT_FILES.includes(f.filename as any)
  );
}
