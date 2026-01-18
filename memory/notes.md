# Project Notes

LocalBot is an AI assistant that runs locally using Ollama.

## Key Features
- Token tracking for monitoring usage
- Session persistence with file-based caching
- Skills system with YAML frontmatter
- Memory with semantic search using embeddings
- CLI with Commander.js

## Architecture
The agent uses a provider pattern for LLM backends.
Tools are registered in a ToolRegistry and executed by ToolExecutor.
