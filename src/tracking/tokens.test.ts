/**
 * Token Tracking Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TokenTracker,
  globalTokenTracker,
  getContextWindowSize,
  calculateContextPercentage,
  MODEL_CONTEXT_SIZES,
} from './tokens.js';

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  describe('recordUsage', () => {
    it('should record token usage for a session', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      const stats = tracker.getSessionStats('session-1');
      expect(stats).toBeDefined();
      expect(stats!.totalInput).toBe(100);
      expect(stats!.totalOutput).toBe(50);
      expect(stats!.totalTokens).toBe(150);
      expect(stats!.requestCount).toBe(1);
    });

    it('should accumulate usage across multiple requests', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.recordUsage('session-1', {
        input: 200,
        output: 100,
        total: 300,
        model: 'llama3.1:8b',
      });

      const stats = tracker.getSessionStats('session-1');
      expect(stats!.totalInput).toBe(300);
      expect(stats!.totalOutput).toBe(150);
      expect(stats!.totalTokens).toBe(450);
      expect(stats!.requestCount).toBe(2);
      expect(stats!.averageInput).toBe(150);
      expect(stats!.averageOutput).toBe(75);
    });

    it('should track multiple sessions independently', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.recordUsage('session-2', {
        input: 200,
        output: 100,
        total: 300,
        model: 'qwen2.5:7b',
      });

      const stats1 = tracker.getSessionStats('session-1');
      const stats2 = tracker.getSessionStats('session-2');

      expect(stats1!.totalTokens).toBe(150);
      expect(stats2!.totalTokens).toBe(300);
    });

    it('should track usage by model', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.recordUsage('session-1', {
        input: 200,
        output: 100,
        total: 300,
        model: 'qwen2.5:7b',
      });

      const globalStats = tracker.getGlobalStats();
      const llamaStats = globalStats.byModel.get('llama3.1:8b');
      const qwenStats = globalStats.byModel.get('qwen2.5:7b');

      expect(llamaStats).toBeDefined();
      expect(llamaStats!.input).toBe(100);
      expect(llamaStats!.output).toBe(50);
      expect(llamaStats!.count).toBe(1);

      expect(qwenStats).toBeDefined();
      expect(qwenStats!.input).toBe(200);
      expect(qwenStats!.output).toBe(100);
      expect(qwenStats!.count).toBe(1);
    });
  });

  describe('getGlobalStats', () => {
    it('should aggregate stats across all sessions', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.recordUsage('session-2', {
        input: 200,
        output: 100,
        total: 300,
        model: 'llama3.1:8b',
      });

      const globalStats = tracker.getGlobalStats();
      expect(globalStats.totalInput).toBe(300);
      expect(globalStats.totalOutput).toBe(150);
      expect(globalStats.totalTokens).toBe(450);
      expect(globalStats.requestCount).toBe(2);
    });
  });

  describe('getLastUsage', () => {
    it('should return the most recent usage', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.recordUsage('session-1', {
        input: 200,
        output: 100,
        total: 300,
        model: 'llama3.1:8b',
      });

      const last = tracker.getLastUsage('session-1');
      expect(last).toBeDefined();
      expect(last!.input).toBe(200);
      expect(last!.output).toBe(100);
    });

    it('should return undefined for unknown session', () => {
      const last = tracker.getLastUsage('unknown');
      expect(last).toBeUndefined();
    });
  });

  describe('clearSession', () => {
    it('should remove session stats', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.clearSession('session-1');

      const stats = tracker.getSessionStats('session-1');
      expect(stats).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all stats', () => {
      tracker.recordUsage('session-1', {
        input: 100,
        output: 50,
        total: 150,
        model: 'llama3.1:8b',
      });

      tracker.clear();

      const globalStats = tracker.getGlobalStats();
      expect(globalStats.totalTokens).toBe(0);
      expect(globalStats.requestCount).toBe(0);
    });
  });

  describe('formatUsage', () => {
    it('should format usage correctly', () => {
      const usage = {
        input: 1000,
        output: 500,
        total: 1500,
        timestamp: new Date(),
      };

      const formatted = tracker.formatUsage(usage, 'llama3.1:8b');
      expect(formatted).toContain('↓1000');
      expect(formatted).toContain('↑500');
      expect(formatted).toContain('Σ1500');
      expect(formatted).toContain('ctx:');
    });
  });

  describe('history limit', () => {
    it('should limit history to 100 entries', () => {
      for (let i = 0; i < 120; i++) {
        tracker.recordUsage('session-1', {
          input: i,
          output: i,
          total: i * 2,
          model: 'llama3.1:8b',
        });
      }

      const stats = tracker.getSessionStats('session-1');
      expect(stats!.history.length).toBe(100);
      // Should keep the most recent entries
      expect(stats!.history[0].input).toBe(20);
      expect(stats!.history[99].input).toBe(119);
    });
  });
});

describe('getContextWindowSize', () => {
  it('should return known model sizes', () => {
    expect(getContextWindowSize('llama3.1:8b')).toBe(131072);
    expect(getContextWindowSize('qwen2.5:7b')).toBe(32768);
    expect(getContextWindowSize('mistral:7b')).toBe(32768);
  });

  it('should match by base model name', () => {
    expect(getContextWindowSize('llama3.1:latest')).toBe(131072);
    expect(getContextWindowSize('qwen2.5:latest')).toBe(32768);
  });

  it('should return default for unknown models', () => {
    expect(getContextWindowSize('unknown-model')).toBe(32768);
  });
});

describe('calculateContextPercentage', () => {
  it('should calculate percentage correctly', () => {
    // llama3.1 has 131072 context
    const pct = calculateContextPercentage(13107, 'llama3.1:8b');
    expect(pct).toBeCloseTo(10, 0);
  });

  it('should cap at 100%', () => {
    const pct = calculateContextPercentage(200000, 'llama3.1:8b');
    expect(pct).toBe(100);
  });

  it('should handle small inputs', () => {
    const pct = calculateContextPercentage(100, 'llama3.1:8b');
    expect(pct).toBeLessThan(1);
  });
});

describe('globalTokenTracker', () => {
  afterEach(() => {
    globalTokenTracker.clear();
  });

  it('should be a singleton instance', () => {
    globalTokenTracker.recordUsage('test-session', {
      input: 100,
      output: 50,
      total: 150,
      model: 'test-model',
    });

    const stats = globalTokenTracker.getGlobalStats();
    expect(stats.requestCount).toBe(1);
  });
});
