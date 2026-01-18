/**
 * File Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileTool, writeFileTool, editFileTool, listFilesTool } from './files.js';
import { useTempDir, writeTempFile, readTempFile } from '../../../test/helpers/temp-dir.js';
import { join } from 'path';

describe('readFileTool', () => {
  const tempDir = useTempDir('file-test-');

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it('should read a file with line numbers', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'Line 1\nLine 2\nLine 3',
    });

    const result = await readFileTool.execute({ path: join(dir, 'test.txt') });

    expect(result).toContain('1 | Line 1');
    expect(result).toContain('2 | Line 2');
    expect(result).toContain('3 | Line 3');
  });

  it('should support offset and limit', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
    });

    const result = await readFileTool.execute({
      path: join(dir, 'test.txt'),
      offset: 1,
      limit: 2,
    });

    expect(result).toContain('[Showing lines 2-3 of 5]');
    expect(result).toContain('2 | Line 2');
    expect(result).toContain('3 | Line 3');
    expect(result).not.toContain('Line 1');
    expect(result).not.toContain('Line 4');
  });

  it('should return error for non-existent file', async () => {
    await tempDir.setup();
    const result = await readFileTool.execute({ path: '/nonexistent/file.txt' });

    expect(result).toContain('Error: File not found');
  });

  it('should handle binary file detection', async () => {
    const dir = await tempDir.setup();
    const { writeFile } = await import('fs/promises');

    // Write a file with null bytes (binary)
    const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00]);
    await writeFile(join(dir, 'test.png'), binaryContent);

    const result = await readFileTool.execute({ path: join(dir, 'test.png') });

    expect(result).toContain('Binary file');
    expect(result).toContain('.png');
  });

  it('should handle empty files', async () => {
    const dir = await tempDir.setupWithFiles({
      'empty.txt': '',
    });

    const result = await readFileTool.execute({ path: join(dir, 'empty.txt') });

    // Should not error, just show empty content
    expect(result).not.toContain('Error');
  });
});

describe('writeFileTool', () => {
  const tempDir = useTempDir('file-test-');

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it('should create a new file', async () => {
    const dir = await tempDir.setup();
    const path = join(dir, 'new.txt');

    const result = await writeFileTool.execute({
      path,
      content: 'Hello, World!',
    });

    expect(result).toContain('created');
    expect(result).toContain('new.txt');

    const content = await readTempFile(dir, 'new.txt');
    expect(content).toBe('Hello, World!');
  });

  it('should overwrite existing file', async () => {
    const dir = await tempDir.setupWithFiles({
      'existing.txt': 'Old content',
    });
    const path = join(dir, 'existing.txt');

    const result = await writeFileTool.execute({
      path,
      content: 'New content',
    });

    expect(result).toContain('overwrote');

    const content = await readTempFile(dir, 'existing.txt');
    expect(content).toBe('New content');
  });

  it('should create parent directories', async () => {
    const dir = await tempDir.setup();
    const path = join(dir, 'subdir', 'nested', 'file.txt');

    const result = await writeFileTool.execute({
      path,
      content: 'Nested content',
    });

    expect(result).toContain('created');

    const content = await readTempFile(dir, 'subdir/nested/file.txt');
    expect(content).toBe('Nested content');
  });

  it('should report line and byte counts', async () => {
    const dir = await tempDir.setup();
    const path = join(dir, 'test.txt');

    const result = await writeFileTool.execute({
      path,
      content: 'Line 1\nLine 2\nLine 3',
    });

    expect(result).toContain('3 lines');
  });
});

describe('editFileTool', () => {
  const tempDir = useTempDir('file-test-');

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it('should replace text in file', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'Hello, World!',
    });
    const path = join(dir, 'test.txt');

    const result = await editFileTool.execute({
      path,
      old_string: 'World',
      new_string: 'Universe',
    });

    expect(result).toContain('Successfully edited');
    expect(result).toContain('1 occurrence');

    const content = await readTempFile(dir, 'test.txt');
    expect(content).toBe('Hello, Universe!');
  });

  it('should error when text not found', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'Hello, World!',
    });
    const path = join(dir, 'test.txt');

    const result = await editFileTool.execute({
      path,
      old_string: 'nonexistent',
      new_string: 'replacement',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Could not find');
  });

  it('should error when multiple occurrences without replace_all', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'foo bar foo baz foo',
    });
    const path = join(dir, 'test.txt');

    const result = await editFileTool.execute({
      path,
      old_string: 'foo',
      new_string: 'qux',
    });

    expect(result).toContain('Error');
    expect(result).toContain('3 occurrences');
  });

  it('should replace all occurrences with replace_all', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': 'foo bar foo baz foo',
    });
    const path = join(dir, 'test.txt');

    const result = await editFileTool.execute({
      path,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
    });

    expect(result).toContain('3 occurrences');

    const content = await readTempFile(dir, 'test.txt');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('should handle whitespace correctly', async () => {
    const dir = await tempDir.setupWithFiles({
      'test.txt': '  indented\n    more indented',
    });
    const path = join(dir, 'test.txt');

    const result = await editFileTool.execute({
      path,
      old_string: '  indented',
      new_string: 'not indented',
    });

    expect(result).toContain('Successfully edited');

    const content = await readTempFile(dir, 'test.txt');
    expect(content).toBe('not indented\n    more indented');
  });
});

describe('listFilesTool', () => {
  const tempDir = useTempDir('file-test-');

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it('should list files and directories', async () => {
    const dir = await tempDir.setupWithFiles({
      'file1.txt': 'content',
      'file2.js': 'code',
      'subdir/nested.txt': 'nested',
    });

    const result = await listFilesTool.execute({ path: dir });

    expect(result).toContain('file1.txt');
    expect(result).toContain('file2.js');
    expect(result).toContain('subdir');
  });

  it('should show directory icon for directories', async () => {
    const dir = await tempDir.setupWithFiles({
      'subdir/file.txt': 'content',
    });

    const result = await listFilesTool.execute({ path: dir });

    // Directories should be listed with folder icon
    expect(result).toMatch(/📁.*subdir/);
  });

  it('should show file sizes', async () => {
    const dir = await tempDir.setupWithFiles({
      'small.txt': 'small content',
    });

    const result = await listFilesTool.execute({ path: dir });

    expect(result).toContain('small.txt');
    // Should show size for files
    expect(result).toMatch(/small\.txt.*\(/);
  });

  it('should return error for non-existent directory', async () => {
    const result = await listFilesTool.execute({ path: '/nonexistent/directory' });

    expect(result).toContain('Error');
  });

  it('should sort directories first', async () => {
    const dir = await tempDir.setupWithFiles({
      'zebra.txt': 'content',
      'alpha.txt': 'content',
      'subdir/file.txt': 'nested',
    });

    const result = await listFilesTool.execute({ path: dir });
    const lines = result.split('\n').filter(l => l.includes('📁') || l.includes('📄'));

    // First non-empty line should be the directory
    const firstItem = lines.find(l => l.includes('📁') || l.includes('📄'));
    expect(firstItem).toContain('📁');
    expect(firstItem).toContain('subdir');
  });
});
