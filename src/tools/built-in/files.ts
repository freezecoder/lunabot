/**
 * File operation tools - read, write, edit files
 */

import { readFile, writeFile, stat, mkdir, access } from 'fs/promises';
import { constants } from 'fs';
import { dirname, extname } from 'path';
import { defineTool } from '../registry.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LINES = 2000;

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.sqlite3',
]);

/**
 * Check if a file appears to be binary
 */
function isBinaryFile(path: string, buffer?: Buffer): boolean {
  // Check extension first
  const ext = extname(path).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  // Check content for null bytes (common in binary files)
  if (buffer) {
    for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Format error message based on error code
 */
function formatFileError(error: NodeJS.ErrnoException, path: string, operation: string): string {
  switch (error.code) {
    case 'ENOENT':
      return `Error: File not found: ${path}`;
    case 'EISDIR':
      return `Error: Path is a directory, not a file: ${path}`;
    case 'ENOTDIR':
      return `Error: A component of the path is not a directory: ${path}`;
    case 'EACCES':
      return `Error: Permission denied - cannot ${operation} file: ${path}`;
    case 'EPERM':
      return `Error: Operation not permitted on file: ${path}`;
    case 'EROFS':
      return `Error: Read-only file system - cannot ${operation} file: ${path}`;
    case 'ENOSPC':
      return `Error: No space left on device`;
    case 'EMFILE':
      return `Error: Too many open files`;
    case 'ELOOP':
      return `Error: Too many symbolic links in path: ${path}`;
    default:
      return `Error: ${error.message || 'Unknown error'} (${operation} ${path})`;
  }
}

/**
 * Read file tool
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read the contents of a file. Returns the file content with line numbers. For large files, you can specify offset and limit. Binary files will show a message instead of content.',
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute or relative path to the file to read',
      isRequired: true,
    },
    offset: {
      type: 'number',
      description: 'Line number to start reading from (0-indexed, default: 0)',
    },
    limit: {
      type: 'number',
      description: `Maximum number of lines to read (default: ${MAX_LINES})`,
    },
    encoding: {
      type: 'string',
      description: 'File encoding (default: utf-8). Supported: utf-8, ascii, latin1, base64',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const path = args.path as string;
    const offset = (args.offset as number) || 0;
    const limit = Math.min((args.limit as number) || MAX_LINES, MAX_LINES);
    const encoding = (args.encoding as BufferEncoding) || 'utf-8';

    try {
      const stats = await stat(path);

      if (stats.size > MAX_FILE_SIZE) {
        return `Error: File is too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`;
      }

      // Read as buffer first to check for binary
      const buffer = await readFile(path);

      // Check if binary
      if (isBinaryFile(path, buffer)) {
        return `[Binary file: ${path}]\nSize: ${formatSize(stats.size)}\nType: ${extname(path) || 'unknown'}\n\nBinary files cannot be displayed as text. Use appropriate tools to handle this file type.`;
      }

      const content = buffer.toString(encoding);
      const lines = content.split('\n');
      const totalLines = lines.length;

      // Apply offset and limit
      const selectedLines = lines.slice(offset, offset + limit);

      // Add line numbers
      const numberedLines = selectedLines.map((line, i) => {
        const lineNum = offset + i + 1;
        return `${String(lineNum).padStart(6)} | ${line}`;
      });

      let result = numberedLines.join('\n');

      // Add metadata
      if (offset > 0 || offset + limit < totalLines) {
        result = `[Showing lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines}]\n\n${result}`;
      }

      return result;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return formatFileError(err, path, 'read');
    }
  },
});

/**
 * Write file tool
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does. Creates parent directories if needed.',
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute or relative path to the file to write',
      isRequired: true,
    },
    content: {
      type: 'string',
      description: 'Content to write to the file',
      isRequired: true,
    },
  },
  timeout: 30000,
  requiresConfirmation: true,

  async execute(args): Promise<string> {
    const path = args.path as string;
    const content = args.content as string;

    try {
      // Create parent directories if needed
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });

      // Check if file exists
      let existed = false;
      try {
        await stat(path);
        existed = true;
      } catch {
        // File doesn't exist, that's fine
      }

      await writeFile(path, content, 'utf-8');

      const lines = content.split('\n').length;
      const bytes = Buffer.byteLength(content, 'utf-8');

      return `Successfully ${existed ? 'overwrote' : 'created'} ${path} (${lines} lines, ${bytes} bytes)`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return formatFileError(err, path, 'write');
    }
  },
});

/**
 * Edit file tool - replaces specific text in a file
 */
export const editFileTool = defineTool({
  name: 'edit_file',
  description: 'Edit a file by replacing specific text. The old_string must match exactly (including whitespace). Use this for targeted edits rather than rewriting entire files.',
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute or relative path to the file to edit',
      isRequired: true,
    },
    old_string: {
      type: 'string',
      description: 'The exact string to find and replace (must be unique in the file)',
      isRequired: true,
    },
    new_string: {
      type: 'string',
      description: 'The string to replace it with',
      isRequired: true,
    },
    replace_all: {
      type: 'boolean',
      description: 'If true, replace all occurrences. If false (default), the old_string must be unique.',
    },
  },
  timeout: 30000,
  requiresConfirmation: true,

  async execute(args): Promise<string> {
    const path = args.path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) || false;

    try {
      const content = await readFile(path, 'utf-8');

      // Check how many times old_string appears
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return `Error: Could not find the specified text in ${path}. Make sure old_string matches exactly, including whitespace.`;
      }

      if (occurrences > 1 && !replaceAll) {
        return `Error: Found ${occurrences} occurrences of the text. Either make old_string more specific to match exactly one location, or set replace_all to true.`;
      }

      // Perform the replacement
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        newContent = content.replace(oldString, newString);
      }

      await writeFile(path, newContent, 'utf-8');

      const replacements = replaceAll ? occurrences : 1;
      return `Successfully edited ${path}: replaced ${replacements} occurrence${replacements > 1 ? 's' : ''}.`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return formatFileError(err, path, 'edit');
    }
  },
});

/**
 * List files tool
 */
export const listFilesTool = defineTool({
  name: 'list_files',
  description: 'List files and directories in a given path. Returns a listing with file types and sizes.',
  parameters: {
    path: {
      type: 'string',
      description: 'Directory path to list (default: current directory)',
    },
    pattern: {
      type: 'string',
      description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.json")',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const path = (args.path as string) || '.';
    const { readdir, stat } = await import('fs/promises');
    const { join } = await import('path');

    try {
      const entries = await readdir(path);
      const details = await Promise.all(
        entries.map(async (entry) => {
          try {
            const fullPath = join(path, entry);
            const stats = await stat(fullPath);
            const type = stats.isDirectory() ? 'd' : 'f';
            const size = stats.isDirectory() ? '' : formatSize(stats.size);
            return { name: entry, type, size };
          } catch {
            return { name: entry, type: '?', size: '' };
          }
        })
      );

      // Sort: directories first, then files
      details.sort((a, b) => {
        if (a.type === 'd' && b.type !== 'd') return -1;
        if (a.type !== 'd' && b.type === 'd') return 1;
        return a.name.localeCompare(b.name);
      });

      const lines = details.map((d) => {
        const prefix = d.type === 'd' ? '📁' : '📄';
        const size = d.size ? ` (${d.size})` : '';
        return `${prefix} ${d.name}${size}`;
      });

      return `Contents of ${path}:\n\n${lines.join('\n')}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return formatFileError(err, path, 'list');
    }
  },
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * All file tools
 */
export const fileTools = [readFileTool, writeFileTool, editFileTool, listFilesTool];
