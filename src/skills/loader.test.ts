/**
 * Skills Loader Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSkillFrontmatter, loadSkillsFromDirectory, getSkillsByTrigger } from './loader.js';
import { useTempDir } from '../../test/helpers/temp-dir.js';

describe('parseSkillFrontmatter', () => {
  it('should parse valid YAML frontmatter', () => {
    const content = `---
name: search-web
description: Search the web for information
invocation: auto
triggers:
  - search
  - lookup
  - find online
tags:
  - web
  - research
---

# Search Web Skill

Instructions for searching the web...
`;

    const result = parseSkillFrontmatter(content);

    expect(result.metadata.invocation).toBe('auto');
    expect(result.metadata.triggers).toEqual(['search', 'lookup', 'find online']);
    expect(result.metadata.tags).toEqual(['web', 'research']);
    expect(result.description).toBe('Search the web for information');
    expect(result.body).toContain('# Search Web Skill');
  });

  it('should handle content without frontmatter', () => {
    const content = `# My Skill

This is a skill without frontmatter.

It has some instructions here.
`;

    const result = parseSkillFrontmatter(content);

    expect(result.metadata.invocation).toBe('auto');
    expect(result.metadata.triggers).toEqual([]);
    expect(result.description).toBe('This is a skill without frontmatter.');
    expect(result.body).toBe(content);
  });

  it('should handle frontmatter with partial metadata', () => {
    const content = `---
invocation: manual
---

# Manual Skill

This skill requires manual invocation.
`;

    const result = parseSkillFrontmatter(content);

    expect(result.metadata.invocation).toBe('manual');
    expect(result.metadata.triggers).toEqual([]);
    expect(result.description).toBe('This skill requires manual invocation.');
  });

  it('should extract description from body when not in frontmatter', () => {
    const content = `---
invocation: auto
---

First line is the description.

# Header comes after
`;

    const result = parseSkillFrontmatter(content);
    expect(result.description).toBe('First line is the description.');
  });

  it('should skip headers when extracting description', () => {
    const content = `---
invocation: auto
---

# Header

Actual description after header.
`;

    const result = parseSkillFrontmatter(content);
    expect(result.description).toBe('Actual description after header.');
  });
});

describe('loadSkillsFromDirectory', () => {
  const tempDir = useTempDir('skills-test-');

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it('should load skills from directory', async () => {
    const dir = await tempDir.setupWithFiles({
      'skill-a.md': `---
description: Skill A description
invocation: auto
---

# Skill A
Content here.
`,
      'skill-b.md': `---
description: Skill B description
invocation: manual
triggers:
  - trigger-b
---

# Skill B
More content.
`,
    });

    const skills = await loadSkillsFromDirectory(dir, 'workspace');

    expect(skills.length).toBe(2);

    const skillA = skills.find(s => s.name === 'skill-a');
    expect(skillA).toBeDefined();
    expect(skillA!.description).toBe('Skill A description');
    expect(skillA!.source).toBe('workspace');

    const skillB = skills.find(s => s.name === 'skill-b');
    expect(skillB).toBeDefined();
    expect(skillB!.metadata?.invocation).toBe('manual');
    expect(skillB!.metadata?.triggers).toContain('trigger-b');
  });

  it('should return empty array for non-existent directory', async () => {
    const skills = await loadSkillsFromDirectory('/nonexistent/path', 'workspace');
    expect(skills).toEqual([]);
  });

  it('should only load .md files', async () => {
    const dir = await tempDir.setupWithFiles({
      'skill.md': '# Valid Skill\nContent',
      'not-a-skill.txt': 'This is not a skill',
      'script.js': 'console.log("not a skill")',
    });

    const skills = await loadSkillsFromDirectory(dir, 'workspace');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('skill');
  });
});

describe('getSkillsByTrigger', () => {
  const skills = [
    {
      name: 'search',
      description: 'Search skill',
      content: '',
      path: '/skills/search.md',
      source: 'workspace' as const,
      metadata: {
        triggers: ['search', 'find', 'lookup'],
      },
    },
    {
      name: 'write',
      description: 'Write skill',
      content: '',
      path: '/skills/write.md',
      source: 'workspace' as const,
      metadata: {
        triggers: ['write', 'create', 'draft'],
      },
    },
    {
      name: 'no-triggers',
      description: 'No triggers',
      content: '',
      path: '/skills/no-triggers.md',
      source: 'workspace' as const,
      metadata: {},
    },
  ];

  it('should find skills by exact trigger', () => {
    const found = getSkillsByTrigger(skills, 'search');
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('search');
  });

  it('should find skills by partial trigger match', () => {
    const found = getSkillsByTrigger(skills, 'look');
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('search');
  });

  it('should return empty array for no matches', () => {
    const found = getSkillsByTrigger(skills, 'nonexistent');
    expect(found.length).toBe(0);
  });

  it('should handle case insensitivity', () => {
    const found = getSkillsByTrigger(skills, 'SEARCH');
    expect(found.length).toBe(1);
  });
});
