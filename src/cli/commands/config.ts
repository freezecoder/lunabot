/**
 * Config Commands - Manage LocalBot configuration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getLocalbotHome } from '../../config/paths.js';

const CONFIG_FILE = 'config.yaml';

interface LocalBotConfig {
  ollama?: {
    host?: string;
    defaultModel?: string;
  };
  context?: {
    globalDir?: string;
    agentDir?: string;
  };
  session?: {
    cacheTtlMs?: number;
    maxMessages?: number;
  };
  heartbeat?: {
    enabled?: boolean;
    every?: number;
  };
  memory?: {
    enabled?: boolean;
    embeddingModel?: string;
  };
  [key: string]: unknown;
}

/**
 * Load config from file
 */
async function loadConfig(): Promise<LocalBotConfig> {
  const configPath = join(getLocalbotHome(), CONFIG_FILE);

  try {
    const content = await readFile(configPath, 'utf-8');
    return parseYaml(content) as LocalBotConfig;
  } catch {
    return {};
  }
}

/**
 * Save config to file
 */
async function saveConfig(config: LocalBotConfig): Promise<void> {
  const home = getLocalbotHome();
  await mkdir(home, { recursive: true });

  const configPath = join(home, CONFIG_FILE);
  const content = stringifyYaml(config);
  await writeFile(configPath, content, 'utf-8');
}

/**
 * Get nested value from object
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set nested value in object
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];

  // Try to parse value as JSON or number
  let parsedValue: unknown = value;
  if (typeof value === 'string') {
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10);
    else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value);
    else {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }
    }
  }

  current[lastPart] = parsedValue;
}

/**
 * Delete nested value from object
 */
function deleteNestedValue(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      return false;
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart in current) {
    delete current[lastPart];
    return true;
  }

  return false;
}

/**
 * Register config commands
 */
export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Manage LocalBot configuration');

  // Get config value
  config
    .command('get [key]')
    .description('Get configuration value(s)')
    .option('--json', 'Output as JSON')
    .action(async (key, options) => {
      const cfg = await loadConfig();

      if (!key) {
        // Show all config
        if (options.json) {
          console.log(JSON.stringify(cfg, null, 2));
        } else {
          console.log(chalk.bold('LocalBot Configuration:\n'));
          console.log(stringifyYaml(cfg));
        }
        return;
      }

      const value = getNestedValue(cfg, key);

      if (value === undefined) {
        console.log(chalk.gray(`(not set)`));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(typeof value === 'object' ? stringifyYaml(value) : String(value));
      }
    });

  // Set config value
  config
    .command('set <key> <value>')
    .description('Set configuration value')
    .action(async (key, value) => {
      const cfg = await loadConfig();
      setNestedValue(cfg, key, value);
      await saveConfig(cfg);

      console.log(chalk.green(`✓ Set ${key} = ${value}`));
    });

  // Delete config value
  config
    .command('delete <key>')
    .alias('rm')
    .description('Delete configuration value')
    .action(async (key) => {
      const cfg = await loadConfig();
      const deleted = deleteNestedValue(cfg, key);

      if (deleted) {
        await saveConfig(cfg);
        console.log(chalk.green(`✓ Deleted ${key}`));
      } else {
        console.log(chalk.yellow(`Key not found: ${key}`));
      }
    });

  // List all config with paths
  config
    .command('list')
    .alias('ls')
    .description('List all configuration keys')
    .action(async () => {
      const cfg = await loadConfig();

      const listKeys = (obj: Record<string, unknown>, prefix: string = ''): void => {
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;

          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            listKeys(value as Record<string, unknown>, fullKey);
          } else {
            const displayValue = typeof value === 'string' ? value : JSON.stringify(value);
            console.log(`${chalk.cyan(fullKey)} = ${chalk.gray(displayValue)}`);
          }
        }
      };

      if (Object.keys(cfg).length === 0) {
        console.log(chalk.gray('No configuration set.'));
        console.log(chalk.gray(`Config file: ${join(getLocalbotHome(), CONFIG_FILE)}`));
        return;
      }

      listKeys(cfg);
    });

  // Show config path
  config
    .command('path')
    .description('Show configuration file path')
    .action(() => {
      console.log(join(getLocalbotHome(), CONFIG_FILE));
    });

  // Reset config
  config
    .command('reset')
    .description('Reset configuration to defaults')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options) => {
      if (!options.yes) {
        console.log(chalk.yellow('This will delete all configuration. Use --yes to confirm.'));
        return;
      }

      await saveConfig({});
      console.log(chalk.green('✓ Configuration reset'));
    });
}
