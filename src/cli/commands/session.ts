/**
 * Session Commands - Manage chat sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, writeFile } from 'fs/promises';
import { globalSessionStore } from '../../session/store.js';

/**
 * Register session commands
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Manage chat sessions');

  // List sessions
  session
    .command('list')
    .alias('ls')
    .description('List all sessions')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await globalSessionStore.load();
        const sessions = await globalSessionStore.listSessionIds();

        if (options.json) {
          const data = [];
          for (const id of sessions) {
            const sess = await globalSessionStore.getSession(id);
            if (sess) {
              data.push({
                id: sess.sessionId,
                userId: sess.userId,
                model: sess.model,
                messageCount: sess.messages.length,
                createdAt: new Date(sess.createdAt).toISOString(),
                updatedAt: new Date(sess.updatedAt).toISOString(),
              });
            }
          }
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (sessions.length === 0) {
          console.log(chalk.gray('No sessions found.'));
          return;
        }

        console.log(chalk.bold(`Sessions (${sessions.length}):\n`));

        for (const id of sessions) {
          const sess = await globalSessionStore.getSession(id);
          if (sess) {
            const updated = new Date(sess.updatedAt);
            const age = formatAge(Date.now() - updated.getTime());

            console.log(`  ${chalk.cyan(id)}`);
            console.log(chalk.gray(`    Model: ${sess.model} | Messages: ${sess.messages.length} | ${age} ago`));
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to list sessions: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Show session details
  session
    .command('show <sessionId>')
    .description('Show session details')
    .option('--json', 'Output as JSON')
    .option('--messages', 'Include full messages')
    .action(async (sessionId, options) => {
      try {
        await globalSessionStore.load();
        const sess = await globalSessionStore.getSession(sessionId);

        if (!sess) {
          console.error(chalk.red(`Session not found: ${sessionId}`));
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(sess, null, 2));
          return;
        }

        console.log(chalk.bold(`Session: ${sess.sessionId}\n`));
        console.log(`  User: ${sess.userId}`);
        console.log(`  Model: ${sess.model}`);
        console.log(`  Messages: ${sess.messages.length}`);
        console.log(`  Tokens: ↓${sess.tokenUsage.input} ↑${sess.tokenUsage.output}`);
        console.log(`  Created: ${new Date(sess.createdAt).toLocaleString()}`);
        console.log(`  Updated: ${new Date(sess.updatedAt).toLocaleString()}`);

        if (options.messages) {
          console.log(chalk.bold(`\nMessages:\n`));
          for (const msg of sess.messages) {
            const role = msg.role.padEnd(10);
            const preview = msg.content.slice(0, 100).replace(/\n/g, ' ');
            console.log(`  ${chalk.gray(role)} ${preview}${msg.content.length > 100 ? '...' : ''}`);
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to show session: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Clear session
  session
    .command('clear <sessionId>')
    .description('Clear a session\'s messages')
    .action(async (sessionId) => {
      try {
        await globalSessionStore.load();
        const sess = await globalSessionStore.getSession(sessionId);

        if (!sess) {
          console.error(chalk.red(`Session not found: ${sessionId}`));
          process.exit(1);
        }

        sess.messages = [];
        sess.tokenUsage = { input: 0, output: 0, total: 0 };
        sess.updatedAt = Date.now();
        await globalSessionStore.updateSession(sess);
        await globalSessionStore.flush();

        console.log(chalk.green(`✓ Cleared session ${sessionId}`));
      } catch (error) {
        console.error(chalk.red(`Failed to clear session: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Delete session
  session
    .command('delete <sessionId>')
    .alias('rm')
    .description('Delete a session')
    .action(async (sessionId) => {
      try {
        await globalSessionStore.load();
        const deleted = await globalSessionStore.deleteSession(sessionId);

        if (deleted) {
          await globalSessionStore.flush();
          console.log(chalk.green(`✓ Deleted session ${sessionId}`));
        } else {
          console.log(chalk.yellow(`Session not found: ${sessionId}`));
        }
      } catch (error) {
        console.error(chalk.red(`Failed to delete session: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Export session
  session
    .command('export [sessionId]')
    .description('Export session(s) to JSON')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .action(async (sessionId, options) => {
      try {
        await globalSessionStore.load();

        let data: string;
        if (sessionId) {
          const sess = await globalSessionStore.getSession(sessionId);
          if (!sess) {
            console.error(chalk.red(`Session not found: ${sessionId}`));
            process.exit(1);
          }
          data = JSON.stringify(sess, null, 2);
        } else {
          data = await globalSessionStore.export();
        }

        if (options.output) {
          await writeFile(options.output, data, 'utf-8');
          console.log(chalk.green(`✓ Exported to ${options.output}`));
        } else {
          console.log(data);
        }
      } catch (error) {
        console.error(chalk.red(`Failed to export: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Import sessions
  session
    .command('import <file>')
    .description('Import sessions from JSON')
    .option('--merge', 'Merge with existing sessions')
    .action(async (file, options) => {
      try {
        const content = await readFile(file, 'utf-8');
        await globalSessionStore.load();
        const count = await globalSessionStore.import(content, options.merge);
        await globalSessionStore.flush();

        console.log(chalk.green(`✓ Imported ${count} session(s)`));
      } catch (error) {
        console.error(chalk.red(`Failed to import: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Cleanup old sessions
  session
    .command('cleanup')
    .description('Remove old sessions')
    .option('-d, --days <days>', 'Remove sessions older than N days', '7')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options) => {
      const days = parseInt(options.days, 10);
      const maxAgeMs = days * 24 * 60 * 60 * 1000;

      if (!options.yes) {
        console.log(chalk.yellow(`This will delete sessions older than ${days} days. Use --yes to confirm.`));
        return;
      }

      try {
        await globalSessionStore.load();
        const removed = await globalSessionStore.cleanup(maxAgeMs);
        await globalSessionStore.flush();

        console.log(chalk.green(`✓ Removed ${removed} old session(s)`));
      } catch (error) {
        console.error(chalk.red(`Failed to cleanup: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });
}

/**
 * Format age in human readable form
 */
function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
