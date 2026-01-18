/**
 * Metrics and Tracking - collect and analyze tool/agent usage data
 */

import type { ToolInvocation, Metrics } from '../types.js';
import { globalTokenTracker, calculateContextPercentage, type TokenUsage } from './tokens.js';

export interface ConversationMetrics {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  messageCount: number;
  toolCalls: number;
  model: string;
  userId: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

export interface ModelMetrics {
  model: string;
  totalRequests: number;
  totalTokens?: number;
  averageLatency: number;
  errors: number;
  lastUsed: Date;
}

export class MetricsCollector {
  private toolInvocations: ToolInvocation[] = [];
  private conversations: ConversationMetrics[] = [];
  private modelUsage: Map<string, ModelMetrics> = new Map();
  private startTime: Date = new Date();

  /**
   * Record a tool invocation
   */
  recordToolInvocation(invocation: ToolInvocation): void {
    this.toolInvocations.push(invocation);
  }

  /**
   * Record a conversation turn
   */
  recordConversation(metrics: ConversationMetrics): void {
    this.conversations.push(metrics);
  }

  /**
   * Record model usage
   */
  recordModelUsage(model: string, latencyMs: number, isError: boolean = false): void {
    const existing = this.modelUsage.get(model) || {
      model,
      totalRequests: 0,
      averageLatency: 0,
      errors: 0,
      lastUsed: new Date(),
    };

    existing.totalRequests++;
    if (isError) existing.errors++;
    existing.lastUsed = new Date();

    // Update average latency
    existing.averageLatency =
      (existing.averageLatency * (existing.totalRequests - 1) + latencyMs) /
      existing.totalRequests;

    this.modelUsage.set(model, existing);
  }

  /**
   * Record token usage for a request
   */
  recordTokenUsage(
    sessionId: string,
    input: number,
    output: number,
    model: string
  ): void {
    const contextPercentage = calculateContextPercentage(input, model);

    globalTokenTracker.recordUsage(sessionId, {
      input,
      output,
      total: input + output,
      contextPercentage,
      model,
    });

    // Also update model metrics with token count
    const existing = this.modelUsage.get(model);
    if (existing) {
      existing.totalTokens = (existing.totalTokens || 0) + input + output;
    }
  }

  /**
   * Get token stats for a session
   */
  getSessionTokenStats(sessionId: string) {
    return globalTokenTracker.getSessionStats(sessionId);
  }

  /**
   * Get global token stats
   */
  getGlobalTokenStats() {
    return globalTokenTracker.getGlobalStats();
  }

  /**
   * Format token stats for display
   */
  formatTokenStats(): string {
    return globalTokenTracker.formatGlobalStats();
  }

  /**
   * Get tool metrics
   */
  getToolMetrics(): Metrics {
    const total = this.toolInvocations.length;
    const successful = this.toolInvocations.filter(i => !i.isError).length;
    const failed = total - successful;

    // Calculate average duration
    const durations = this.toolInvocations
      .filter(i => i.duration !== undefined)
      .map(i => i.duration!);
    const averageDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    // Tool breakdown
    const toolBreakdown: Metrics['toolBreakdown'] = {};
    for (const inv of this.toolInvocations) {
      if (!toolBreakdown[inv.toolName]) {
        toolBreakdown[inv.toolName] = {
          count: 0,
          successRate: 0,
          avgDuration: 0,
        };
      }
      toolBreakdown[inv.toolName].count++;
    }

    // Calculate per-tool metrics
    for (const [name, data] of Object.entries(toolBreakdown)) {
      const toolInvocations = this.toolInvocations.filter(i => i.toolName === name);
      const toolSuccessful = toolInvocations.filter(i => !i.isError).length;
      const toolDurations = toolInvocations
        .filter(i => i.duration !== undefined)
        .map(i => i.duration!);

      data.successRate = toolSuccessful / toolInvocations.length;
      data.avgDuration = toolDurations.length > 0
        ? toolDurations.reduce((a, b) => a + b, 0) / toolDurations.length
        : 0;
    }

    return {
      totalToolCalls: total,
      successfulCalls: successful,
      failedCalls: failed,
      averageDuration,
      toolBreakdown,
    };
  }

