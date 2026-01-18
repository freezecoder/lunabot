/**
 * Token Tracking - Track token usage from LLM responses
 */

export interface TokenUsage {
  input: number;           // prompt_eval_count
  output: number;          // eval_count
  total: number;
  contextPercentage?: number;
  model?: string;
  timestamp: Date;
}

export interface SessionTokenStats {
  sessionId: string;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  requestCount: number;
  averageInput: number;
  averageOutput: number;
  history: TokenUsage[];
}

export interface GlobalTokenStats {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  requestCount: number;
  bySession: Map<string, SessionTokenStats>;
  byModel: Map<string, { input: number; output: number; count: number }>;
}

/**
 * Model context window sizes (approximate)
 */
export const MODEL_CONTEXT_SIZES: Record<string, number> = {
  'llama3.1:8b': 131072,
  'llama3.1:70b': 131072,
  'llama3.1:405b': 131072,
  'llama3.2:1b': 131072,
  'llama3.2:3b': 131072,
  'qwen2.5:0.5b': 32768,
  'qwen2.5:1.5b': 32768,
  'qwen2.5:3b': 32768,
  'qwen2.5:7b': 32768,
  'qwen2.5:14b': 32768,
  'qwen2.5:32b': 32768,
  'qwen2.5:72b': 131072,
  'qwen2.5-coder:7b': 32768,
  'qwen2.5-coder:14b': 32768,
  'qwen2.5-coder:32b': 32768,
  'mistral:7b': 32768,
  'mixtral:8x7b': 32768,
  'mixtral:8x22b': 65536,
  'deepseek-r1:7b': 65536,
  'deepseek-r1:14b': 65536,
  'deepseek-r1:32b': 65536,
  'deepseek-r1:70b': 65536,
  'gemma2:2b': 8192,
  'gemma2:9b': 8192,
  'gemma2:27b': 8192,
  'phi3:mini': 4096,
  'phi3:medium': 128000,
  'phi3.5:3.8b': 128000,
};

/**
 * Get context window size for a model
 */
export function getContextWindowSize(model: string): number {
  // Try exact match first
  if (MODEL_CONTEXT_SIZES[model]) {
    return MODEL_CONTEXT_SIZES[model];
  }

  // Try base model name (without tags)
  const baseName = model.split(':')[0];
  for (const [key, size] of Object.entries(MODEL_CONTEXT_SIZES)) {
    if (key.startsWith(baseName)) {
      return size;
    }
  }

  // Default to 32K for unknown models
  return 32768;
}

/**
 * Calculate context percentage used
 */
export function calculateContextPercentage(inputTokens: number, model: string): number {
  const contextSize = getContextWindowSize(model);
  return Math.min(100, (inputTokens / contextSize) * 100);
}

/**
 * Token tracker class
 */
export class TokenTracker {
  private sessions: Map<string, SessionTokenStats> = new Map();
  private modelStats: Map<string, { input: number; output: number; count: number }> = new Map();
  private globalTotals = { input: 0, output: 0, requests: 0 };

