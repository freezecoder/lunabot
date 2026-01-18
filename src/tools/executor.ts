/**
 * Tool Executor - handles executing tools and tracking invocations
 */

import type { Tool, ToolCall, ToolResult, ToolInvocation } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { v4 as uuid } from 'uuid';

export interface ExecutorOptions {
  defaultTimeout?: number;
  onToolStart?: (invocation: ToolInvocation) => void;
  onToolEnd?: (invocation: ToolInvocation) => void;
  onToolError?: (invocation: ToolInvocation, error: Error) => void;
  confirmationHandler?: (tool: Tool, args: Record<string, unknown>) => Promise<boolean>;
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private options: ExecutorOptions;
  private history: ToolInvocation[] = [];

  constructor(registry: ToolRegistry, options: ExecutorOptions = {}) {
    this.registry = registry;
    this.options = {
      defaultTimeout: 60000,
      ...options,
    };
  }

  /**
   * Execute a single tool call
   */
  async execute(
    toolCall: ToolCall,
    sessionId: string,
    model: string
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.function.name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        content: `Error: Unknown tool "${toolCall.function.name}". Available tools: ${this.registry.getNames().join(', ')}`,
        is_error: true,
      };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return {
        tool_call_id: toolCall.id,
        content: `Error: Invalid JSON arguments for tool "${toolCall.function.name}": ${toolCall.function.arguments}`,
        is_error: true,
      };
    }

    // Create invocation record
    const invocation: ToolInvocation = {
      id: uuid(),
      sessionId,
      toolName: tool.name,
      arguments: args,
      isError: false,
      startTime: new Date(),
      model,
    };

    this.options.onToolStart?.(invocation);

    // Check if confirmation is required
    if (tool.requiresConfirmation && this.options.confirmationHandler) {
      const confirmed = await this.options.confirmationHandler(tool, args);
      if (!confirmed) {
        invocation.endTime = new Date();
        invocation.duration = invocation.endTime.getTime() - invocation.startTime.getTime();
        invocation.result = 'Cancelled by user';
        invocation.isError = true;
        this.history.push(invocation);
        this.options.onToolEnd?.(invocation);

        return {
          tool_call_id: toolCall.id,
          content: 'Tool execution cancelled by user.',
          is_error: true,
        };
      }
    }

    // Execute with timeout
    const timeout = tool.timeout || this.options.defaultTimeout || 60000;

    try {
      const result = await Promise.race([
        tool.execute(args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${tool.name}" timed out after ${timeout}ms`)), timeout)
        ),
      ]);

      invocation.endTime = new Date();
      invocation.duration = invocation.endTime.getTime() - invocation.startTime.getTime();
      invocation.result = result;
      invocation.isError = false;
      this.history.push(invocation);
      this.options.onToolStart?.(invocation);

      return {
        tool_call_id: toolCall.id,
        content: result,
        is_error: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      invocation.endTime = new Date();
      invocation.duration = invocation.endTime.getTime() - invocation.startTime.getTime();
      invocation.result = errorMessage;
      invocation.isError = true;
      this.history.push(invocation);
      this.options.onToolError?.(invocation, error instanceof Error ? error : new Error(errorMessage));

      return {
        tool_call_id: toolCall.id,
        content: `Error executing tool "${tool.name}": ${errorMessage}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  async executeAll(
    toolCalls: ToolCall[],
    sessionId: string,
    model: string
  ): Promise<ToolResult[]> {
    return Promise.all(
      toolCalls.map(tc => this.execute(tc, sessionId, model))
    );
  }

  /**
   * Execute multiple tool calls sequentially
   */
  async executeSequential(
    toolCalls: ToolCall[],
    sessionId: string,
    model: string
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      results.push(await this.execute(tc, sessionId, model));
    }
    return results;
  }

  /**
   * Get execution history
   */
  getHistory(sessionId?: string): ToolInvocation[] {
    if (sessionId) {
      return this.history.filter(inv => inv.sessionId === sessionId);
    }
    return [...this.history];
  }

  /**
   * Get recent invocations
   */
  getRecent(count: number = 10): ToolInvocation[] {
    return this.history.slice(-count);
  }

  /**
   * Clear history
   */
  clearHistory(sessionId?: string): void {
    if (sessionId) {
      this.history = this.history.filter(inv => inv.sessionId !== sessionId);
    } else {
      this.history = [];
    }
  }

  /**
   * Get execution statistics
   */
  getStats(): {
    total: number;
    successful: number;
    failed: number;
    byTool: Record<string, { count: number; errors: number; avgDuration: number }>;
  } {
    const stats = {
      total: this.history.length,
      successful: 0,
      failed: 0,
      byTool: {} as Record<string, { count: number; errors: number; avgDuration: number }>,
    };

    const toolDurations: Record<string, number[]> = {};

    for (const inv of this.history) {
      if (inv.isError) {
        stats.failed++;
      } else {
        stats.successful++;
      }

      if (!stats.byTool[inv.toolName]) {
        stats.byTool[inv.toolName] = { count: 0, errors: 0, avgDuration: 0 };
        toolDurations[inv.toolName] = [];
      }

      stats.byTool[inv.toolName].count++;
      if (inv.isError) {
        stats.byTool[inv.toolName].errors++;
      }
      if (inv.duration) {
        toolDurations[inv.toolName].push(inv.duration);
      }
    }

    // Calculate averages
    for (const [name, durations] of Object.entries(toolDurations)) {
      if (durations.length > 0) {
        stats.byTool[name].avgDuration =
          durations.reduce((a, b) => a + b, 0) / durations.length;
      }
    }

    return stats;
  }
}
