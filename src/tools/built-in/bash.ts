/**
 * Bash tool - Execute shell commands
 */

import { spawn } from 'child_process';
import { defineTool } from '../registry.js';

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_OUTPUT = 100000; // 100KB

export const bashTool = defineTool({
  name: 'bash',
  description: 'Execute a bash command and return the output. Use this to run system commands, manage files, or perform operations that require shell access.',
  parameters: {
    command: {
      type: 'string',
      description: 'The bash command to execute',
      isRequired: true,
    },
    working_directory: {
      type: 'string',
      description: 'The working directory for the command (default: current directory)',
    },
    timeout: {
      type: 'number',
      description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}, max: 600000)`,
    },
  },
  timeout: 600000, // 10 minute max
  retryable: false,
  requiresConfirmation: false,

  async execute(args): Promise<string> {
    const command = args.command as string;
    const cwd = args.working_directory as string | undefined;
    const timeout = Math.min((args.timeout as number) || DEFAULT_TIMEOUT, 600000);

    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        timeout,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT);
          proc.kill();
          killed = true;
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT);
          proc.kill();
          killed = true;
        }
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        killed = true;
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);

        let output = '';

        if (stdout.trim()) {
          output += stdout.trim();
        }

        if (stderr.trim()) {
          if (output) output += '\n\n';
          output += `STDERR:\n${stderr.trim()}`;
        }

        if (killed) {
          output += '\n\n[Output truncated or process killed due to limits]';
        }

        if (code !== 0 && code !== null) {
          output += `\n\n[Exit code: ${code}]`;
        }

        resolve(output || '(no output)');
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve(`Error executing command: ${error.message}`);
      });
    });
  },
});
