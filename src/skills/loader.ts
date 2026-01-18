/**
 * Skills Loader - Load skills from directories with proper precedence
 */

import { readFile, readdir, access } from 'fs/promises';
import { join, basename } from 'path';
import { constants } from 'fs';
import { parse as parseYaml } from 'yaml';
import {
  type SkillEntry,
  type SkillMetadata,
  type ParsedSkill,
  type SkillSourceConfig,
  DEFAULT_SKILL_METADATA,
} from './types.js';
import { getSkillsDirs, getLocalbotHome } from '../config/paths.js';

/**
 * Check if directory exists and is readable
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse YAML frontmatter from skill content
 *
 * Format:
 * ---
 * name: skill-name
 * description: Short description
 * invocation: auto
 * triggers:
 *   - keyword1
 *   - keyword2
 * ---
 *
 * # Skill Content
 * ...
 */
export function parseSkillFrontmatter(content: string): ParsedSkill {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter, extract description from first paragraph
    const lines = content.split('\n');
    let description = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        description = trimmed;
        break;
      }
    }

    return {
      metadata: { ...DEFAULT_SKILL_METADATA },
      body: content,
      description: description || 'No description',
    };
  }

  const [, frontmatterYaml, body] = match;

  try {
    const parsed = parseYaml(frontmatterYaml) as Record<string, unknown>;

    const metadata: SkillMetadata = {
      invocation: (parsed.invocation as SkillMetadata['invocation']) || DEFAULT_SKILL_METADATA.invocation,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      version: parsed.version as string | undefined,
      author: parsed.author as string | undefined,
      priority: typeof parsed.priority === 'number' ? parsed.priority : undefined,
    };

    const description = (parsed.description as string) || extractDescription(body);

    return {
      metadata,
      body: body.trim(),
      description,
    };
  } catch (error) {
    // Failed to parse YAML, treat as no frontmatter
    return {
      metadata: { ...DEFAULT_SKILL_METADATA },
      body: content,
      description: extractDescription(content),
    };
  }
}

/**
 * Extract description from skill body (first non-header paragraph)
 */
function extractDescription(body: string): string {
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.slice(0, 200);
    }
  }

  return 'No description';
}

/**
 * Load a single skill file
 */
async function loadSkillFile(
  path: string,
  source: SkillEntry['source']
): Promise<SkillEntry | null> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = parseSkillFrontmatter(content);

    // Use filename as name if not in frontmatter
    const filename = basename(path, '.md');
    const name = filename;

    return {
      name,
      description: parsed.description,
      content: parsed.body,
      path,
      source,
      metadata: parsed.metadata,
    };
  } catch (error) {
    console.warn(`Failed to load skill from ${path}:`, error);
    return null;
  }
}

/**
 * Load all skills from a directory
 */
export async function loadSkillsFromDirectory(
  dirPath: string,
  source: SkillEntry['source'] = 'workspace'
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];

  if (!(await directoryExists(dirPath))) {
    return skills;
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = join(dirPath, entry.name);
      const skill = await loadSkillFile(filePath, source);

      if (skill) {
        skills.push(skill);
      }
    }
  } catch (error) {
    console.warn(`Failed to read skills directory ${dirPath}:`, error);
  }

  return skills;
}

/**
 * Load skills from multiple directories with precedence
 *
 * Order (lowest to highest priority):
 * 1. Extra directories (user-configured)
 * 2. Bundled skills (~/.localbot/skills-bundled/)
 * 3. Managed skills (~/.localbot/skills/)
 * 4. Workspace skills (./skills/)
 */
export async function loadSkillsWithPrecedence(
  workspaceSkillsDir?: string
): Promise<SkillEntry[]> {
  const skillMap = new Map<string, SkillEntry>();

  // Get skill directories from config
  const skillsDirs = getSkillsDirs();
  const localbotHome = getLocalbotHome();

  // Define sources in order of increasing priority
  const sources: SkillSourceConfig[] = [
    // Extra directories (from environment, lowest priority)
    ...(process.env.LOCALBOT_EXTRA_SKILLS_DIRS?.split(':').filter(Boolean) || []).map(
      (path, i) => ({
        path,
        source: 'extra' as const,
        priority: i,
      })
    ),
    // Bundled skills
    {
      path: join(localbotHome, 'skills-bundled'),
      source: 'bundled' as const,
      priority: 50,
    },
    // Managed skills
    {
      path: join(localbotHome, 'skills'),
      source: 'managed' as const,
      priority: 100,
    },
    // Workspace skills (highest priority)
    {
      path: workspaceSkillsDir || './skills',
      source: 'workspace' as const,
      priority: 200,
    },
  ];

  // Load skills in order, letting higher priority override
  for (const config of sources.sort((a, b) => a.priority - b.priority)) {
    const skills = await loadSkillsFromDirectory(config.path, config.source);

    for (const skill of skills) {
      skillMap.set(skill.name.toLowerCase(), skill);
    }
  }

  return Array.from(skillMap.values());
}

/**
 * Load workspace skills only (for quick reload)
 */
export async function loadWorkspaceSkills(
  workspaceDir: string = './skills'
): Promise<SkillEntry[]> {
  return loadSkillsFromDirectory(workspaceDir, 'workspace');
}

/**
 * Get skills that match a trigger
 */
export function getSkillsByTrigger(
  skills: SkillEntry[],
  trigger: string
): SkillEntry[] {
  const triggerLower = trigger.toLowerCase();

  return skills.filter(skill => {
    if (!skill.metadata?.triggers) return false;

    return skill.metadata.triggers.some(t =>
      t.toLowerCase().includes(triggerLower) ||
      triggerLower.includes(t.toLowerCase())
    );
  });
}

/**
 * Get auto-invokable skills
 */
export function getAutoSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter(
    s => !s.metadata?.invocation || s.metadata.invocation === 'auto'
  );
}

/**
 * Get manual-only skills
 */
export function getManualSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter(s => s.metadata?.invocation === 'manual');
}
