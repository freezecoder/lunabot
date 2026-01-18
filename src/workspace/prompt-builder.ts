/**
 * Prompt Builder - Assemble system prompt from workspace context
 */

import {
  type WorkspaceContext,
  type WorkspaceFile,
  getEffectiveFiles,
  filterForSubagent,
  BOOTSTRAP_FILES,
} from './types.js';
import type { SkillEntry } from '../skills/types.js';

/**
 * Format a workspace file for inclusion in system prompt
 */
function formatWorkspaceFile(file: WorkspaceFile): string {
  const header = `<${file.name.toLowerCase()}>`;
  const footer = `</${file.name.toLowerCase()}>`;
  return `${header}\n${file.content.trim()}\n${footer}`;
}

/**
 * Format skills as XML for system prompt
 */
export function formatSkillsForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return '';

  const autoSkills = skills.filter(s => s.metadata?.invocation !== 'manual');
  const manualSkills = skills.filter(s => s.metadata?.invocation === 'manual');

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
    parts.push('<!-- Manual skills (user must invoke with /) -->');
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
 * Build the complete system prompt from workspace context
 */
export function buildSystemPromptWithContext(
  context: WorkspaceContext,
  skills: SkillEntry[] = [],
  toolsSummary: string = ''
): string {
  const parts: string[] = [];

  // Get effective files (with overrides applied)
  const files = getEffectiveFiles(context);

  // Add identity/persona section
  const identityFiles = files.filter(f =>
    ['IDENTITY.md', 'SOUL.md'].includes(f.filename)
  );
  if (identityFiles.length > 0) {
    parts.push('<!-- Identity & Persona -->');
    for (const file of identityFiles) {
      parts.push(formatWorkspaceFile(file));
    }
    parts.push('');
  }

  // Add agent guidelines
  const agentsFile = files.find(f => f.filename === 'AGENTS.md');
  if (agentsFile) {
    parts.push('<!-- Workspace Guidelines -->');
    parts.push(formatWorkspaceFile(agentsFile));
    parts.push('');
  }

  // Add user context
  const userFile = files.find(f => f.filename === 'USER.md');
  if (userFile) {
    parts.push('<!-- User Context -->');
    parts.push(formatWorkspaceFile(userFile));
    parts.push('');
  }

  // Add tools notes
  const toolsFile = files.find(f => f.filename === 'TOOLS.md');
  if (toolsFile) {
    parts.push('<!-- Tool Notes -->');
    parts.push(formatWorkspaceFile(toolsFile));
    parts.push('');
  }

  // Add any extra files
  const standardFiles = BOOTSTRAP_FILES.map(f => f.toLowerCase());
  const extraFiles = files.filter(
    f => !standardFiles.includes(f.filename.toLowerCase())
  );
  if (extraFiles.length > 0) {
    parts.push('<!-- Additional Context -->');
    for (const file of extraFiles) {
      parts.push(formatWorkspaceFile(file));
    }
    parts.push('');
  }

  // Add skills
  if (skills.length > 0) {
    parts.push(formatSkillsForPrompt(skills));
    parts.push('');
  }

  // Add available tools
  if (toolsSummary) {
    parts.push('<available-tools>');
    parts.push(toolsSummary);
    parts.push('</available-tools>');
    parts.push('');
  }

  // Add heartbeat if present
  const heartbeatFile = files.find(f => f.filename === 'HEARTBEAT.md');
  if (heartbeatFile) {
    parts.push('<!-- Heartbeat Checklist -->');
    parts.push(formatWorkspaceFile(heartbeatFile));
    parts.push('');
  }

  // Add core behavior guidelines
  parts.push(`<guidelines>
- Be concise and helpful
- Use tools when they would help accomplish the task
- Explain what you're doing when using tools
- If a tool fails, try to handle the error gracefully
- For file operations, prefer reading before editing
- For commands, explain what will happen before running them
- Current date: ${new Date().toISOString().split('T')[0]}
</guidelines>`);

  return parts.join('\n').trim();
}

/**
 * Build a minimal system prompt for subagents
 */
export function buildSubagentPrompt(
  context: WorkspaceContext,
  taskDescription: string
): string {
  const parts: string[] = [];

  // Only include AGENTS.md and TOOLS.md for subagents
  const files = filterForSubagent(getEffectiveFiles(context));

  if (files.length > 0) {
    parts.push('<!-- Workspace Context -->');
    for (const file of files) {
      parts.push(formatWorkspaceFile(file));
    }
    parts.push('');
  }

  parts.push(`<task>
${taskDescription}
</task>`);

  parts.push(`<guidelines>
- Focus on the specific task assigned
- Be efficient and direct
- Report results clearly
</guidelines>`);

  return parts.join('\n').trim();
}

/**
 * Get identity display string for UI
 */
export function getIdentityDisplay(context: WorkspaceContext): string {
  if (!context.identity) return 'LocalBot';

  const emoji = context.identity.emoji || '🤖';
  return `${emoji} ${context.identity.name}`;
}

/**
 * Check if context has required files for operation
 */
export function validateContext(context: WorkspaceContext): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const files = getEffectiveFiles(context);

  // Check for recommended files
  if (!files.find(f => f.filename === 'IDENTITY.md')) {
    warnings.push('Missing IDENTITY.md - using default identity');
  }

  if (!files.find(f => f.filename === 'SOUL.md')) {
    warnings.push('Missing SOUL.md - no persona guidelines');
  }

  return {
    valid: true, // Context is always usable, just with defaults
    warnings,
  };
}
