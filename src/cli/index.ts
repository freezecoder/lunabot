#!/usr/bin/env node
/**
 * LocalBot CLI - Command line interface for LocalBot
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { registerServerCommands } from './commands/server.js';
import { registerChatCommand } from './commands/chat.js';
import { registerConfigCommands } from './commands/config.js';
import { registerSessionCommands } from './commands/session.js';
import { registerToolsCommands } from './commands/tools.js';
import { registerMemoryCommands } from './commands/memory.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

// Create main program
const program = new Command();

program
  .name('localbot')
  .description('LocalBot - AI assistant with local LLM support')
  .version(pkg.version || '1.0.0');

// Register command groups
registerServerCommands(program);
registerChatCommand(program);
registerConfigCommands(program);
registerSessionCommands(program);
registerToolsCommands(program);
registerMemoryCommands(program);

// Interactive mode (default when no command)
program
  .command('interactive', { isDefault: true })
  .alias('i')
  .description('Start interactive chat mode')
  .action(async () => {
    // Import dynamically to start the interactive UI
    await import('../terminal/ui.js');
  });

// Parse arguments
program.parse();
