/**
 * Memory Commands - Search and manage memory
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getMemoryManager } from '../../memory/manager.js';

/**
 * Register memory commands
 */
export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command('memory')
    .description('Search and manage memory');

  // Search memory
  memory
    .command('search <query>')
    .description('Search memory for relevant content')
    .option('-n, --max <count>', 'Maximum results', '6')
    .option('--json', 'Output as JSON')
    .action(async (query, options) => {
      try {
        const manager = await getMemoryManager();

        if (!manager.enabled) {
          console.error(chalk.red('Memory is not enabled.'));
          console.log(chalk.gray('Set LOCALBOT_MEMORY_ENABLED=true to enable.'));
          process.exit(1);
        }

        const maxResults = parseInt(options.max, 10);
        const results = await manager.search(query, maxResults);

        if (options.json) {
          console.log(JSON.stringify(results.map(r => ({
            path: r.chunk.path,
            lineStart: r.chunk.lineStart,
            lineEnd: r.chunk.lineEnd,
            score: r.score,
            content: r.chunk.content,
          })), null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(chalk.gray(`No results found for: "${query}"`));
          return;
        }

        console.log(chalk.bold(`\nSearch Results (${results.length}):\n`));

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const score = (r.score * 100).toFixed(1);
          const lines = `lines ${r.chunk.lineStart}-${r.chunk.lineEnd}`;

          console.log(chalk.cyan(`[${i + 1}] ${r.chunk.path}`));
          console.log(chalk.gray(`    ${lines} | ${score}% match`));

          // Show preview
          const preview = r.chunk.content
            .split('\n')
            .slice(0, 5)
            .map(l => `    ${l.slice(0, 70)}${l.length > 70 ? '...' : ''}`)
            .join('\n');
          console.log(chalk.gray(preview));
          console.log();
        }
      } catch (error) {
        console.error(chalk.red(`Search failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Sync memory
  memory
    .command('sync')
    .description('Sync memory index with workspace files')
    .action(async () => {
      try {
        const manager = await getMemoryManager();

        if (!manager.enabled) {
          console.error(chalk.red('Memory is not enabled.'));
          process.exit(1);
        }

        console.log(chalk.gray('Syncing memory...'));
        const result = await manager.sync();

        if (result.files === 0) {
          console.log(chalk.green('✓ Memory sync complete. No files needed updating.'));
        } else {
          console.log(chalk.green(`✓ Indexed ${result.files} file(s) with ${result.chunks} chunk(s).`));
        }
      } catch (error) {
        console.error(chalk.red(`Sync failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Memory status
  memory
    .command('status')
    .description('Show memory system status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const manager = await getMemoryManager();
        const status = await manager.getStatus();
        const files = await manager.listFiles();

        if (options.json) {
          console.log(JSON.stringify({
            ...status,
            files: files.map(f => ({
              path: f.path,
              chunks: f.chunks,
              lastModified: f.lastModified.toISOString(),
            })),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('\nMemory Status:\n'));
        console.log(`  Enabled: ${status.enabled ? chalk.green('yes') : chalk.red('no')}`);
        console.log(`  Database: ${chalk.gray(status.dbPath)}`);
        console.log(`  Embedding Model: ${chalk.cyan(status.embeddingModel)}`);
        console.log(`  Total Chunks: ${status.totalChunks}`);
        console.log(`  Total Files: ${status.totalFiles}`);

        if (files.length > 0) {
          console.log(chalk.bold('\nIndexed Files:\n'));
          for (const file of files.slice(0, 10)) {
            console.log(`  ${chalk.gray('•')} ${file.path}`);
            console.log(chalk.gray(`      ${file.chunks} chunks | Last modified: ${file.lastModified.toLocaleDateString()}`));
          }
          if (files.length > 10) {
            console.log(chalk.gray(`  ... and ${files.length - 10} more`));
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to get status: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Index a file
  memory
    .command('index <path>')
    .description('Index a specific file')
    .action(async (path) => {
      try {
        const manager = await getMemoryManager();

        if (!manager.enabled) {
          console.error(chalk.red('Memory is not enabled.'));
          process.exit(1);
        }

        console.log(chalk.gray(`Indexing ${path}...`));
        const chunks = await manager.indexFile(path);

        console.log(chalk.green(`✓ Indexed ${path} (${chunks} chunks)`));
      } catch (error) {
        console.error(chalk.red(`Index failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // List indexed files
  memory
    .command('files')
    .alias('ls')
    .description('List indexed files')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const manager = await getMemoryManager();
        const files = await manager.listFiles();

        if (options.json) {
          console.log(JSON.stringify(files.map(f => ({
            path: f.path,
            chunks: f.chunks,
            lastModified: f.lastModified.toISOString(),
          })), null, 2));
          return;
        }

        if (files.length === 0) {
          console.log(chalk.gray('No files indexed.'));
          console.log(chalk.gray('Use "localbot memory sync" to index workspace files.'));
          return;
        }

        console.log(chalk.bold(`\nIndexed Files (${files.length}):\n`));

        for (const file of files) {
          console.log(`  ${chalk.cyan(file.path)}`);
          console.log(chalk.gray(`    ${file.chunks} chunks | ${file.lastModified.toLocaleDateString()}`));
        }
      } catch (error) {
        console.error(chalk.red(`Failed to list files: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Clear memory
  memory
    .command('clear')
    .description('Clear all indexed memory')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options) => {
      if (!options.yes) {
        console.log(chalk.yellow('This will clear all indexed memory. Use --yes to confirm.'));
        return;
      }

      try {
        const manager = await getMemoryManager();
        await manager.clear();

        console.log(chalk.green('✓ Memory cleared'));
      } catch (error) {
        console.error(chalk.red(`Failed to clear memory: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });
}
