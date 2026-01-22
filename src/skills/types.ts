/**
 * Skills types for LocalBot
 */

/**
 * Skill invocation mode
 */
export type SkillInvocation = 'auto' | 'manual' | 'disabled';

/**
 * Skill metadata from YAML frontmatter
 */
export interface SkillMetadata {
  invocation?: SkillInvocation;
  triggers?: string[];
  tags?: string[];
  version?: string;
  author?: string;
  priority?: number;
}

/**
 * Skill entry loaded from file
 */
export interface SkillEntry {
  name: string;
  description: string;
  content: string;
  path: string;
  source: 'bundled' | 'managed' | 'workspace' | 'extra' | 'claude';
  metadata?: SkillMetadata;
  /** If true, this skill should not be modified by the bot */
  readOnly?: boolean;
}

/**
 * Skill source directory configuration
 */
export interface SkillSourceConfig {
  path: string;
  source: SkillEntry['source'];
  priority: number;  // Higher = loaded later = overrides
  /** If true, skills from this source should not be modified */
  readOnly?: boolean;
}

/**
 * Parse result from skill file
 */
export interface ParsedSkill {
  metadata: SkillMetadata;
  body: string;
  description: string;
}

/**
 * Default skill metadata
 */
export const DEFAULT_SKILL_METADATA: SkillMetadata = {
  invocation: 'auto',
  triggers: [],
  tags: [],
};
