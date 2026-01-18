/**
 * LocalBot - Main entry point
 *
 * A TypeScript agent for local LLMs with Telegram integration
 */

import { Agent } from './agent/agent.js';
import { OllamaProvider, createOllamaProvider } from './agent/providers/ollama.js';
import { LiteLLMProvider, createLiteLLMProvider } from './agent/providers/litellm.js';
import { ToolRegistry, defineTool, globalRegistry } from './tools/registry.js';
import { ToolExecutor } from './tools/executor.js';
import { getAllBuiltInTools, getCoreTools, getSafeTools } from './tools/built-in/index.js';
import { loadSkillsFromFile, loadSkillsFromDirectory } from './tools/skill-loader.js';
import { ModelRouter, MODEL_CAPABILITIES, checkModelToolSupport } from './router/router.js';
import 'dotenv/config';

// Export all components for library use
export {
  // Agent
  Agent,
  // Providers
  OllamaProvider,
  LiteLLMProvider,
  createOllamaProvider,
  createLiteLLMProvider,
  // Tools
  ToolRegistry,
  ToolExecutor,
  defineTool,
  globalRegistry,
  getAllBuiltInTools,
  getCoreTools,
  getSafeTools,
  loadSkillsFromFile,
  loadSkillsFromDirectory,
  // Router
  ModelRouter,
  MODEL_CAPABILITIES,
  checkModelToolSupport,
};

// Export types
export * from './types.js';

/**
 * Quick start function for simple usage
 */
export async function createAgent(options: {
  ollamaHost?: string;
  model?: string;
  tools?: 'all' | 'core' | 'safe' | 'none';
  skillsDir?: string;
} = {}): Promise<Agent> {
  const host = options.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = options.model || process.env.DEFAULT_MODEL || 'llama3.1:8b';

  // Create provider
  const provider = new OllamaProvider({ host });

  // Set up tools
  const registry = new ToolRegistry();
  switch (options.tools || 'all') {
    case 'all':
      registry.registerAll(getAllBuiltInTools());
      break;
    case 'core':
      registry.registerAll(getCoreTools());
      break;
    case 'safe':
      registry.registerAll(getSafeTools());
      break;
    case 'none':
      break;
  }

  // Load custom skills if directory specified
  if (options.skillsDir) {
    const skills = await loadSkillsFromDirectory(options.skillsDir);
    registry.registerAll(skills);
  }

  // Create and return agent
  return new Agent({
    provider,
    registry,
    defaultModel: model,
    routerConfig: {
      reasoningModel: model,
      toolCallingModel: model,
    },
  });
}

/**
 * CLI interface when run directly
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
LocalBot - TypeScript Agent for Local LLMs

Usage:
  npm run start          Start interactive CLI
  npm run bot            Start Telegram bot
  npm run dev            Start with auto-reload

Environment Variables:
  OLLAMA_HOST           Ollama server URL (default: http://localhost:11434)
  DEFAULT_MODEL         Default model to use (default: llama3.1:8b)
  TELEGRAM_BOT_TOKEN    Telegram bot token (required for bot mode)
  SKILLS_DIR            Directory for custom skills (default: ./skills)
  ADMIN_IDS             Comma-separated Telegram user IDs for admin access

Examples:
  OLLAMA_HOST=http://192.168.1.100:11434 npm start
  DEFAULT_MODEL=llama3.1:70b npm run bot
`);
    return;
  }

  // Interactive CLI mode
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('🤖 LocalBot CLI');
  console.log('Type your message and press Enter. Type "exit" to quit.\n');

  const agent = await createAgent();
  const sessionId = 'cli-session';

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === 'exit') {
        console.log('Goodbye!');
        rl.close();
        return;
      }

      if (trimmed.toLowerCase() === 'clear') {
        agent.clearSession(sessionId);
        console.log('Conversation cleared.\n');
        prompt();
        return;
      }

      if (!trimmed) {
        prompt();
        return;
      }

      process.stdout.write('\nAssistant: ');

      for await (const event of agent.runStream(trimmed, sessionId)) {
        switch (event.type) {
          case 'content':
            if (event.content) process.stdout.write(event.content);
            break;
          case 'tool_start':
            console.log(`\n[🔧 ${event.toolCall?.function.name}]`);
            break;
          case 'tool_end':
            console.log(`[✅ Done]`);
            break;
          case 'error':
            console.log(`\n[❌ Error: ${event.error}]`);
            break;
        }
      }

      console.log('\n');
      prompt();
    });
  };

  prompt();
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
