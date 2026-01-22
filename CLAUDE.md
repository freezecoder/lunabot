# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lunabot is a TypeScript-based AI agent for local LLMs. It connects to Ollama (local LLM inference) and optionally LiteLLM (OpenAI-compatible proxy), providing a tool-calling agent with Telegram bot integration, interactive terminal UI, and CLI utilities.

## Commands

```bash
# Development
npm run dev          # Watch mode with auto-reload
npm run chat         # Interactive terminal UI
npm run bot          # Start Telegram bot (standalone)
npm run gateway      # Start gateway daemon (bot + cron + HTTP/WS API)
npm run dashboard    # System monitoring dashboard
npm run all          # Start all services (scripts/start-all.sh)
npm start            # Run main entry

# Database
npm run migrate      # Import existing JSON sessions into SQLite

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
- Built-in tools: bash, files, web, browser, api, google (gmail/calendar), memory, documents
- Tool categories: `core`, `safe`, `productivity`, `all`

**Router (`src/router/router.ts`)**: Task-based model selection. Routes to appropriate model based on whether tools are needed. Checks model capabilities before routing.

**Memory (`src/memory/`)**: SQLite-backed semantic search using Ollama embeddings. Indexes markdown files in `memory/` directory. Configurable chunking (400 tokens default, 80 overlap).

**Skills System (`src/skills/`)**: Markdown-based prompt injection system. Skills are loaded from bundled, managed, workspace, or extra directories. Each skill has YAML frontmatter with metadata (invocation mode: auto/manual/disabled, triggers, tags, priority).

**Workspace/Identity (`src/workspace/`)**: Bootstrap file system for agent persona. Loads markdown files in priority order: AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md → HEARTBEAT.md → BOOTSTRAP.md. Workspace files override global files.

**Session Management (`src/session/`)**: SQLite-backed session persistence with in-memory caching. Tracks message history, token usage, and metadata per user/session. Sessions and messages are stored in `~/.localbot/localbot.db`.

**Database (`src/db/`)**: Unified SQLite persistence layer for all LocalBot data. Provides:
- `LocalBotDB`: Core database class with session, message, event, and tool execution tables
- `Logger`: Channel-aware event logging with convenience methods
- Event types: startup.*, session.*, message.*, tool.*, memory.*, cron.*, system.*
- Startup manifests: Track what was loaded (workspace files, skills, tools) on each startup

**Heartbeat (`src/heartbeat/`)**: Optional scheduled task runner. Sends periodic prompts to check HEARTBEAT.md for due tasks/reminders. Configurable interval and target channel.

**MCP Client (`src/mcp/client.ts`)**: Model Context Protocol client. Spawns MCP server processes and converts their tools to LocalBot tools via JSON-RPC.

**Metrics/Tracking (`src/tracking/`)**: Token usage tracking and conversation metrics collection.

**Cron/Reminders (`src/cron/`)**: Scheduled reminder system. Supports one-time (`at`), recurring (`every`), and cron expressions. Persists jobs to `~/.localbot/cron.json`. Delivers reminders via Telegram or console.

**Gateway (`src/gateway/`)**: Daemon mode that runs all services together. Inspired by clawdbot's gateway architecture. Provides:
- HTTP API for health/status (`/health`, `/status`, `/services`, `/cron`)
- Database API endpoints:
  - `GET /api/events` - Query logged events (filter by channel, type, session_id, level, since)
  - `GET /api/events/stats` - Event statistics
  - `GET /api/sessions/:id/messages` - Get session with full message history
  - `GET /api/startup/latest` - Latest startup manifest (what was loaded)
  - `GET /api/startup` - All startup manifests
  - `GET /api/db/sessions` - List sessions from database
  - `GET /api/db/sessions/stats` - Session statistics
- WebSocket API for real-time events and RPC
- Services manager for lifecycle control (start/stop/restart)
- Unified entry point for Telegram bot + cron scheduler

### Type System

Core types in `src/types.ts`:
- `Tool`: Has `name`, `description`, `parameters` (JSON Schema), `execute` function
- `Provider`: Implements `chat()`, `chatStream()`, `listModels()`
- `Message`: Standard chat format with `role`, `content`, optional `tool_calls`
- `ToolSchema`: OpenAI-compatible function calling schema
- `Session`: Runtime session with messages, model, timestamps, metadata

Additional type files:
- `src/session/types.ts` - SessionEntry, SessionStoreData, SessionStats
- `src/skills/types.ts` - SkillEntry, SkillMetadata, SkillInvocation
- `src/workspace/types.ts` - WorkspaceFile, WorkspaceContext, IdentityInfo, UserInfo
- `src/db/types.ts` - EventType, LogLevel, Channel, SessionRecord, MessageRecord, EventRecord, StartupManifest

### Entry Points

- `src/index.ts` - Library exports
- `src/terminal/ui.ts` - Interactive TUI (`npm run chat`)
- `src/terminal/dashboard.ts` - System monitoring UI (`npm run dashboard`)
- `src/telegram/bot.ts` - Telegram bot standalone (`npm run bot`)
- `src/gateway/index.ts` - Gateway daemon (`npm run gateway`)
- `src/cli/index.ts` - CLI commands

## Environment Variables

```
OLLAMA_HOST=http://localhost:11434   # Ollama endpoint
DEFAULT_MODEL=llama3.1:8b            # Default LLM
TELEGRAM_BOT_TOKEN=                  # For Telegram bot
LITELLM_HOST=http://localhost:4000   # Optional LiteLLM proxy
LOCALBOT_EMBEDDING_MODEL=nomic-embed-text  # For memory search

