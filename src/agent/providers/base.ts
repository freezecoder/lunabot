/**
 * Base provider interface and utilities
 */

import type { Provider, ChatRequest, ChatResponse, StreamChunk, ToolSchema, ToolCall } from '../../types.js';

export abstract class BaseProvider implements Provider {
  abstract name: string;
  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
  abstract listModels(): Promise<string[]>;

  /**
   * Convert tool schemas to provider-specific format
   */
  protected convertToolSchemas(tools?: ToolSchema[]): unknown[] | undefined {
    return tools;
  }

  /**
   * Normalize tool calls from provider response
   */
  protected normalizeToolCalls(toolCalls: unknown[]): ToolCall[] {
    return toolCalls as ToolCall[];
  }

  /**
   * Generate a unique ID for tool calls
   */
  protected generateToolCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
