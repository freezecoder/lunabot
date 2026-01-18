/**
 * Temporary directory helper for tests
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Track created temp dirs for cleanup
const tempDirs: string[] = [];

/**
 * Create a temporary directory for testing
 */
export async function createTempDir(prefix: string = 'localbot-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a temporary directory with pre-populated files
 */
export async function createTempDirWithFiles(
  files: Record<string, string>,
  prefix: string = 'localbot-test-'
): Promise<string> {
  const dir = await createTempDir(prefix);

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    // Create parent directories if needed
    if (dirPath !== dir) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(fullPath, content, 'utf-8');
  }

  return dir;
}

/**
 * Read a file from a temp directory
 */
export async function readTempFile(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), 'utf-8');
}

/**
 * Write a file to a temp directory
 */
export async function writeTempFile(dir: string, path: string, content: string): Promise<void> {
  const fullPath = join(dir, path);
  const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

  // Create parent directories if needed
  await mkdir(dirPath, { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

/**
 * Clean up a specific temp directory
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    const index = tempDirs.indexOf(dir);
    if (index > -1) {
      tempDirs.splice(index, 1);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up all temp directories
 */
export async function cleanupTempDirs(): Promise<void> {
  for (const dir of [...tempDirs]) {
    await cleanupTempDir(dir);
  }
}

/**
 * Create a fixture for testing with auto-cleanup
 */
export function useTempDir(prefix?: string) {
  let dir: string;

  return {
    async setup() {
      dir = await createTempDir(prefix);
      return dir;
    },
    async setupWithFiles(files: Record<string, string>) {
      dir = await createTempDirWithFiles(files, prefix);
      return dir;
    },
    async cleanup() {
      if (dir) {
        await cleanupTempDir(dir);
      }
    },
    get path() {
      return dir;
    },
  };
}