# Heartbeat (optional)
LOCALBOT_HEARTBEAT_ENABLED=false
LOCALBOT_HEARTBEAT_EVERY=30          # Interval in minutes
LOCALBOT_HEARTBEAT_TARGET=           # Channel/chat ID

# Gateway (optional)
LOCALBOT_GATEWAY_PORT=18800          # HTTP/WS port
LOCALBOT_GATEWAY_HOST=127.0.0.1      # Bind address
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

## Adding a New Skill

Create a markdown file in `skills/` directory with YAML frontmatter:

```markdown
---
invocation: auto  # auto | manual | disabled
triggers:
  - keyword1
  - keyword2
tags: [category]
priority: 10
---

# Skill Name

Skill instructions for the agent...
```

Skills are loaded by `src/skills/loader.ts` and registered in `src/skills/registry.ts`.

## Test Structure

Tests use Vitest with helpers in `test/helpers/`:
- `temp-dir.ts` - Temporary directory creation
- `temp-home.ts` - Isolated home directory
- `env.ts` - Environment variable overrides
- `setup.ts` - Global test setup

Test files follow `*.test.ts` pattern alongside source files.

## Troubleshooting / Known Issues

### Tools not being called by the LLM

**Symptom**: The agent responds with text but never calls tools (like `telegram_send_document`), even when explicitly asked.

**Cause**: The model is not in `MODEL_CAPABILITIES` in `src/router/router.ts`, so `supportsTools=false` and tools are never passed to Ollama.

**Debug**: Check logs for:
```
[Agent] Turn 1: model=xxx, route.useTools=true, supportsTools=false, willUseTools=false
[OllamaProvider] chatStream: model=xxx, hasTools=false, toolCount=0
```

If `supportsTools=false` or `hasTools=false`, the model isn't recognized as tool-capable.

**Fix**: Add the model to `MODEL_CAPABILITIES` in `src/router/router.ts`:
```typescript
'your-model:tag': { supportsTools: true, description: 'Description' },
```

Or add the model family to the fallback check in `checkModelToolSupport()`.

### Telegram tools fail silently

**Symptom**: Telegram tools (send_document, send_photo, etc.) are called but nothing is sent.

**Cause**: The Telegram context (`ctx` and `chatId`) is stored globally and may be cleared before async tool execution completes.

**Solution**: Context is now stored per-chat in a Map (`contextMap`) in `src/telegram/tools.ts`. Don't call `clearTelegramContext()` prematurely - the context will be overwritten by the next message anyway.
