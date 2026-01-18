/**
 * Multi-Model Router - routes requests to appropriate models
 * based on task type (reasoning vs tool calling)
 */

import type { Message, RouterConfig, Provider, ToolSchema } from '../types.js';

export interface RouteDecision {
  model: string;
  reason: string;
  useTools: boolean;
}

export interface RouterOptions {
  config: RouterConfig;
  providers: Map<string, Provider>;
  modelSupportsTools: (model: string) => boolean;
}

export class ModelRouter {
  private config: RouterConfig;
  private providers: Map<string, Provider>;
  private modelSupportsTools: (model: string) => boolean;

  constructor(options: RouterOptions) {
    this.config = options.config;
    this.providers = options.providers;
    this.modelSupportsTools = options.modelSupportsTools;
  }

  /**
   * Determine which model should handle the next message
   */
  route(messages: Message[], availableTools: ToolSchema[]): RouteDecision {
    const lastMessage = messages[messages.length - 1];

    // If we just got tool results, continue with reasoning model
    if (lastMessage?.role === 'tool') {
      return {
        model: this.config.reasoningModel,
        reason: 'Processing tool results',
        useTools: true,
      };
    }

    // If the last assistant message has tool calls pending, use tool model
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    if (lastAssistant?.tool_calls && lastAssistant.tool_calls.length > 0) {
      return {
        model: this.config.toolCallingModel,
        reason: 'Executing tool calls',
        useTools: true,
      };
    }

    // Analyze the user message to determine routing
    const userMessage = lastMessage?.role === 'user' ? lastMessage.content : '';
    const needsTools = this.analyzeForToolNeed(userMessage, availableTools);

    if (needsTools) {
      // Use tool-calling model for tasks that likely need tools
      return {
        model: this.config.toolCallingModel,
        reason: 'Task likely requires tool use',
        useTools: true,
      };
    }

    // Default to reasoning model
    return {
      model: this.config.reasoningModel,
      reason: 'General reasoning task',
      useTools: availableTools.length > 0,
    };
  }

  /**
   * Analyze if a message likely needs tool use
   */
  private analyzeForToolNeed(message: string, tools: ToolSchema[]): boolean {
    const lowerMsg = message.toLowerCase();

    // Keywords that suggest tool use
    const toolKeywords = [
      // File operations
      'read file', 'write file', 'edit file', 'create file', 'delete file',
      'open file', 'save file', 'show file', 'cat ', 'list files', 'ls ',
      // Commands
      'run ', 'execute', 'command', 'bash', 'terminal', 'shell',
      // Web
      'search', 'fetch', 'download', 'browse', 'website', 'url',
      'look up', 'find out', 'google',
      // Analysis
      'analyze', 'check', 'verify', 'test', 'debug',
    ];

    for (const keyword of toolKeywords) {
      if (lowerMsg.includes(keyword)) {
        return true;
      }
    }

    // Check if any tool names are mentioned
    for (const tool of tools) {
      if (lowerMsg.includes(tool.function.name.replace('_', ' '))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the provider for a model
   */
  getProvider(model: string): Provider | undefined {
    // Try to find matching provider
    for (const [name, provider] of this.providers) {
      if (model.startsWith(name) || model.includes(name)) {
        return provider;
      }
    }
    // Default to first provider
    return this.providers.values().next().value;
  }

  /**
   * Check if model supports tools
   */
  supportsTools(model: string): boolean {
    return this.modelSupportsTools(model);
  }

  /**
   * Get current config
   */
  getConfig(): RouterConfig {
    return { ...this.config };
  }

  /**
   * Update router config
   */
  updateConfig(config: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Switch to a specific model for both reasoning and tools
   */
  setModel(model: string): void {
    this.config.reasoningModel = model;
    if (this.modelSupportsTools(model)) {
      this.config.toolCallingModel = model;
    }
  }
}

/**
 * Default model capabilities map
 */
export const MODEL_CAPABILITIES: Record<string, { supportsTools: boolean; description: string }> = {
  'llama3.1:8b': { supportsTools: true, description: 'Fast, native tool support' },
  'llama3.1:70b': { supportsTools: true, description: 'High quality, native tool support' },
  'llama3.2:3b': { supportsTools: true, description: 'Compact, native tool support' },
  'qwen2.5:7b': { supportsTools: true, description: 'Fast, good tool support' },
  'qwen2.5:32b': { supportsTools: true, description: 'High quality, good tool support' },
  'qwen2.5:72b': { supportsTools: true, description: 'Best quality Qwen' },
  'deepseek-r1:14b': { supportsTools: false, description: 'Strong reasoning, no tools' },
  'deepseek-r1:32b': { supportsTools: false, description: 'Strong reasoning, no tools' },
  'mistral:7b': { supportsTools: true, description: 'Fast, tool support' },
  'mixtral:8x7b': { supportsTools: true, description: 'MoE, good quality' },
  'gemma2:9b': { supportsTools: false, description: 'Google model, no tools' },
  'phi3:14b': { supportsTools: false, description: 'Microsoft model' },
};

/**
 * Check if a model supports tools based on known capabilities
 */
export function checkModelToolSupport(model: string): boolean {
  // Check exact match first
  if (MODEL_CAPABILITIES[model]) {
    return MODEL_CAPABILITIES[model].supportsTools;
  }

  // Check prefix match
  for (const [key, value] of Object.entries(MODEL_CAPABILITIES)) {
    if (model.startsWith(key.split(':')[0])) {
      return value.supportsTools;
    }
  }

  // Default: assume tools are supported for llama and qwen families
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes('llama3') || lowerModel.includes('qwen2.5') ||
      lowerModel.includes('mistral') || lowerModel.includes('mixtral')) {
    return true;
  }

  return false;
}
