# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lunabot is a TypeScript-based AI agent for local LLMs. It connects to Ollama (local LLM inference) and optionally LiteLLM (OpenAI-compatible proxy), providing a tool-calling agent with Telegram bot integration, interactive terminal UI, and CLI utilities.

## Commands

```bash
# Development
npm run dev          # Watch mode with auto-reload
npm run chat         # Interactive terminal UI
npm run bot          # Start Telegram bot
npm start            # Run main entry

# Build & Test
npm run build        # TypeScript compilation
npm test             # Run all tests
npm run test:watch   # Watch mode for tests
npm run test:coverage # Coverage report (70% threshold)

# Run a single test file
npx vitest run src/tools/built-in/files.test.ts
```

## Architecture

### Core Flow
```
User Input → Agent → Router (selects model) → Provider (Ollama/LiteLLM) → LLM
                ↓
         Tool Execution (if tool_calls returned)
                ↓
         Response streamed back
```

### Key Components

**Agent (`src/agent/agent.ts`)**: Orchestrates conversation loop with max 10 turns. Each turn: route message → call LLM → execute tools → return response. Supports streaming via `AsyncIterable<StreamChunk>`.

**Providers (`src/agent/providers/`)**: Abstract LLM backends. `OllamaProvider` uses native Ollama API, `LiteLLMProvider` uses OpenAI-compatible format. Extend `BaseProvider` to add new backends.

**Tool System (`src/tools/`)**:
- `ToolRegistry`: Registration and lookup
- `ToolExecutor`: Invocation with timeout/error handling
- Built-in tools: bash, files, web, browser, api, google (gmail/calendar), memory
- Tool categories: `core`, `safe`, `productivity`, `all`

**Router (`src/router/router.ts`)**: Task-based model selection. Routes to appropriate model based on whether tools are needed. Checks model capabilities before routing.

**Memory (`src/memory/`)**: SQLite-backed semantic search using Ollama embeddings. Indexes markdown files in `memory/` directory. Configurable chunking (400 tokens default, 80 overlap).

### Type System

Core types in `src/types.ts`:
- `Tool`: Has `name`, `description`, `parameters` (JSON Schema), `execute` function
- `Provider`: Implements `chat()`, `chatStream()`, `listModels()`
- `Message`: Standard chat format with `role`, `content`, optional `tool_calls`
- `ToolSchema`: OpenAI-compatible function calling schema

### Entry Points

- `src/index.ts` - Library exports
- `src/terminal/ui.ts` - Interactive TUI (`npm run chat`)
- `src/telegram/bot.ts` - Telegram bot (`npm run bot`)
- `src/cli/index.ts` - CLI commands

## Environment Variables

```
OLLAMA_HOST=http://localhost:11434   # Ollama endpoint
DEFAULT_MODEL=llama3.1:8b            # Default LLM
TELEGRAM_BOT_TOKEN=                  # For Telegram bot
LITELLM_HOST=http://localhost:4000   # Optional LiteLLM proxy
LOCALBOT_EMBEDDING_MODEL=nomic-embed-text  # For memory search
```

## Adding a New Tool

```typescript
// src/tools/built-in/my-tool.ts
import type { Tool } from '../../types.js';

export const myTool: Tool = {
  name: 'my_tool',
  description: 'What this tool does',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' },
    },
    required: ['input'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const input = args.input as string;
    // Implementation
    return 'result';
  },
};
```

Then export from `src/tools/built-in/index.ts` and add to `getAllBuiltInTools()`.

## Test Structure

Tests use Vitest with helpers in `test/helpers/`:
- `temp-dir.ts` - Temporary directory creation
- `temp-home.ts` - Isolated home directory
- `env.ts` - Environment variable overrides
- `setup.ts` - Global test setup

Test files follow `*.test.ts` pattern alongside source files.
