/**
 * Server Commands - Test and manage Ollama connection
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { OllamaProvider } from '../../agent/providers/ollama.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

/**
 * Register server commands
 */
export function registerServerCommands(program: Command): void {
  const server = program
    .command('server')
    .description('Manage Ollama server connection');

  // Test connection
  server
    .command('test')
    .description('Test Ollama connection and show latency')
    .option('-h, --host <url>', 'Ollama host URL', OLLAMA_HOST)
    .action(async (options) => {
      const host = options.host;
      console.log(chalk.gray(`Testing connection to ${host}...`));

      const provider = new OllamaProvider({ host });

      try {
        const start = Date.now();
        const models = await provider.listModels();
        const latency = Date.now() - start;

        console.log(chalk.green(`\n✓ Connected to Ollama`));
        console.log(chalk.gray(`  Host: ${host}`));
        console.log(chalk.gray(`  Latency: ${latency}ms`));
        console.log(chalk.gray(`  Models: ${models.length} available`));

        if (models.length > 0) {
          console.log(chalk.gray(`\n  Available models:`));
          for (const model of models.slice(0, 10)) {
            console.log(chalk.gray(`    - ${model}`));
          }
          if (models.length > 10) {
            console.log(chalk.gray(`    ... and ${models.length - 10} more`));
          }
        }
      } catch (error) {
        console.log(chalk.red(`\n✗ Failed to connect to Ollama`));
        console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : error}`));
        console.log(chalk.gray(`\n  Make sure Ollama is running: ollama serve`));
        process.exit(1);
      }
    });

  // List models
  server
    .command('list')
    .alias('ls')
    .description('List available models')
    .option('-h, --host <url>', 'Ollama host URL', OLLAMA_HOST)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const provider = new OllamaProvider({ host: options.host });

      try {
        const models = await provider.listModels();

        if (options.json) {
          console.log(JSON.stringify(models, null, 2));
          return;
        }

        console.log(chalk.bold(`Available Models (${models.length}):\n`));

        for (const model of models) {
          const info = await provider.getModelInfo(model);
          const size = info.parameters || 'unknown';
          const quant = info.quantization || '';

          console.log(`  ${chalk.cyan(model)}`);
          console.log(chalk.gray(`    ${size}${quant ? ` (${quant})` : ''}`));
        }
      } catch (error) {
        console.error(chalk.red(`Failed to list models: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // Pull model
  server
    .command('pull <model>')
    .description('Pull a model from Ollama registry')
    .option('-h, --host <url>', 'Ollama host URL', OLLAMA_HOST)
    .action(async (model, options) => {
      const provider = new OllamaProvider({ host: options.host });

      console.log(chalk.gray(`Pulling ${model}...`));

      try {
        await provider.pullModel(model, (status) => {
          process.stdout.write(`\r${chalk.gray(status.padEnd(60))}`);
        });

        console.log(`\n${chalk.green('✓')} Model ${model} pulled successfully`);
      } catch (error) {
        console.error(chalk.red(`\nFailed to pull model: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });
}
