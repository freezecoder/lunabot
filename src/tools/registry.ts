/**
 * Tool Registry - manages available tools for the agent
 */

import type { Tool, ToolSchema, ToolParameter } from '../types.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a new tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" is already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister a tool by name
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Convert all tools to OpenAI/Ollama tool schema format
   */
  toSchemas(): ToolSchema[] {
    return this.getAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Get a summary of available tools (for prompts)
   */
  getSummary(): string {
    const tools = this.getAll();
    if (tools.length === 0) {
      return 'No tools available.';
    }

    return tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  }

  /**
   * Create a subset registry with only specified tools
   */
  subset(names: string[]): ToolRegistry {
    const subset = new ToolRegistry();
    for (const name of names) {
      const tool = this.get(name);
      if (tool) {
        subset.register(tool);
      }
    }
    return subset;
  }

  /**
   * Get tool count
   */
  get size(): number {
    return this.tools.size;
  }
}

interface DefineToolConfig {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter & { isRequired?: boolean }>;
  execute: (args: Record<string, unknown>) => Promise<string>;
  timeout?: number;
  retryable?: boolean;
  requiresConfirmation?: boolean;
}

/**
 * Helper function to define a tool with proper typing
 */
export function defineTool(config: DefineToolConfig): Tool {
  const required: string[] = [];
  const properties: Record<string, ToolParameter> = {};

  for (const [key, param] of Object.entries(config.parameters)) {
    const { isRequired, ...paramDef } = param;
    properties[key] = paramDef;
    if (isRequired) {
      required.push(key);
    }
  }

  return {
    name: config.name,
    description: config.description,
    parameters: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
    execute: config.execute,
    timeout: config.timeout,
    retryable: config.retryable,
    requiresConfirmation: config.requiresConfirmation,
  };
}

/**
 * Global default registry
 */
export const globalRegistry = new ToolRegistry();