  /**
   * Record token usage for a session
   */
  recordUsage(sessionId: string, usage: Omit<TokenUsage, 'timestamp'>): void {
    const timestamp = new Date();
    const fullUsage: TokenUsage = { ...usage, timestamp };

    // Get or create session stats
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
        requestCount: 0,
        averageInput: 0,
        averageOutput: 0,
        history: [],
      };
      this.sessions.set(sessionId, session);
    }

    // Update session stats
    session.totalInput += usage.input;
    session.totalOutput += usage.output;
    session.totalTokens += usage.total;
    session.requestCount++;
    session.averageInput = session.totalInput / session.requestCount;
    session.averageOutput = session.totalOutput / session.requestCount;
    session.history.push(fullUsage);

    // Keep only last 100 entries in history
    if (session.history.length > 100) {
      session.history = session.history.slice(-100);
    }

    // Update model stats
    if (usage.model) {
      const modelStat = this.modelStats.get(usage.model) || { input: 0, output: 0, count: 0 };
      modelStat.input += usage.input;
      modelStat.output += usage.output;
      modelStat.count++;
      this.modelStats.set(usage.model, modelStat);
    }

    // Update global totals
    this.globalTotals.input += usage.input;
    this.globalTotals.output += usage.output;
    this.globalTotals.requests++;
  }

  /**
   * Get session token stats
   */
  getSessionStats(sessionId: string): SessionTokenStats | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get global token stats
   */
  getGlobalStats(): GlobalTokenStats {
    return {
      totalInput: this.globalTotals.input,
      totalOutput: this.globalTotals.output,
      totalTokens: this.globalTotals.input + this.globalTotals.output,
      requestCount: this.globalTotals.requests,
      bySession: new Map(this.sessions),
      byModel: new Map(this.modelStats),
    };
  }

  /**
   * Get last usage for a session
   */
  getLastUsage(sessionId: string): TokenUsage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.history.length === 0) return undefined;
    return session.history[session.history.length - 1];
  }

  /**
   * Clear session stats
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clear all stats
   */
  clear(): void {
    this.sessions.clear();
    this.modelStats.clear();
    this.globalTotals = { input: 0, output: 0, requests: 0 };
  }

  /**
   * Format usage for display
   */
  formatUsage(usage: TokenUsage, model?: string): string {
    const contextPct = usage.contextPercentage ??
      (model ? calculateContextPercentage(usage.input, model) : undefined);

    const parts = [
      `↓${usage.input}`,
      `↑${usage.output}`,
      `Σ${usage.total}`,
    ];

    if (contextPct !== undefined) {
      parts.push(`ctx:${contextPct.toFixed(1)}%`);
    }

    return parts.join(' | ');
  }

  /**
   * Format session stats for display
   */
  formatSessionStats(sessionId: string): string | undefined {
    const stats = this.getSessionStats(sessionId);
    if (!stats) return undefined;

    return [
      `Session: ${sessionId}`,
      `  Requests: ${stats.requestCount}`,
      `  Input: ${stats.totalInput} tokens (avg: ${Math.round(stats.averageInput)})`,
      `  Output: ${stats.totalOutput} tokens (avg: ${Math.round(stats.averageOutput)})`,
      `  Total: ${stats.totalTokens} tokens`,
    ].join('\n');
  }

  /**
   * Format global stats for display
   */
  formatGlobalStats(): string {
    const stats = this.getGlobalStats();

    const lines = [
      '=== Token Usage Statistics ===',
      `Total Requests: ${stats.requestCount}`,
      `Total Input: ${stats.totalInput.toLocaleString()} tokens`,
      `Total Output: ${stats.totalOutput.toLocaleString()} tokens`,
      `Total: ${stats.totalTokens.toLocaleString()} tokens`,
      '',
    ];

    if (stats.byModel.size > 0) {
      lines.push('By Model:');
      for (const [model, modelStats] of stats.byModel) {
        lines.push(`  ${model}:`);
        lines.push(`    Requests: ${modelStats.count}`);
        lines.push(`    Input: ${modelStats.input.toLocaleString()} | Output: ${modelStats.output.toLocaleString()}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Export stats as JSON
   */
  export(): object {
    const stats = this.getGlobalStats();
    return {
      global: {
        totalInput: stats.totalInput,
        totalOutput: stats.totalOutput,
        totalTokens: stats.totalTokens,
        requestCount: stats.requestCount,
      },
      byModel: Object.fromEntries(stats.byModel),
      sessions: Object.fromEntries(
        Array.from(stats.bySession.entries()).map(([id, s]) => [
          id,
          {
            totalInput: s.totalInput,
            totalOutput: s.totalOutput,
            totalTokens: s.totalTokens,
            requestCount: s.requestCount,
          },
        ])
      ),
    };
  }
}

/**
 * Global token tracker instance
 */
export const globalTokenTracker = new TokenTracker();
