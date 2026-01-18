/**
 * Chat Command - Non-interactive single message chat
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { Agent } from '../../agent/agent.js';
import { OllamaProvider } from '../../agent/providers/ollama.js';
import { ToolRegistry } from '../../tools/registry.js';
import { getAllBuiltInTools } from '../../tools/built-in/index.js';
import { loadContext, buildSystemPrompt } from '../../context/loader.js';
import { v4 as uuid } from 'uuid';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3.1:8b';
const CONTEXT_DIR = process.env.CONTEXT_DIR || '';
const AGENT_DIR = process.env.AGENT_DIR || './agent';

/**
 * Register chat command
 */
export function registerChatCommand(program: Command): void {
  program
    .command('chat <message>')
    .description('Send a single message and get a response')
    .option('-m, --model <model>', 'Model to use', DEFAULT_MODEL)
    .option('-h, --host <url>', 'Ollama host URL', OLLAMA_HOST)
    .option('--no-tools', 'Disable tool usage')
    .option('--json', 'Output as JSON')
    .option('-s, --session <id>', 'Session ID for continuity')
    .option('-q, --quiet', 'Minimal output (response only)')
    .action(async (message, options) => {
      const model = options.model;
      const sessionId = options.session || uuid();

      if (!options.quiet) {
        console.log(chalk.gray(`Model: ${model}`));
        console.log(chalk.gray(`Session: ${sessionId}`));
        console.log();
      }

      // Create provider
      const provider = new OllamaProvider({ host: options.host });

      // Create registry
      const registry = new ToolRegistry();
      if (options.tools !== false) {
        registry.registerAll(getAllBuiltInTools());
      }

      // Load context
      let systemPrompt: string | undefined;
      if (CONTEXT_DIR) {
        try {
          const context = await loadContext(CONTEXT_DIR, AGENT_DIR);
          systemPrompt = buildSystemPrompt(context, registry.getSummary());
        } catch {
          // Context loading failed, use default
        }
      }

      // Create agent
      const agent = new Agent({
        provider,
        registry,
        defaultModel: model,
        systemPrompt,
      });

      try {
        // Run the chat
        let response = '';
        const toolCalls: string[] = [];

        for await (const event of agent.runStream(message, sessionId)) {
          switch (event.type) {
            case 'content':
              if (event.content) {
                response += event.content;
                if (!options.quiet && !options.json) {
                  process.stdout.write(event.content);
                }
              }
              break;

            case 'tool_start':
              if (event.toolCall && !options.quiet && !options.json) {
                console.log(chalk.yellow(`\n[Tool: ${event.toolCall.function.name}]`));
              }
              break;

            case 'tool_end':
              if (event.toolCall) {
                toolCalls.push(event.toolCall.function.name);
              }
              break;

            case 'error':
              if (options.json) {
                console.log(JSON.stringify({ error: event.error }));
              } else {
                console.error(chalk.red(`\nError: ${event.error}`));
              }
              process.exit(1);
          }
        }

        if (options.json) {
          console.log(JSON.stringify({
            response,
            model,
            sessionId,
            toolsUsed: toolCalls,
          }, null, 2));
        } else if (!options.quiet) {
          console.log('\n');
          if (toolCalls.length > 0) {
            console.log(chalk.gray(`[Tools used: ${toolCalls.join(', ')}]`));
          }
        } else {
          console.log(response);
        }

      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        } else {
          console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        }
        process.exit(1);
      }
    });
}
