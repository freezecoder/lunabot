/**
 * Claude Skills Importer
 * Converts Claude Code skills to LocalBot-compatible format
 */

import { readFile, writeFile, readdir, mkdir, access, copyFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { constants, existsSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { homedir } from 'os';
import { getClaudeSkillsDir, isClaudeSkillsEnabled, getLocalbotHome } from '../config/paths.js';

/**
 * Claude skill frontmatter format
 */
interface ClaudeSkillMeta {
  name: string;
  description: string;
  'allowed-tools'?: string;
}

/**
 * LocalBot skill frontmatter format
 */
interface LocalBotSkillMeta {
  name: string;
  description: string;
  invocation: 'auto' | 'manual' | 'disabled';
  triggers: string[];
  tags: string[];
  source: string;
  imported_from: string;
}

/**
 * Imported skill result
 */
export interface ImportedSkill {
  name: string;
  sourcePath: string;
  targetPath: string;
  success: boolean;
  error?: string;
  hasScript?: boolean;
  scriptPath?: string;
}

/**
 * Parse Claude skill YAML frontmatter
 */
function parseClaudeFrontmatter(content: string): { meta: ClaudeSkillMeta | null; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { meta: null, body: content };
  }

  try {
    const meta = parseYaml(match[1]) as ClaudeSkillMeta;
    return { meta, body: match[2] };
  } catch {
    return { meta: null, body: content };
  }
}

/**
 * Extract triggers from skill content
 */
function extractTriggers(description: string, body: string): string[] {
  const triggers: string[] = [];

  // Extract keywords from description
  const descWords = description.toLowerCase().split(/[,\s]+/);
  const keywords = ['image', 'generate', 'create', 'picture', 'photo', 'enhance', 'illustration'];
  for (const word of descWords) {
    if (keywords.some(k => word.includes(k))) {
      triggers.push(word);
    }
  }

  // Look for "When to Use" section and extract keywords
  const whenToUseMatch = body.match(/## When to Use[\s\S]*?(?=##|$)/i);
  if (whenToUseMatch) {
    const quotedMatches = whenToUseMatch[0].match(/"([^"]+)"/g);
    if (quotedMatches) {
      for (const quoted of quotedMatches.slice(0, 5)) {
        triggers.push(quoted.replace(/"/g, '').toLowerCase());
      }
    }
  }

  return [...new Set(triggers)].slice(0, 10);
}

/**
 * Convert Claude skill to LocalBot format
 */
function convertSkillContent(claudeMeta: ClaudeSkillMeta, body: string, sourcePath: string): string {
  const triggers = extractTriggers(claudeMeta.description, body);

  const localBotMeta: LocalBotSkillMeta = {
    name: claudeMeta.name,
    description: claudeMeta.description,
    invocation: 'auto',
    triggers,
    tags: ['imported', 'claude-skill'],
    source: 'claude',
    imported_from: sourcePath,
  };

  const frontmatter = stringifyYaml(localBotMeta);

  // Add a note about the original skill location
  const note = `
<!--
  Imported from Claude Code skill: ${sourcePath}
  Original allowed-tools: ${claudeMeta['allowed-tools'] || 'not specified'}

  To use this skill, the agent should call the bash commands described below.
-->

`;

  return `---\n${frontmatter}---\n${note}${body}`;
}

/**
 * Get the LocalBot managed skills directory for imported Claude skills
 */
function getImportedSkillsDir(): string {
  return join(getLocalbotHome(), 'skills', 'claude-imported');
}

/**
 * Import a single Claude skill
 */
async function importSingleSkill(skillDir: string): Promise<ImportedSkill> {
  const skillName = basename(skillDir);
  const skillMdPath = join(skillDir, 'SKILL.md');
  const targetDir = join(getImportedSkillsDir(), skillName);
  const targetSkillPath = join(targetDir, 'SKILL.md');

  const result: ImportedSkill = {
    name: skillName,
    sourcePath: skillDir,
    targetPath: targetDir,
    success: false,
  };

  try {
    // Check if SKILL.md exists
    await access(skillMdPath, constants.R_OK);

    // Read the skill content
    const content = await readFile(skillMdPath, 'utf-8');
    const { meta, body } = parseClaudeFrontmatter(content);

    if (!meta) {
      result.error = 'Failed to parse frontmatter';
      return result;
    }

    // Convert to LocalBot format
    const convertedContent = convertSkillContent(meta, body, skillDir);

    // Create target directory
    await mkdir(targetDir, { recursive: true });

    // Write converted skill
    await writeFile(targetSkillPath, convertedContent, 'utf-8');

    // Copy any script files (.mjs, .js, .sh, .py)
    const entries = await readdir(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase();
        if (['mjs', 'js', 'sh', 'py', 'ts'].includes(ext || '')) {
          const srcPath = join(skillDir, entry.name);
          const destPath = join(targetDir, entry.name);
          await copyFile(srcPath, destPath);
          result.hasScript = true;
          result.scriptPath = destPath;
        }
        // Also copy reference files
        if (entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
          const srcPath = join(skillDir, entry.name);
          const destPath = join(targetDir, entry.name);
          await copyFile(srcPath, destPath);
        }
      }
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Import all Claude skills to LocalBot
 */
export async function importClaudeSkills(): Promise<ImportedSkill[]> {
  const results: ImportedSkill[] = [];

  if (!isClaudeSkillsEnabled()) {
    console.log('[Claude Importer] Claude skills disabled');
    return results;
  }

  const claudeSkillsDir = getClaudeSkillsDir();

  try {
    await access(claudeSkillsDir, constants.R_OK);
  } catch {
    console.log(`[Claude Importer] Claude skills directory not found: ${claudeSkillsDir}`);
    return results;
  }

  // Ensure import directory exists
  await mkdir(getImportedSkillsDir(), { recursive: true });

  // Read all skill directories
  const entries = await readdir(claudeSkillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const skillDir = join(claudeSkillsDir, entry.name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      // Check if SKILL.md exists
      if (existsSync(skillMdPath)) {
        const result = await importSingleSkill(skillDir);
        results.push(result);

        if (result.success) {
          console.log(`[Claude Importer] Imported: ${result.name}`);
        } else {
          console.log(`[Claude Importer] Failed to import ${result.name}: ${result.error}`);
        }
      }
    }
  }

  return results;
}

/**
 * Import a specific Claude skill by name
 */
export async function importClaudeSkill(skillName: string): Promise<ImportedSkill | null> {
  const claudeSkillsDir = getClaudeSkillsDir();
  const skillDir = join(claudeSkillsDir, skillName);

  if (!existsSync(skillDir)) {
    return null;
  }

  return importSingleSkill(skillDir);
}

/**
 * List available Claude skills (not yet imported)
 */
export async function listClaudeSkills(): Promise<string[]> {
  const claudeSkillsDir = getClaudeSkillsDir();
  const skills: string[] = [];

  try {
    const entries = await readdir(claudeSkillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const skillMdPath = join(claudeSkillsDir, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          skills.push(entry.name);
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return skills;
}

/**
 * Check if a Claude skill has been imported
 */
export function isSkillImported(skillName: string): boolean {
  const targetPath = join(getImportedSkillsDir(), skillName, 'SKILL.md');
  return existsSync(targetPath);
}

/**
 * Get imported skills directory path
 */
export function getImportedSkillsPath(): string {
  return getImportedSkillsDir();
}
