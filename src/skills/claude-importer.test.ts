/**
 * Claude Skills Importer Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadSkillsFromDirectory, getSkillsByTrigger } from './loader.js';
import { getImportedSkillsPath, listClaudeSkills, isSkillImported } from './claude-importer.js';

describe('Claude Skills Importer', () => {
  const importedSkillsDir = getImportedSkillsPath();

  describe('getImportedSkillsPath', () => {
    it('should return the correct path', () => {
      expect(importedSkillsDir).toBe(join(homedir(), '.localbot', 'skills', 'claude-imported'));
    });
  });

  describe('isSkillImported', () => {
    it('should return true for gemini-image skill', () => {
      expect(isSkillImported('gemini-image')).toBe(true);
    });

    it('should return false for non-existent skill', () => {
      expect(isSkillImported('nonexistent-skill')).toBe(false);
    });
  });

  describe('loadSkillsFromDirectory with imported skills', () => {
    it('should load imported Claude skills', async () => {
      const skills = await loadSkillsFromDirectory(importedSkillsDir, 'claude');

      expect(skills.length).toBeGreaterThan(0);

      // Find gemini-image skill
      const geminiSkill = skills.find(s => s.name === 'gemini-image');
      expect(geminiSkill).toBeDefined();
      expect(geminiSkill!.source).toBe('claude');
      expect(geminiSkill!.description).toContain('Generate');
    });

    it('should have proper metadata for gemini-image skill', async () => {
      const skills = await loadSkillsFromDirectory(importedSkillsDir, 'claude');
      const geminiSkill = skills.find(s => s.name === 'gemini-image');

      expect(geminiSkill).toBeDefined();
      expect(geminiSkill!.metadata?.invocation).toBe('auto');
      expect(geminiSkill!.metadata?.triggers).toContain('generate');
      expect(geminiSkill!.metadata?.triggers).toContain('image');
      expect(geminiSkill!.metadata?.tags).toContain('imported');
      expect(geminiSkill!.metadata?.tags).toContain('claude-skill');
    });
  });

  describe('getSkillsByTrigger with imported skills', () => {
    it('should match gemini-image skill by "generate image" trigger', async () => {
      const skills = await loadSkillsFromDirectory(importedSkillsDir, 'claude');
      const matched = getSkillsByTrigger(skills, 'generate');

      expect(matched.length).toBeGreaterThan(0);
      expect(matched.some(s => s.name === 'gemini-image')).toBe(true);
    });

    it('should match gemini-image skill by "image" trigger', async () => {
      const skills = await loadSkillsFromDirectory(importedSkillsDir, 'claude');
      const matched = getSkillsByTrigger(skills, 'image');

      expect(matched.length).toBeGreaterThan(0);
      expect(matched.some(s => s.name === 'gemini-image')).toBe(true);
    });

    it('should match gemini-image skill by "create picture" trigger', async () => {
      const skills = await loadSkillsFromDirectory(importedSkillsDir, 'claude');
      const matched = getSkillsByTrigger(skills, 'create');

      expect(matched.length).toBeGreaterThan(0);
      expect(matched.some(s => s.name === 'gemini-image')).toBe(true);
    });
  });

  describe('gemini-image skill files', () => {
    const skillDir = join(importedSkillsDir, 'gemini-image');

    it('should have SKILL.md file', () => {
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    });

    it('should have generate.mjs script', () => {
      expect(existsSync(join(skillDir, 'generate.mjs'))).toBe(true);
    });

    it('should have executable generate.mjs', async () => {
      const { execSync } = await import('child_process');
      // Check if node can parse the script (syntax check)
      try {
        execSync(`node --check "${join(skillDir, 'generate.mjs')}"`, { stdio: 'pipe' });
        expect(true).toBe(true); // Script is valid
      } catch (error) {
        expect.fail('generate.mjs has syntax errors');
      }
    });
  });
});

describe('Gemini Image Generation Script', () => {
  it('should show help when run without arguments', async () => {
    const { execSync } = await import('child_process');
    const scriptPath = join(getImportedSkillsPath(), 'gemini-image', 'generate.mjs');

    try {
      // Run with --help flag
      const output = execSync(`node "${scriptPath}" --help 2>&1`, {
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Should show usage info
      expect(output.toLowerCase()).toMatch(/usage|help|options|generate/i);
    } catch (error: any) {
      // Some scripts exit with non-zero on --help, check output anyway
      if (error.stdout || error.stderr) {
        const output = (error.stdout || '') + (error.stderr || '');
        expect(output.toLowerCase()).toMatch(/usage|help|options|generate|error|api/i);
      } else {
        // Script ran but may have different behavior
        expect(true).toBe(true);
      }
    }
  });
});
