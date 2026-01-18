/**
 * Skills Registry - Manage and query loaded skills
 */

import type { SkillEntry, SkillMetadata } from './types.js';
import { loadSkillsWithPrecedence, getSkillsByTrigger } from './loader.js';

/**
 * Skills Registry class
 */
export class SkillsRegistry {
  private skills: Map<string, SkillEntry> = new Map();
  private triggerIndex: Map<string, Set<string>> = new Map();

  /**
   * Register a skill
   */
  register(skill: SkillEntry): void {
    const key = skill.name.toLowerCase();
    this.skills.set(key, skill);

    // Index triggers
    if (skill.metadata?.triggers) {
      for (const trigger of skill.metadata.triggers) {
        const triggerKey = trigger.toLowerCase();
        if (!this.triggerIndex.has(triggerKey)) {
          this.triggerIndex.set(triggerKey, new Set());
        }
        this.triggerIndex.get(triggerKey)!.add(key);
      }
    }
  }

  /**
   * Register multiple skills
   */
  registerAll(skills: SkillEntry[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /**
   * Get a skill by name
   */
  get(name: string): SkillEntry | undefined {
    return this.skills.get(name.toLowerCase());
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name.toLowerCase());
  }

  /**
   * Get all skills
   */
  getAll(): SkillEntry[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skills by trigger keyword
   */
  getByTrigger(trigger: string): SkillEntry[] {
    const triggerKey = trigger.toLowerCase();
    const matchingKeys = this.triggerIndex.get(triggerKey);

    if (!matchingKeys) {
      // Try partial match
      return this.getAll().filter(skill =>
        skill.metadata?.triggers?.some(t =>
          t.toLowerCase().includes(triggerKey) ||
          triggerKey.includes(t.toLowerCase())
        )
      );
    }

    return Array.from(matchingKeys)
      .map(key => this.skills.get(key))
      .filter((s): s is SkillEntry => s !== undefined);
  }

  /**
   * Get skills by tag
   */
  getByTag(tag: string): SkillEntry[] {
    const tagLower = tag.toLowerCase();
    return this.getAll().filter(skill =>
      skill.metadata?.tags?.some(t => t.toLowerCase() === tagLower)
    );
  }

  /**
   * Get auto-invokable skills
   */
  getAutoSkills(): SkillEntry[] {
    return this.getAll().filter(
      s => !s.metadata?.invocation || s.metadata.invocation === 'auto'
    );
  }

  /**
   * Get manual-only skills
   */
  getManualSkills(): SkillEntry[] {
    return this.getAll().filter(s => s.metadata?.invocation === 'manual');
  }

  /**
   * Get skills count
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Clear all skills
   */
  clear(): void {
    this.skills.clear();
    this.triggerIndex.clear();
  }

  /**
   * Remove a skill
   */
  remove(name: string): boolean {
    const key = name.toLowerCase();
    const skill = this.skills.get(key);

    if (!skill) return false;

    // Remove from trigger index
    if (skill.metadata?.triggers) {
      for (const trigger of skill.metadata.triggers) {
        const triggerKey = trigger.toLowerCase();
        this.triggerIndex.get(triggerKey)?.delete(key);
      }
    }

    return this.skills.delete(key);
  }

  /**
   * Build skills prompt content for system message
   */
  buildSkillsPrompt(): string {
    const skills = this.getAll();
    if (skills.length === 0) return '';

    const autoSkills = this.getAutoSkills();
    const manualSkills = this.getManualSkills();

    const parts: string[] = ['<skills>'];

    if (autoSkills.length > 0) {
      parts.push('<!-- Auto-invoked skills (use when relevant) -->');
      for (const skill of autoSkills) {
        parts.push(`<skill name="${skill.name}">`);
        if (skill.metadata?.triggers?.length) {
          parts.push(`  <!-- Triggers: ${skill.metadata.triggers.join(', ')} -->`);
        }
        parts.push(`  ${skill.description}`);
        parts.push('</skill>');
      }
    }

    if (manualSkills.length > 0) {
      parts.push('\n<!-- Manual skills (user must invoke with /) -->');
      for (const skill of manualSkills) {
        parts.push(`<skill name="${skill.name}" invocation="manual">`);
        parts.push(`  ${skill.description}`);
        parts.push('</skill>');
      }
    }

    parts.push('</skills>');
    return parts.join('\n');
  }

  /**
   * Get a summary of skills for display
   */
  getSummary(): string {
    const skills = this.getAll();
    if (skills.length === 0) return 'No skills loaded';

    const bySource = new Map<string, number>();
    for (const skill of skills) {
      const count = bySource.get(skill.source) || 0;
      bySource.set(skill.source, count + 1);
    }

    const parts = [`${skills.length} skills`];
    for (const [source, count] of bySource) {
      parts.push(`${count} ${source}`);
    }

    return parts.join(', ');
  }

  /**
   * List skills for CLI display
   */
  listForDisplay(): { name: string; description: string; source: string; invocation: string }[] {
    return this.getAll().map(skill => ({
      name: skill.name,
      description: skill.description.slice(0, 60) + (skill.description.length > 60 ? '...' : ''),
      source: skill.source,
      invocation: skill.metadata?.invocation || 'auto',
    }));
  }

  /**
   * Export skills as JSON
   */
  export(): object {
    return {
      count: this.size,
      skills: this.getAll().map(s => ({
        name: s.name,
        description: s.description,
        source: s.source,
        path: s.path,
        metadata: s.metadata,
      })),
    };
  }
}

/**
 * Load and create a registry with all skills
 */
export async function createSkillsRegistry(
  workspaceSkillsDir?: string
): Promise<SkillsRegistry> {
  const registry = new SkillsRegistry();
  const skills = await loadSkillsWithPrecedence(workspaceSkillsDir);
  registry.registerAll(skills);
  return registry;
}

/**
 * Global skills registry instance
 */
export const globalSkillsRegistry = new SkillsRegistry();
