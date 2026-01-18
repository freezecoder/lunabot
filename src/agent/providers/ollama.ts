/**
 * Direct Ollama API client provider
 * Connects to Ollama's native /api/chat endpoint with tool support
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, StreamChunk, Message, ToolSchema, ToolCall } from '../../types.js';
import { BaseProvider } from './base.js';

interface OllamaConfig {
  host: string;
  timeout?: number;
}

export class OllamaProvider extends BaseProvider {
  name = 'ollama';
  private client: Ollama;
  private host: string;

  constructor(config: OllamaConfig) {
    super();
    this.host = config.host;
    this.client = new Ollama({ host: config.host });
  }

  /**
   * Convert our message format to Ollama format
   */
  private toOllamaMessages(messages: Message[]): Array<{ role: string; content: string; tool_calls?: unknown[]; name?: string }> {
    return messages.map(msg => {
      const base: { role: string; content: string; tool_calls?: unknown[]; name?: string } = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.tool_calls) {
        base.tool_calls = msg.tool_calls.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          },
        }));
      }

      // For tool results
      if (msg.role === 'tool' && msg.name) {
        base.role = 'tool';
        base.name = msg.name;
      }

      return base;
    });
  }

  /**
   * Convert tool schemas to Ollama format
   */
  private toOllamaTools(tools?: ToolSchema[]): Parameters<Ollama['chat']>[0]['tools'] {
    if (!tools) return undefined;

    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  /**
   * Extract tool calls from Ollama response
   */
  private extractToolCalls(message: { tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }): ToolCall[] | undefined {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return undefined;
    }

    return message.tool_calls.map((tc, idx) => ({
      id: this.generateToolCallId(),
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments),
      },
    }));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat({
      model: request.model,
      messages: this.toOllamaMessages(request.messages) as Parameters<Ollama['chat']>[0]['messages'],
      tools: this.toOllamaTools(request.tools),
      stream: false,
      options: {
        temperature: request.temperature,
        num_predict: request.max_tokens,
      },
    });

    const toolCalls = this.extractToolCalls(response.message);

    return {
      id: `ollama-${Date.now()}`,
      model: response.model,
      message: {
        role: 'assistant',
        content: response.message.content,
        tool_calls: toolCalls,
      },
      done: true,
      total_duration: response.total_duration,
      load_duration: response.load_duration,
      prompt_eval_count: response.prompt_eval_count,
      eval_count: response.eval_count,
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const response = await this.client.chat({
      model: request.model,
      messages: this.toOllamaMessages(request.messages) as Parameters<Ollama['chat']>[0]['messages'],
      tools: this.toOllamaTools(request.tools),
      stream: true,
      options: {
        temperature: request.temperature,
        num_predict: request.max_tokens,
      },
    });

    let accumulatedToolCalls: ToolCall[] = [];

    for await (const chunk of response) {
      // Check for tool calls in the chunk
      if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
        const newToolCalls = this.extractToolCalls(chunk.message);
        if (newToolCalls) {
          accumulatedToolCalls = newToolCalls;
        }
      }

      yield {
        content: chunk.message.content || undefined,
        tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        done: chunk.done,
        // Include token counts from final chunk
        prompt_eval_count: chunk.prompt_eval_count,
        eval_count: chunk.eval_count,
        total_duration: chunk.total_duration,
      };
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.client.list();
    return response.models.map(m => m.name);
  }

  /**
   * Pull a model from Ollama registry
   */
  async pullModel(model: string, onProgress?: (status: string) => void): Promise<void> {
    const response = await this.client.pull({ model, stream: true });
    for await (const chunk of response) {
      if (onProgress && chunk.status) {
        onProgress(chunk.status);
      }
    }
  }

  /**
   * Check if a model exists locally
   */
  async hasModel(model: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some(m => m.includes(model) || model.includes(m));
  }

  /**
   * Get model info
   */
  async getModelInfo(model: string): Promise<{ parameters?: string; quantization?: string; size?: number }> {
    try {
      const info = await this.client.show({ model });
      return {
        parameters: info.details.parameter_size,
        quantization: info.details.quantization_level,
      };
    } catch {
      return {};
    }
  }
}

/**
 * Create a provider that can failover between multiple Ollama endpoints
 */
export function createOllamaProvider(hosts: string[]): OllamaProvider {
  // For now, just use the first host
  // TODO: Implement failover logic
  return new OllamaProvider({ host: hosts[0] });
}
