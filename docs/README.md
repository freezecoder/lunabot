# LocalBot User Guide

A comprehensive AI agent system for local LLMs with tool calling, skills, and multi-interface support.

## Quick Start

```bash
# Terminal chat interface
npm run chat

# Telegram bot
npm run bot

# Development mode
npm run dev
```

## Documentation

| Document | Description |
|----------|-------------|
| [Setup Guide](./setup.md) | Installation and initial configuration |
| [Configuration](./configuration.md) | All environment variables and settings |
| [Architecture](./architecture.md) | System design and how it works |
| [Skills Guide](./skills.md) | Using and creating skills |
| [Use Cases](./use-cases.md) | Common workflows and examples |
| [Troubleshooting](./troubleshooting.md) | Common issues and solutions |

## System Overview

LocalBot is a TypeScript-based AI agent that connects to local LLM inference (Ollama) and provides:

- **Tool Calling**: Execute bash commands, read/write files, web search, browser automation
- **Skills System**: Markdown-based prompts that inject domain knowledge
- **Multi-Interface**: Terminal UI, Telegram bot, or library usage
- **Context Loading**: Personal context (IDENTITY, SOUL, USER) from config directories
- **Hybrid Routing**: Use different models for reasoning vs tool execution
- **Report Generation**: LLM-summarized reports from collected data

## Interfaces

### Terminal Chat (`npm run chat`)

Interactive CLI with:
- `/skill <name>` - Activate a skill context
- `/skills` - List available skills
- `/model <name>` - Switch models
- `/tools` - List available tools
- `/context` - Show loaded context files
- `/help` - All commands

### Telegram Bot (`npm run bot`)

Full-featured bot with:
- Automatic skill detection from keywords
- Direct command execution for common queries
- Model switching via `/model` command
- Streaming responses

## Directory Structure

```
serve_ollama/
├── src/
│   ├── agent/          # Agent orchestration
│   ├── tools/          # Built-in tools
│   ├── skills/         # Skill loader
│   ├── context/        # Context loader
│   ├── router/         # Model routing
│   ├── terminal/       # CLI interface
│   └── telegram/       # Bot interface
├── docs/               # This documentation
├── skills/             # Workspace skills (optional)
└── agent/              # Workspace context (optional)

~/.localbot/
├── skills/             # User-managed skills
└── skills-bundled/     # Bundled skills

~/clawd/                # Global context directory
├── IDENTITY.md         # Bot personality
├── SOUL.md             # Behavior guidelines
├── USER.md             # User preferences
├── skills/             # Global skills
│   ├── genomics-jobs/
│   │   └── SKILL.md
│   └── genomics-report/
│       └── SKILL.md
└── scripts/            # Custom scripts
    └── genomics-report.sh
```

## Key Concepts

### Skills

Skills are markdown files that inject domain knowledge into conversations:

```markdown
---
name: my-skill
description: What this skill does
triggers:
  - keyword1
  - keyword2
---

# Skill Content

Instructions and commands for the AI...
```

### Context Files

Personal context loaded at startup:
- `IDENTITY.md` - Bot name, personality, emoji
- `SOUL.md` - Behavior guidelines (bullet points)
- `USER.md` - User name, timezone, preferences
- `TOOLS.md` - Tool usage notes

### Hybrid Routing

Use different models for different tasks:
- **Reasoning Model**: Smarter model for understanding (qwen2.5:32b)
- **Tool Model**: Faster model for execution (llama3.1:8b)

## Getting Help

- Run `/help` in chat mode
- Check [Troubleshooting](./troubleshooting.md)
- Review [Configuration](./configuration.md) for all options
