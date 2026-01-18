/**
 * Core type definitions for LocalBot
 */

// ============ Message Types ============

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

// ============ Tool Types ============

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameter>;
      required?: string[];
    };
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
  timeout?: number;
  retryable?: boolean;
  requiresConfirmation?: boolean;
}

// ============ Provider Types ============

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  message: Message;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface StreamChunk {
  content?: string;
  tool_calls?: ToolCall[];
  done: boolean;
  // Token usage (available on final chunk)
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export interface Provider {
  name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<string[]>;
}

// ============ Router Types ============

export interface ModelConfig {
  name: string;
  provider: 'ollama' | 'litellm';
  endpoint?: string;
  supportsTools: boolean;
  contextWindow?: number;
  description?: string;
}

export interface RouterConfig {
  reasoningModel: string;
  toolCallingModel: string;
  planningModel?: string;
  fallbackModel?: string;
}

export type RoutingStrategy = 'task-based' | 'round-robin' | 'fallback';

// ============ Session Types ============

export interface Session {
  id: string;
  userId: string;
  messages: Message[];
  model: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

// ============ Tracking Types ============

export interface ToolInvocation {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError: boolean;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  model: string;
}

export interface Metrics {
  totalToolCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageDuration: number;
  toolBreakdown: Record<string, {
    count: number;
    successRate: number;
    avgDuration: number;
  }>;
}

// ============ Config Types ============

export interface BotConfig {
  telegramToken: string;
  ollamaEndpoints: string[];
  litellmEndpoint?: string;
  defaultModel: string;
  routerConfig: RouterConfig;
  adminUserIds?: number[];
}
