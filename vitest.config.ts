import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable globals like describe, it, expect
    globals: true,

    // Test file patterns
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],

    // Exclude patterns
    exclude: ['node_modules', 'dist'],

    // Environment
    environment: 'node',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/index.ts',
        'src/terminal/ui.ts',
        'src/telegram/bot.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },

    // Test timeout
    testTimeout: 10000,

    // Setup files
    setupFiles: ['./test/helpers/setup.ts'],

    // Reporter
    reporters: ['verbose'],

    // Pool options for parallelization
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },
});
