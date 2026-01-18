/**
 * Skill Loader - Load skills/tools from YAML/JSON configuration files
 * Similar to clawdbot's skill system
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Tool, ToolParameter } from '../types.js';
import { defineTool } from './registry.js';
import { spawn } from 'child_process';

export interface SkillDefinition {
  name: string;
  description: string;
  parameters?: Record<string, {
    type: string;
    description?: string;
    required?: boolean;
    enum?: string[];
    default?: unknown;
  }>;
  // Execution methods (pick one)
  command?: string;           // Shell command template
  script?: string;            // Inline script (bash by default)
  script_file?: string;       // Path to script file
  http?: {                    // HTTP request
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body_template?: string;
  };
  // Options
  timeout?: number;
  requires_confirmation?: boolean;
  working_directory?: string;
  interpreter?: string;       // For scripts: bash, python, node, etc.
}

export interface SkillFile {
  version?: string;
  skills: SkillDefinition[];
}

/**
 * Load a single skill definition and convert to Tool
 */
export function loadSkillDefinition(def: SkillDefinition): Tool {
  const parameters: Record<string, ToolParameter & { isRequired?: boolean }> = {};

  if (def.parameters) {
    for (const [key, param] of Object.entries(def.parameters)) {
      parameters[key] = {
        type: param.type,
        description: param.description,
        isRequired: param.required,
        enum: param.enum,
        default: param.default,
      };
    }
  }

  return defineTool({
    name: def.name,
    description: def.description,
    parameters,
    timeout: def.timeout,
    requiresConfirmation: def.requires_confirmation,

    async execute(args): Promise<string> {
      // Command execution
      if (def.command) {
        return executeCommand(def.command, args, def);
      }

      // Inline script
      if (def.script) {
        return executeScript(def.script, args, def);
      }

      // Script file
      if (def.script_file) {
        const script = await readFile(def.script_file, 'utf-8');
        return executeScript(script, args, def);
      }

      // HTTP request
      if (def.http) {
        return executeHttp(def.http, args);
      }

      return 'Error: No execution method defined for this skill';
    },
  });
}

/**
 * Execute a command template with arguments
 */
async function executeCommand(
  template: string,
  args: Record<string, unknown>,
  def: SkillDefinition
): Promise<string> {
  // Replace {{arg}} placeholders
  let command = template;
  for (const [key, value] of Object.entries(args)) {
    const placeholder = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    command = command.replace(placeholder, String(value));
  }

  // Also support $arg syntax
  for (const [key, value] of Object.entries(args)) {
    command = command.replace(new RegExp(`\\$${key}\\b`, 'g'), String(value));
  }

  return new Promise((resolve) => {
    const timeout = def.timeout || 60000;
    const cwd = def.working_directory || process.cwd();

    const proc = spawn('bash', ['-c', command], { cwd, timeout });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      let result = stdout.trim();
      if (stderr.trim()) {
        result += `\n\nSTDERR:\n${stderr.trim()}`;
      }
      if (code !== 0 && code !== null) {
        result += `\n\n[Exit code: ${code}]`;
      }
      resolve(result || '(no output)');
    });

    proc.on('error', (error) => {
      resolve(`Error: ${error.message}`);
    });
  });
}

/**
 * Execute an inline script with arguments
 */
async function executeScript(
  script: string,
  args: Record<string, unknown>,
  def: SkillDefinition
): Promise<string> {
  const interpreter = def.interpreter || 'bash';

  // Build environment variables from args
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(args)) {
    env[key.toUpperCase()] = String(value);
  }

  return new Promise((resolve) => {
    const timeout = def.timeout || 60000;
    const cwd = def.working_directory || process.cwd();

    let proc;
    if (interpreter === 'bash' || interpreter === 'sh') {
      proc = spawn(interpreter, ['-c', script], { cwd, env, timeout });
    } else if (interpreter === 'python' || interpreter === 'python3') {
      proc = spawn(interpreter, ['-c', script], { cwd, env, timeout });
    } else if (interpreter === 'node') {
      proc = spawn('node', ['-e', script], { cwd, env, timeout });
    } else {
      proc = spawn(interpreter, [], { cwd, env, timeout });
      proc.stdin.write(script);
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      let result = stdout.trim();
      if (stderr.trim()) {
        result += `\n\nSTDERR:\n${stderr.trim()}`;
      }
      if (code !== 0 && code !== null) {
        result += `\n\n[Exit code: ${code}]`;
      }
      resolve(result || '(no output)');
    });

    proc.on('error', (error) => {
      resolve(`Error: ${error.message}`);
    });
  });
}

/**
 * Execute an HTTP request
 */
async function executeHttp(
  config: NonNullable<SkillDefinition['http']>,
  args: Record<string, unknown>
): Promise<string> {
  try {
    // Replace placeholders in URL
    let url = config.url;
    for (const [key, value] of Object.entries(args)) {
      url = url.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), encodeURIComponent(String(value)));
    }

    // Build body if template provided
    let body: string | undefined;
    if (config.body_template) {
      body = config.body_template;
      for (const [key, value] of Object.entries(args)) {
        body = body.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value));
      }
    }

    const response = await fetch(url, {
      method: config.method || 'GET',
      headers: config.headers,
      body,
    });

    const contentType = response.headers.get('content-type') || '';
    let content: string;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
    } else {
      content = await response.text();
    }

    if (!response.ok) {
      return `HTTP ${response.status}: ${content}`;
    }

    return content;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Load skills from a YAML or JSON file
 */
export async function loadSkillsFromFile(filePath: string): Promise<Tool[]> {
  const content = await readFile(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();

  let data: SkillFile;
  if (ext === '.yaml' || ext === '.yml') {
    data = parseYaml(content) as SkillFile;
  } else if (ext === '.json') {
    data = JSON.parse(content) as SkillFile;
  } else {
    throw new Error(`Unsupported file format: ${ext}`);
  }

  if (!data.skills || !Array.isArray(data.skills)) {
    throw new Error(`Invalid skill file: missing 'skills' array`);
  }

  return data.skills.map(loadSkillDefinition);
}

/**
 * Load all skills from a directory
 */
export async function loadSkillsFromDirectory(dirPath: string): Promise<Tool[]> {
  const tools: Tool[] = [];

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stats = await stat(fullPath);

      if (stats.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
          try {
            const skills = await loadSkillsFromFile(fullPath);
            tools.push(...skills);
            console.log(`Loaded ${skills.length} skills from ${entry}`);
          } catch (error) {
            console.error(`Error loading skills from ${entry}:`, error);
          }
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // Directory doesn't exist, that's fine
  }

  return tools;
}

/**
 * Create a sample skill file for reference
 */
export function generateSampleSkillFile(): string {
  const sample: SkillFile = {
    version: '1.0',
    skills: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          city: {
            type: 'string',
            description: 'City name',
            required: true,
          },
        },
        http: {
          url: 'https://wttr.in/{{city}}?format=3',
          method: 'GET',
        },
        timeout: 10000,
      },
      {
        name: 'disk_usage',
        description: 'Check disk usage',
        command: 'df -h',
        timeout: 5000,
      },
      {
        name: 'count_lines',
        description: 'Count lines in a file',
        parameters: {
          file: {
            type: 'string',
            description: 'Path to file',
            required: true,
          },
        },
        command: 'wc -l {{file}}',
      },
    ],
  };

  return parseYaml(JSON.stringify(sample));
}