  /**
   * Get model usage metrics
   */
  getModelMetrics(): ModelMetrics[] {
    return Array.from(this.modelUsage.values())
      .sort((a, b) => b.totalRequests - a.totalRequests);
  }

  /**
   * Get conversation metrics summary
   */
  getConversationSummary(): {
    total: number;
    avgMessageCount: number;
    avgToolCalls: number;
    byModel: Record<string, number>;
  } {
    const total = this.conversations.length;
    const avgMessageCount = total > 0
      ? this.conversations.reduce((a, c) => a + c.messageCount, 0) / total
      : 0;
    const avgToolCalls = total > 0
      ? this.conversations.reduce((a, c) => a + c.toolCalls, 0) / total
      : 0;

    const byModel: Record<string, number> = {};
    for (const conv of this.conversations) {
      byModel[conv.model] = (byModel[conv.model] || 0) + 1;
    }

    return { total, avgMessageCount, avgToolCalls, byModel };
  }

  /**
   * Get recent tool invocations
   */
  getRecentInvocations(count: number = 10): ToolInvocation[] {
    return this.toolInvocations.slice(-count);
  }

  /**
   * Get uptime
   */
  getUptime(): number {
    return Date.now() - this.startTime.getTime();
  }

  /**
   * Format uptime as string
   */
  getUptimeString(): string {
    const ms = this.getUptime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Get full summary report
   */
  getSummaryReport(): string {
    const toolMetrics = this.getToolMetrics();
    const modelMetrics = this.getModelMetrics();
    const convSummary = this.getConversationSummary();
    const tokenStats = this.getGlobalTokenStats();

    let report = `=== LocalBot Metrics Report ===\n`;
    report += `Uptime: ${this.getUptimeString()}\n\n`;

    report += `--- Token Usage ---\n`;
    report += `Total requests: ${tokenStats.requestCount}\n`;
    report += `Input tokens: ${tokenStats.totalInput.toLocaleString()}\n`;
    report += `Output tokens: ${tokenStats.totalOutput.toLocaleString()}\n`;
    report += `Total tokens: ${tokenStats.totalTokens.toLocaleString()}\n\n`;

    report += `--- Tool Usage ---\n`;
    report += `Total calls: ${toolMetrics.totalToolCalls}\n`;
    report += `Successful: ${toolMetrics.successfulCalls} (${(toolMetrics.successfulCalls / (toolMetrics.totalToolCalls || 1) * 100).toFixed(1)}%)\n`;
    report += `Failed: ${toolMetrics.failedCalls}\n`;
    report += `Avg duration: ${toolMetrics.averageDuration.toFixed(0)}ms\n\n`;

    report += `--- By Tool ---\n`;
    for (const [name, data] of Object.entries(toolMetrics.toolBreakdown)) {
      report += `${name}: ${data.count} calls, ${(data.successRate * 100).toFixed(0)}% success, ${data.avgDuration.toFixed(0)}ms avg\n`;
    }
    report += '\n';

    report += `--- Model Usage ---\n`;
    for (const model of modelMetrics) {
      const tokens = model.totalTokens ? `, ${model.totalTokens.toLocaleString()} tokens` : '';
      report += `${model.model}: ${model.totalRequests} requests, ${model.averageLatency.toFixed(0)}ms avg, ${model.errors} errors${tokens}\n`;
    }
    report += '\n';

    report += `--- Conversations ---\n`;
    report += `Total: ${convSummary.total}\n`;
    report += `Avg messages: ${convSummary.avgMessageCount.toFixed(1)}\n`;
    report += `Avg tool calls: ${convSummary.avgToolCalls.toFixed(1)}\n`;

    return report;
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.toolInvocations = [];
    this.conversations = [];
    this.modelUsage.clear();
    this.startTime = new Date();
  }

  /**
   * Export metrics as JSON
   */
  export(): object {
    return {
      startTime: this.startTime.toISOString(),
      uptime: this.getUptime(),
      tools: this.getToolMetrics(),
      models: this.getModelMetrics(),
      conversations: this.getConversationSummary(),
      recentInvocations: this.getRecentInvocations(20),
    };
  }
}

/**
 * Global metrics collector instance
 */
export const globalMetrics = new MetricsCollector();
