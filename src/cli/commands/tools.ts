/**
 * Tools Commands - List and manage available tools
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ToolRegistry } from '../../tools/registry.js';
import { getAllBuiltInTools, getToolsByCategory } from '../../tools/built-in/index.js';

/**
 * Register tools commands
 */
export function registerToolsCommands(program: Command): void {
  const tools = program
    .command('tools')
    .description('List available tools');

  // List all tools
  tools
    .command('list')
    .alias('ls')
    .description('List all available tools')
    .option('-c, --category <cat>', 'Filter by category (core, files, web, browser, google, api, docs, memory)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      let toolList;

      if (options.category) {
        toolList = getToolsByCategory([options.category]);
      } else {
        toolList = getAllBuiltInTools();
      }

      if (options.json) {
        const data = toolList.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.bold(`Available Tools (${toolList.length}):\n`));

      // Group by category
      const categories: Record<string, typeof toolList> = {
        'Core': [],
        'Files': [],
        'Web': [],
        'Browser': [],
        'Google': [],
        'API': [],
        'Documents': [],
        'Memory': [],
        'Other': [],
      };

      for (const tool of toolList) {
        const name = tool.name.toLowerCase();
        if (name === 'bash') {
          categories['Core'].push(tool);
        } else if (name.includes('file') || name === 'list_files') {
          categories['Files'].push(tool);
        } else if (name.includes('web') || name.includes('fetch') || name.includes('search')) {
          categories['Web'].push(tool);
        } else if (name.includes('browser')) {
          categories['Browser'].push(tool);
        } else if (name.includes('gmail') || name.includes('calendar')) {
          categories['Google'].push(tool);
        } else if (name.includes('api') || name.includes('curl') || name.includes('graphql') || name.includes('jq')) {
          categories['API'].push(tool);
        } else if (name.includes('document') || name.includes('summarize')) {
          categories['Documents'].push(tool);
        } else if (name.includes('memory')) {
          categories['Memory'].push(tool);
        } else {
          categories['Other'].push(tool);
        }
      }

      for (const [category, catTools] of Object.entries(categories)) {
        if (catTools.length === 0) continue;

        console.log(chalk.bold.cyan(`  ${category}:`));
        for (const tool of catTools) {
          console.log(`    ${chalk.yellow(tool.name)}`);
          console.log(chalk.gray(`      ${tool.description.slice(0, 70)}${tool.description.length > 70 ? '...' : ''}`));
        }
        console.log();
      }
    });

  // Show tool details
  tools
    .command('show <toolName>')
    .description('Show details for a specific tool')
    .option('--json', 'Output as JSON')
    .action(async (toolName, options) => {
      const allTools = getAllBuiltInTools();
      const tool = allTools.find(t => t.name.toLowerCase() === toolName.toLowerCase());

      if (!tool) {
        console.error(chalk.red(`Tool not found: ${toolName}`));
        console.log(chalk.gray('Use "localbot tools list" to see available tools.'));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          timeout: tool.timeout,
          requiresConfirmation: tool.requiresConfirmation,
        }, null, 2));
        return;
      }

      console.log(chalk.bold(`\nTool: ${tool.name}\n`));
      console.log(chalk.gray(`Description:`));
      console.log(`  ${tool.description}\n`);

      console.log(chalk.gray(`Parameters:`));
      const props = tool.parameters.properties;
      const required = tool.parameters.required || [];

      for (const [name, param] of Object.entries(props)) {
        const isRequired = required.includes(name);
        const reqLabel = isRequired ? chalk.red('*') : ' ';
        console.log(`  ${reqLabel} ${chalk.cyan(name)}: ${chalk.yellow(param.type)}`);
        if (param.description) {
          console.log(chalk.gray(`      ${param.description}`));
        }
        if (param.enum) {
          console.log(chalk.gray(`      Options: ${param.enum.join(', ')}`));
        }
        if (param.default !== undefined) {
          console.log(chalk.gray(`      Default: ${JSON.stringify(param.default)}`));
        }
      }

      if (tool.timeout) {
        console.log(chalk.gray(`\nTimeout: ${tool.timeout}ms`));
      }
      if (tool.requiresConfirmation) {
        console.log(chalk.yellow(`\nRequires confirmation before execution`));
      }
    });

  // Categories shortcut
  tools
    .command('categories')
    .description('List tool categories')
    .action(() => {
      console.log(chalk.bold('Tool Categories:\n'));
      const categories = [
        { name: 'core', desc: 'Bash command execution' },
        { name: 'files', desc: 'File read/write/edit operations' },
        { name: 'web', desc: 'Web fetching and search' },
        { name: 'browser', desc: 'Browser automation with Playwright' },
        { name: 'google', desc: 'Gmail and Calendar integration' },
        { name: 'api', desc: 'HTTP requests, cURL, GraphQL, jq' },
        { name: 'docs', desc: 'Document processing and summarization' },
        { name: 'memory', desc: 'Memory search and storage' },
      ];

      for (const cat of categories) {
        console.log(`  ${chalk.cyan(cat.name.padEnd(12))} ${chalk.gray(cat.desc)}`);
      }

      console.log(chalk.gray('\nUse: localbot tools list --category <name>'));
    });
}
