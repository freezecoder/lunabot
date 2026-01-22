/**
 * Session Summarizer - Generates intelligent summaries of conversations using LLM
 */

import { Ollama } from 'ollama';
import type { SessionWithMessages, Channel } from '../db/types.js';
import { createHash } from 'crypto';

/**
 * Summary of a conversation session
 */
export interface SessionSummary {
  sessionId: string;
  channel: Channel;
  userId: string;
  model: string;
  messageCount: number;
  startedAt: Date;
  endedAt: Date;
  summary: string;
  highlights: string[];
  toolsUsed: string[];
  hash: string;
}

/**
 * Configuration for the summarizer
 */
export interface SummarizerConfig {
  ollamaHost: string;
  model: string;
  maxContextLength: number;
  fallbackToExtraction: boolean;
}

const DEFAULT_CONFIG: SummarizerConfig = {
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  model: process.env.DEFAULT_MODEL || 'llama3.1:8b',
  maxContextLength: 8000,
  fallbackToExtraction: true,
};

const SUMMARY_PROMPT = `You are a conversation summarizer. Summarize the following conversation between a user and an AI assistant.

Focus on:
- Key topics discussed
- Decisions made or conclusions reached
- Important information shared
- Actions taken or tools used

Keep the summary concise (2-4 paragraphs). Use bullet points for key highlights.

Conversation:
`;

/**
 * Session Summarizer class
 */
export class SessionSummarizer {
  private client: Ollama;
  private config: SummarizerConfig;

  constructor(config?: Partial<SummarizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = new Ollama({ host: this.config.ollamaHost });
  }

  /**
   * Generate a summary for a session using LLM
   */
  async summarize(session: SessionWithMessages): Promise<SessionSummary> {
    const messages = session.messages;

    if (messages.length === 0) {
      return this.createEmptySummary(session);
    }

    // Extract tools used from messages
    const toolsUsed = this.extractToolsUsed(session);

    // Prepare conversation text for LLM
    const conversationText = this.formatConversation(session);
    const hash = this.generateHash(conversationText);

    // Try LLM summarization
    let summary: string;
    let highlights: string[];

    try {
      const result = await this.generateLLMSummary(conversationText);
      summary = result.summary;
      highlights = result.highlights;
    } catch (error) {
      console.warn('[Summarizer] LLM summarization failed, falling back to extraction:', error);

      if (this.config.fallbackToExtraction) {
        const extracted = this.extractSummary(session);
        summary = extracted.summary;
        highlights = extracted.highlights;
      } else {
        throw error;
      }
    }

    return {
      sessionId: session.id,
      channel: session.channel,
      userId: session.userId,
      model: session.model,
      messageCount: session.messageCount,
      startedAt: session.createdAt,
      endedAt: session.updatedAt,
      summary,
      highlights,
      toolsUsed,
      hash,
    };
  }

  /**
   * Generate summary using LLM
   */
  private async generateLLMSummary(conversationText: string): Promise<{ summary: string; highlights: string[] }> {
    // Truncate if too long
    const truncatedText = conversationText.length > this.config.maxContextLength
      ? conversationText.slice(0, this.config.maxContextLength) + '\n\n[Conversation truncated...]'
      : conversationText;

    const response = await this.client.chat({
      model: this.config.model,
      messages: [
        {
          role: 'user',
          content: SUMMARY_PROMPT + truncatedText + '\n\nProvide a concise summary:',
        },
      ],
      stream: false,
    });

    const content = response.message.content;

    // Parse highlights from bullet points
    const highlights = this.parseHighlights(content);

    return {
      summary: content,
      highlights,
    };
  }

