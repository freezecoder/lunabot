/**
 * Main Agent - orchestrates conversations with LLMs and tool execution
 */

import type {
  Message, Provider, ToolSchema, ToolCall, ChatRequest, Session,
} from '../types.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ModelRouter, checkModelToolSupport } from '../router/router.js';
import { globalMetrics } from '../tracking/metrics.js';
import { v4 as uuid } from 'uuid';

export interface AgentConfig {
  provider: Provider;
  registry: ToolRegistry;
  systemPrompt?: string;
  maxTurns?: number;
  defaultModel?: string;
  routerConfig?: {
    reasoningModel: string;
    toolCallingModel: string;
    planningModel?: string;
    fallbackModel?: string;
  };
}

export interface StreamEvent {
  type: 'content' | 'tool_start' | 'tool_end' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: string;
  error?: string;
  model?: string;
  // Token usage info (on 'done' event)
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    contextPercentage?: number;
  };
}

export class Agent {
  private provider: Provider;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private router: ModelRouter;
  private systemPrompt: string;
  private maxTurns: number;
  private defaultModel: string;
  private sessions: Map<string, Session> = new Map();

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.registry = config.registry;
    this.systemPrompt = config.systemPrompt || this.getDefaultSystemPrompt();
    this.maxTurns = config.maxTurns || 10;
    this.defaultModel = config.defaultModel || 'llama3.1:8b';

    // Set up executor
    this.executor = new ToolExecutor(this.registry, {
      onToolStart: (inv) => console.log(`[Tool] Starting: ${inv.toolName}`),
      onToolEnd: (inv) => console.log(`[Tool] Completed: ${inv.toolName} (${inv.duration}ms)`),
      onToolError: (inv, err) => console.error(`[Tool] Error: ${inv.toolName}: ${err.message}`),
    });

    // Set up router
    const routerConfig = config.routerConfig || {
      reasoningModel: this.defaultModel,
      toolCallingModel: this.defaultModel,
    };

    this.router = new ModelRouter({
      config: routerConfig,
      providers: new Map([[this.provider.name, this.provider]]),
      modelSupportsTools: checkModelToolSupport,
    });
  }

  /**
   * Get or create a session
   */
  getSession(sessionId: string, userId: string = 'default'): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        userId,
        messages: [],
        model: this.defaultModel,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Clear a session
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.updatedAt = new Date();
    }
  }

  /**
   * Set model for a session
   */
  setSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = model;
      session.updatedAt = new Date();
    }
  }

  /**
   * Run a single turn with streaming
   */
  async *runStream(
    userMessage: string,
    sessionId: string = uuid(),
    userId: string = 'default'
  ): AsyncIterable<StreamEvent> {
    const session = this.getSession(sessionId, userId);
    session.messages.push({ role: 'user', content: userMessage });
    session.updatedAt = new Date();

    let turn = 0;
    const tools = this.registry.toSchemas();

    while (turn < this.maxTurns) {
      turn++;

      // Route to appropriate model
      const route = this.router.route(session.messages, tools);
      const model = session.model || route.model;

      yield { type: 'content', content: '', model };

      // Build messages with system prompt
      const messages: Message[] = [
        { role: 'system', content: this.systemPrompt },
        ...session.messages,
      ];

      // Make the request
      const request: ChatRequest = {
        model,
        messages,
        tools: route.useTools && this.router.supportsTools(model) ? tools : undefined,
        stream: true,
      };

      try {
        let assistantContent = '';
        let toolCalls: ToolCall[] = [];
        let promptTokens = 0;
        let evalTokens = 0;

        for await (const chunk of this.provider.chatStream(request)) {
          if (chunk.content) {
            assistantContent += chunk.content;
            yield { type: 'content', content: chunk.content };
          }

          if (chunk.tool_calls) {
            toolCalls = chunk.tool_calls;
          }

          // Capture token counts from final chunk
          if (chunk.prompt_eval_count) {
            promptTokens = chunk.prompt_eval_count;
          }
          if (chunk.eval_count) {
            evalTokens = chunk.eval_count;
          }

          if (chunk.done) {
            // Record token usage
            if (promptTokens > 0 || evalTokens > 0) {
              globalMetrics.recordTokenUsage(sessionId, promptTokens, evalTokens, model);
            }
            break;
          }
        }

        // Add assistant message to history
        const assistantMessage: Message = {
          role: 'assistant',
          content: assistantContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };
        session.messages.push(assistantMessage);

        // Execute tool calls if any
        if (toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            yield {
              type: 'tool_start',
              toolCall,
            };

            const result = await this.executor.execute(toolCall, sessionId, model);

            yield {
              type: 'tool_end',
              toolCall,
              toolResult: result.content,
            };

            // Add tool result to history
            session.messages.push({
              role: 'tool',
              content: result.content,
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
            });
          }

          // Continue the loop to process tool results
          continue;
        }

        // No tool calls, we're done
        const tokenUsage = (promptTokens > 0 || evalTokens > 0) ? {
          input: promptTokens,
          output: evalTokens,
          total: promptTokens + evalTokens,
        } : undefined;
        yield { type: 'done', tokenUsage };
        return;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        yield { type: 'error', error: errorMessage };
        return;
      }
    }

    yield { type: 'error', error: `Maximum turns (${this.maxTurns}) exceeded` };
  }

  /**
   * Run a single turn and return complete response
   */
  async run(
    userMessage: string,
    sessionId: string = uuid(),
    userId: string = 'default'
  ): Promise<{ content: string; toolCalls: ToolCall[]; error?: string }> {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let error: string | undefined;

    for await (const event of this.runStream(userMessage, sessionId, userId)) {
      switch (event.type) {
        case 'content':
          if (event.content) content += event.content;
          break;
        case 'tool_start':
          if (event.toolCall) toolCalls.push(event.toolCall);
          break;
        case 'error':
          error = event.error;
          break;
      }
    }

    return { content, toolCalls, error };
  }

  /**
   * Get available models
   */
  async getModels(): Promise<string[]> {
    return this.provider.listModels();
  }

  /**
   * Get available tools
   */
  getTools(): ToolSchema[] {
    return this.registry.toSchemas();
  }

  /**
   * Get tool stats
   */
  getStats() {
    return this.executor.getStats();
  }

  /**
   * Get session history
   */
  getHistory(sessionId: string): Message[] {
    return this.sessions.get(sessionId)?.messages || [];
  }

  /**
   * Default system prompt
   */
  private getDefaultSystemPrompt(): string {
    const tools = this.registry.getSummary();
    return `You are LocalBot, a helpful AI assistant with access to various tools.

You can use tools to help accomplish tasks. When you need to use a tool, you'll make a tool call and receive the results.

Available tools:
${tools}

Guidelines:
- Be concise and helpful
- Use tools when they would help accomplish the task
- Explain what you're doing when using tools
- If a tool fails, try to handle the error gracefully
- For file operations, prefer reading before editing
- For commands, explain what will happen before running them

Current date: ${new Date().toISOString().split('T')[0]}`;
  }
}
