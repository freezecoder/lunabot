# Configuration Reference

Complete reference for all LocalBot configuration options.

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `DEFAULT_MODEL` | `llama3.1:8b` | Default LLM model |
| `CONTEXT_DIR` | `/Users/zayed/clawd` | Global context directory |
| `AGENT_DIR` | `./agent` | Workspace context directory |
| `SKILLS_DIR` | `./skills` | Workspace skills directory |

### Model Routing

| Variable | Default | Description |
|----------|---------|-------------|
| `REASONING_MODEL` | `$DEFAULT_MODEL` | Model for reasoning/planning |
| `TOOL_MODEL` | `$DEFAULT_MODEL` | Model for tool execution |

### Telegram Bot

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Bot token from @BotFather |
| `ADMIN_IDS` | (empty) | Comma-separated admin user IDs |

### Memory Features

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCALBOT_ENABLE_MEMORY` | `false` | Enable memory tools |
| `LOCALBOT_EMBEDDING_MODEL` | `nomic-embed-text` | Model for embeddings |

### Report Generation

| Variable | Default | Description |
|----------|---------|-------------|
| `GENOMICS_REPORT_MODEL` | `qwen2.5:32b` | Model for genomics reports |
| `REPORT_DIR` | `/tmp/genomics-reports` | Report output directory |

### MCP (Model Context Protocol)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CONFIG` | `./config/mcp.yaml` | MCP servers config file |

## Configuration Files

### .env File

Create a `.env` file in the project root:

```bash
# Required
OLLAMA_HOST=http://localhost:11434
DEFAULT_MODEL=llama3.1:8b

# Hybrid routing (optional)
REASONING_MODEL=qwen2.5:32b
TOOL_MODEL=llama3.1:8b

# Context (optional - has defaults)
CONTEXT_DIR=/Users/zayed/clawd
AGENT_DIR=./agent
SKILLS_DIR=./skills

# Telegram (required for bot mode)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Memory (optional)
LOCALBOT_ENABLE_MEMORY=true
LOCALBOT_EMBEDDING_MODEL=nomic-embed-text
```

### Context Files

#### IDENTITY.md

Defines bot personality:

```markdown
name: LocalBot
creature: AI Assistant
vibe: Helpful, precise, and proactive
emoji: 🤖
```

**Fields:**
- `name:` - Bot's display name
- `creature:` - What the bot is
- `vibe:` - Personality description
- `emoji:` - Icon for the bot

#### SOUL.md

Behavior guidelines (bullet points):

```markdown
# Behavior Guidelines

- Be concise and direct in responses
- Execute commands when asked, don't just explain
- Ask for clarification when requirements are unclear
- Use tools proactively to help the user
- Never make up data - use tools to get real information
```

#### USER.md

User context:

```markdown
name: Zayed
preferred address: Zayed
timezone: EST
work: Bioinformatics/Genomics
interests: AI, automation, pipelines
notes: Prefers direct answers without excessive explanation
```

**Fields:**
- `name:` or `preferred address:` - How to address the user
- `timezone:` - User's timezone
- `work:` - User's profession
- `interests:` - Topics of interest
- `notes:` - Additional context

#### TOOLS.md

Tool usage notes:

```markdown
# Tool Notes

- showjobs: Use for checking genomics pipeline status
- Always run commands rather than explaining them
- For genomics work, use the genomics-jobs skill
```

### MCP Configuration

`config/mcp.yaml`:

```yaml
servers:
  - name: filesystem
    command: npx
    args:
      - -y
      - "@anthropic/mcp-server-filesystem"
      - /Users/zayed/projects

  - name: github
    command: npx
    args:
      - -y
      - "@anthropic/mcp-server-github"
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
```

## Ollama Configuration Examples

### Local Development

```bash
# Simple local setup
OLLAMA_HOST=http://localhost:11434
DEFAULT_MODEL=llama3.1:8b
```

### Remote GPU Server

```bash
# Remote Ollama via Tailscale
OLLAMA_HOST=http://100.121.61.16:11434
DEFAULT_MODEL=qwen2.5:32b
REASONING_MODEL=qwen2.5:32b
TOOL_MODEL=llama3.1:8b
```

### Hybrid Local + Remote

```bash
# Use local for fast tasks, remote for heavy reasoning
# Note: Currently not supported, use single endpoint
OLLAMA_HOST=http://100.121.61.16:11434
```

### Docker Ollama

```bash
# Ollama in Docker
OLLAMA_HOST=http://host.docker.internal:11434
# Or with custom network
OLLAMA_HOST=http://ollama:11434
```

## Directory Precedence

Skills are loaded in order (later overrides earlier):

1. Extra directories (`LOCALBOT_EXTRA_SKILLS_DIRS`)
2. Bundled skills (`~/.localbot/skills-bundled/`)
3. Managed skills (`~/.localbot/skills/`)
4. Workspace skills (`./skills/`)

Context files are loaded:

1. Global context (`CONTEXT_DIR` / `~/clawd`)
2. Agent context (`AGENT_DIR` / `./agent`) - overrides global

## Model Capabilities

The router checks model capabilities for tool support:

```typescript
// Built-in capabilities (src/router/router.ts)
'llama3.1:8b': { supportsTools: true, contextWindow: 128000 },
'qwen2.5:32b': { supportsTools: true, contextWindow: 32000 },
'deepseek-r1:14b': { supportsTools: false, contextWindow: 64000 },
```

Add custom model capabilities:

```typescript
// Not currently configurable via env, requires code change
MODEL_CAPABILITIES['my-model:7b'] = {
  supportsTools: true,
  contextWindow: 8000
};
```

## Performance Tuning

### For Speed

```bash
DEFAULT_MODEL=llama3.1:8b
REASONING_MODEL=llama3.1:8b
TOOL_MODEL=llama3.1:8b
```

### For Quality

```bash
DEFAULT_MODEL=qwen2.5:32b
REASONING_MODEL=qwen2.5:32b
TOOL_MODEL=qwen2.5:32b
```

### Balanced (Recommended)

```bash
DEFAULT_MODEL=llama3.1:8b
REASONING_MODEL=qwen2.5:32b  # Smart for planning
TOOL_MODEL=llama3.1:8b       # Fast for execution
```

## Troubleshooting Configuration

### Check Loaded Config

In chat mode:
```
/context     # Shows context files
/models      # Shows available models
/tools       # Shows registered tools
/skills      # Shows loaded skills
```

### Debug Environment

```bash
# Print all env vars
env | grep -E "(OLLAMA|MODEL|CONTEXT|SKILLS|AGENT)"

# Test Ollama connection
curl $OLLAMA_HOST/api/tags | jq
```

### Common Issues

1. **"Model not found"**
   - Run `ollama pull MODEL_NAME`
   - Check `OLLAMA_HOST` is correct

2. **"Context not loading"**
   - Check `CONTEXT_DIR` path exists
   - Files must be `.md` or `.txt`

3. **"Tools not working"**
   - Model may not support tools
   - Check `/models` for 🔧 icon
