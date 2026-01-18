/**
 * Environment variable helpers for tests
 */

// Store original environment values
const originalEnv: Map<string, string | undefined> = new Map();
const modifiedKeys: Set<string> = new Set();

/**
 * Set an environment variable and track it for restoration
 */
export function setEnv(key: string, value: string): void {
  if (!originalEnv.has(key)) {
    originalEnv.set(key, process.env[key]);
  }
  modifiedKeys.add(key);
  process.env[key] = value;
}

/**
 * Delete an environment variable and track it for restoration
 */
export function deleteEnv(key: string): void {
  if (!originalEnv.has(key)) {
    originalEnv.set(key, process.env[key]);
  }
  modifiedKeys.add(key);
  delete process.env[key];
}

/**
 * Restore all modified environment variables
 */
export function restoreEnv(): void {
  for (const key of modifiedKeys) {
    const original = originalEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  originalEnv.clear();
  modifiedKeys.clear();
}

/**
 * Run a function with modified environment
 */
export async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const saved: Record<string, string | undefined> = {};

  // Save and set new values
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    // Restore original values
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Create a scoped environment for tests
 */
export function useEnv() {
  const changes: Map<string, string | undefined> = new Map();
  const originals: Map<string, string | undefined> = new Map();

  return {
    set(key: string, value: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      changes.set(key, value);
      process.env[key] = value;
    },
    delete(key: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      changes.set(key, undefined);
      delete process.env[key];
    },
    restore() {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      changes.clear();
      originals.clear();
    },
    get current() {
      return Object.fromEntries(changes);
    },
  };
}
