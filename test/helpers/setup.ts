/**
 * Vitest setup file - runs before all tests
 */

import { beforeAll, afterAll, afterEach } from 'vitest';
import { cleanupTempDirs } from './temp-dir.js';
import { restoreEnv } from './env.js';

// Global setup
beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = 'test';

  // Disable colors in tests for cleaner output
  process.env.NO_COLOR = '1';
});

// Clean up after each test
afterEach(() => {
  restoreEnv();
});

// Global teardown
afterAll(async () => {
  await cleanupTempDirs();
});
