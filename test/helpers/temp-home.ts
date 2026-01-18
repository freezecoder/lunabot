/**
 * Temporary home directory helper for tests
 * Provides isolated HOME/XDG directories for testing configuration
 */

import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

interface TempHomeContext {
  home: string;
  localbot: string;  // ~/.localbot
  config: string;    // ~/.config/localbot
  original: {
    HOME: string | undefined;
    XDG_CONFIG_HOME: string | undefined;
    XDG_DATA_HOME: string | undefined;
    LOCALBOT_HOME: string | undefined;
  };
}

const contexts: TempHomeContext[] = [];

/**
 * Create an isolated home directory for testing
 */
export async function createTempHome(prefix: string = 'localbot-home-'): Promise<TempHomeContext> {
  const home = await mkdtemp(join(tmpdir(), prefix));

  // Create standard directories
  const localbot = join(home, '.localbot');
  const config = join(home, '.config', 'localbot');

  await mkdir(localbot, { recursive: true });
  await mkdir(config, { recursive: true });

  // Store original env values
  const original = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALBOT_HOME: process.env.LOCALBOT_HOME,
  };

  const ctx: TempHomeContext = {
    home,
    localbot,
    config,
    original,
  };

  contexts.push(ctx);
  return ctx;
}

/**
 * Activate a temp home context (set environment variables)
 */
export function activateTempHome(ctx: TempHomeContext): void {
  process.env.HOME = ctx.home;
  process.env.XDG_CONFIG_HOME = join(ctx.home, '.config');
  process.env.XDG_DATA_HOME = join(ctx.home, '.local', 'share');
  process.env.LOCALBOT_HOME = ctx.localbot;
}

/**
 * Restore original home environment
 */
export function restoreTempHome(ctx: TempHomeContext): void {
  if (ctx.original.HOME !== undefined) {
    process.env.HOME = ctx.original.HOME;
  } else {
    delete process.env.HOME;
  }

  if (ctx.original.XDG_CONFIG_HOME !== undefined) {
    process.env.XDG_CONFIG_HOME = ctx.original.XDG_CONFIG_HOME;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }

  if (ctx.original.XDG_DATA_HOME !== undefined) {
    process.env.XDG_DATA_HOME = ctx.original.XDG_DATA_HOME;
  } else {
    delete process.env.XDG_DATA_HOME;
  }

  if (ctx.original.LOCALBOT_HOME !== undefined) {
    process.env.LOCALBOT_HOME = ctx.original.LOCALBOT_HOME;
  } else {
    delete process.env.LOCALBOT_HOME;
  }
}

/**
 * Clean up a temp home context
 */
export async function cleanupTempHome(ctx: TempHomeContext): Promise<void> {
  restoreTempHome(ctx);

  try {
    await rm(ctx.home, { recursive: true, force: true });
    const index = contexts.indexOf(ctx);
    if (index > -1) {
      contexts.splice(index, 1);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up all temp home contexts
 */
export async function cleanupAllTempHomes(): Promise<void> {
  for (const ctx of [...contexts]) {
    await cleanupTempHome(ctx);
  }
}

/**
 * Create a temp home with pre-populated files
 */
export async function createTempHomeWithFiles(
  files: Record<string, string>,
  prefix?: string
): Promise<TempHomeContext> {
  const ctx = await createTempHome(prefix);

  for (const [path, content] of Object.entries(files)) {
    const fullPath = path.startsWith('~/')
      ? join(ctx.home, path.slice(2))
      : join(ctx.localbot, path);

    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dirPath, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  return ctx;
}

/**
 * Helper for using temp home in tests
 */
export function useTempHome(prefix?: string) {
  let ctx: TempHomeContext;

  return {
    async setup() {
      ctx = await createTempHome(prefix);
      activateTempHome(ctx);
      return ctx;
    },
    async setupWithFiles(files: Record<string, string>) {
      ctx = await createTempHomeWithFiles(files, prefix);
      activateTempHome(ctx);
      return ctx;
    },
    async cleanup() {
      if (ctx) {
        await cleanupTempHome(ctx);
      }
    },
    get context() {
      return ctx;
    },
  };
}
