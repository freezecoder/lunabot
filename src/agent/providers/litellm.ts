/**
 * LiteLLM proxy client provider
 * Connects to LiteLLM's OpenAI-compatible API
 */

import type { ChatRequest, ChatResponse, StreamChunk, Message, ToolSchema, ToolCall } from '../../types.js';
import { BaseProvider } from './base.js';

interface LiteLLMConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export class LiteLLMProvider extends BaseProvider {
  name = 'litellm';
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: LiteLLMConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey || 'sk-litellm-local';
    this.timeout = config.timeout || 300000;
  }

  /**
   * Convert our message format to OpenAI format
   */
  private toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
    return messages.map(msg => {
      const base: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.tool_calls) {
        base.tool_calls = msg.tool_calls;
      }

      if (msg.tool_call_id) {
        base.tool_call_id = msg.tool_call_id;
      }

      if (msg.name) {
        base.name = msg.name;
      }

      return base;
    });
  }

  /**
   * Convert tool schemas to OpenAI format
   */
  private toOpenAITools(tools?: ToolSchema[]): unknown[] | undefined {
    if (!tools) return undefined;
    return tools;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: this.toOpenAIMessages(request.messages),
          tools: this.toOpenAITools(request.tools),
          stream: false,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LiteLLM error: ${response.status} - ${error}`);
      }

      const data = await response.json() as OpenAIResponse;
      const choice = data.choices[0];

      return {
        id: data.id,
        model: data.model,
        message: {
          role: 'assistant',
          content: choice.message.content || '',
          tool_calls: choice.message.tool_calls,
        },
        done: true,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: this.toOpenAIMessages(request.messages),
          tools: this.toOpenAITools(request.tools),
          stream: true,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LiteLLM error: ${response.status} - ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedToolCalls: Map<number, ToolCall> = new Map();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              yield {
                done: true,
                tool_calls: accumulatedToolCalls.size > 0
                  ? Array.from(accumulatedToolCalls.values())
                  : undefined,
              };
              return;
            }

            try {
              const chunk: OpenAIStreamChunk = JSON.parse(data);
              const delta = chunk.choices[0]?.delta;

              // Handle tool calls in streaming
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = accumulatedToolCalls.get(tc.index);
                  if (existing) {
                    // Append arguments
                    if (tc.function?.arguments) {
                      existing.function.arguments += tc.function.arguments;
                    }
                  } else if (tc.id) {
                    // New tool call
                    accumulatedToolCalls.set(tc.index, {
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      },
                    });
                  }
                }
              }

              yield {
                content: delta?.content || undefined,
                tool_calls: undefined, // Only return at the end
                done: chunk.choices[0]?.finish_reason === 'stop' ||
                      chunk.choices[0]?.finish_reason === 'tool_calls',
              };
            } catch {
              // Ignore JSON parse errors for malformed chunks
            }
          }
        }
      }

      // Final yield with accumulated tool calls if any
      if (accumulatedToolCalls.size > 0) {
        yield {
          done: true,
          tool_calls: Array.from(accumulatedToolCalls.values()),
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) || [];
    } catch {
      return [];
    }
  }

  /**
   * Check LiteLLM health
   */
  async health(): Promise<{ status: string; models?: string[] }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (response.ok) {
        const models = await this.listModels();
        return { status: 'healthy', models };
      }
      return { status: 'unhealthy' };
    } catch {
      return { status: 'unreachable' };
    }
  }
}

export function createLiteLLMProvider(baseUrl: string, apiKey?: string): LiteLLMProvider {
  return new LiteLLMProvider({ baseUrl, apiKey });
}