  /**
   * Fallback: Extract summary without LLM
   */
  private extractSummary(session: SessionWithMessages): { summary: string; highlights: string[] } {
    const messages = session.messages;
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    // Create a simple summary from first and last exchanges
    const parts: string[] = [];
    const highlights: string[] = [];

    if (userMessages.length > 0) {
      const firstUser = userMessages[0].content.slice(0, 200);
      parts.push(`**Initial request:** ${firstUser}${firstUser.length >= 200 ? '...' : ''}`);
      highlights.push(firstUser.slice(0, 100));
    }

    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1].content.slice(0, 200);
      parts.push(`**Final response:** ${lastAssistant}${lastAssistant.length >= 200 ? '...' : ''}`);
    }

    // Add message count
    parts.push(`\n**Statistics:** ${userMessages.length} user messages, ${assistantMessages.length} assistant responses`);

    // Add tools if any
    const tools = this.extractToolsUsed(session);
    if (tools.length > 0) {
      parts.push(`**Tools used:** ${tools.join(', ')}`);
      highlights.push(`Used tools: ${tools.slice(0, 3).join(', ')}`);
    }

    return {
      summary: parts.join('\n\n'),
      highlights,
    };
  }

  /**
   * Create an empty summary for sessions with no messages
   */
  private createEmptySummary(session: SessionWithMessages): SessionSummary {
    return {
      sessionId: session.id,
      channel: session.channel,
      userId: session.userId,
      model: session.model,
      messageCount: 0,
      startedAt: session.createdAt,
      endedAt: session.updatedAt,
      summary: 'Empty session - no conversation recorded.',
      highlights: [],
      toolsUsed: [],
      hash: this.generateHash(''),
    };
  }

  /**
   * Format conversation for LLM input
   */
  private formatConversation(session: SessionWithMessages): string {
    const lines: string[] = [];

    for (const msg of session.messages) {
      if (msg.role === 'user') {
        lines.push(`User: ${msg.content}`);
      } else if (msg.role === 'assistant') {
        // Skip tool call JSON, just include text content
        if (msg.content && !msg.content.startsWith('{')) {
          lines.push(`Assistant: ${msg.content}`);
        }
      } else if (msg.role === 'tool') {
        // Summarize tool results briefly
        const preview = msg.content.slice(0, 100);
        lines.push(`[Tool ${msg.name || 'result'}: ${preview}${msg.content.length > 100 ? '...' : ''}]`);
      }
    }

    return lines.join('\n\n');
  }

  /**
   * Extract tools used from session messages
   */
  private extractToolsUsed(session: SessionWithMessages): string[] {
    const tools = new Set<string>();

    for (const msg of session.messages) {
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc && typeof tc === 'object' && 'function' in tc) {
            const fn = tc.function as { name?: string };
            if (fn.name) {
              tools.add(fn.name);
            }
          }
        }
      }
    }

    return Array.from(tools);
  }

  /**
   * Parse highlights from summary text (bullet points)
   */
  private parseHighlights(text: string): string[] {
    const highlights: string[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Match bullet points: -, *, •, or numbered lists
      if (/^[-*•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
        const content = trimmed.replace(/^[-*•\d.]+\s+/, '').slice(0, 150);
        if (content.length > 10) {
          highlights.push(content);
        }
      }
    }

    return highlights.slice(0, 5); // Max 5 highlights
  }

  /**
   * Generate a hash for the conversation content
   */
  private generateHash(content: string): string {
    return createHash('md5').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Format a summary for memory file output
   */
  formatForMemory(summary: SessionSummary): string {
    const timestamp = summary.endedAt.toISOString();
    const lines: string[] = [
      `## Session: ${summary.sessionId.slice(0, 8)}`,
      `*${summary.channel} | ${summary.userId} | ${timestamp}*`,
      `*Model: ${summary.model} | Messages: ${summary.messageCount}*`,
      '',
      summary.summary,
    ];

    if (summary.toolsUsed.length > 0) {
      lines.push('', `**Tools:** ${summary.toolsUsed.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Format multiple summaries for a daily memory file
   */
  formatDailySummaries(summaries: SessionSummary[]): string {
    if (summaries.length === 0) {
      return '';
    }

    const parts = summaries.map(s => this.formatForMemory(s));
    return parts.join('\n\n---\n\n');
  }
}

/**
 * Create a summarizer instance
 */
export function createSummarizer(config?: Partial<SummarizerConfig>): SessionSummarizer {
  return new SessionSummarizer(config);
}
