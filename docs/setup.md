# Setup Guide

Complete installation and setup instructions for LocalBot.

## Prerequisites

- **Node.js** 18+
- **Ollama** running locally or on a remote server
- **npm** or **bun** package manager

## Installation

### 1. Clone and Install

```bash
cd /Users/zayed/Downloads/serve_ollama
npm install
npm run build
```

### 2. Configure Ollama

LocalBot needs an Ollama instance. You have two options:

#### Option A: Local Ollama (Same Machine)

```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama
ollama serve

# Pull required models
ollama pull llama3.1:8b
ollama pull qwen2.5:32b
ollama pull nomic-embed-text  # For memory features
```

Set environment variable:
```bash
export OLLAMA_HOST=http://localhost:11434
```

#### Option B: Remote Ollama (Different Machine)

If Ollama runs on another machine (e.g., a GPU server):

```bash
# On the remote machine, start Ollama with network access
OLLAMA_HOST=0.0.0.0 ollama serve

# On your local machine, point to remote
export OLLAMA_HOST=http://192.168.1.100:11434
# Or use Tailscale
export OLLAMA_HOST=http://100.121.61.16:11434
```

### 3. Verify Ollama Connection

```bash
# Test connection
curl $OLLAMA_HOST/api/tags

# Should return list of models
```

### 4. Create Context Directory

```bash
# Create global context directory
mkdir -p ~/clawd
mkdir -p ~/clawd/skills

# Create identity file
cat > ~/clawd/IDENTITY.md << 'EOF'
name: LocalBot
creature: AI Assistant
vibe: Helpful and precise
emoji: 🤖
EOF

# Create soul file (behavior guidelines)
cat > ~/clawd/SOUL.md << 'EOF'
# Behavior Guidelines

- Be concise and direct
- Execute commands when asked, don't just explain
- Ask for clarification when needed
- Use tools proactively to help
EOF

# Create user file
cat > ~/clawd/USER.md << 'EOF'
name: Zayed
timezone: EST
work: Bioinformatics/Genomics
EOF
```

### 5. Create Environment File

```bash
cat > .env << 'EOF'
# Ollama Configuration
OLLAMA_HOST=http://localhost:11434
DEFAULT_MODEL=llama3.1:8b

# Optional: Hybrid routing
REASONING_MODEL=qwen2.5:32b
TOOL_MODEL=llama3.1:8b

# Context directories
CONTEXT_DIR=/Users/zayed/clawd
AGENT_DIR=./agent

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your_token_here
EOF
```

### 6. Run LocalBot

```bash
# Terminal chat
npm run chat

# Or Telegram bot
npm run bot
```

## Verifying Setup

### Check Models Available

In chat mode:
```
/models
```

Should show your Ollama models with 🔧 for tool-capable ones.

### Check Context Loaded

```
/context
```

Should show:
```
Loaded Context:
  Sources:
    • /Users/zayed/clawd

  🪪 identity [global]
     name: LocalBot

  👻 soul [global]
     - Be concise and direct

  👤 user [global]
     name: Zayed
```

### Check Skills Loaded

```
/skills
```

Should list any skills in `~/clawd/skills/`.

### Test a Query

```
You: hello
Assistant: Hello! How can I help you today?
```

If it calls tools unnecessarily, check the [Troubleshooting](./troubleshooting.md) guide.

## Installing Skills

### From Directory

Place skill files in:
- `~/clawd/skills/` - Global skills
- `./skills/` - Workspace skills

Skill structure:
```
skills/
├── my-skill.md           # Simple skill file
└── complex-skill/        # Skill with resources
    └── SKILL.md
```

### Genomics Skills (Pre-configured)

If you have the genomics tools:

```bash
# Verify showjobs is available
which showjobs

# The genomics-jobs and genomics-report skills should auto-load
/skills
```

## Local Ollama Configuration Details

### Running Ollama Locally

#### macOS

```bash
# Install
brew install ollama

# Run as service
brew services start ollama

# Or run manually
ollama serve
```

Default listens on `http://localhost:11434`

#### Linux

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Run as service
sudo systemctl enable ollama
sudo systemctl start ollama

# Check status
sudo systemctl status ollama
```

#### Docker

```bash
docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama
```

### Recommended Models

| Model | Size | Use Case |
|-------|------|----------|
| `llama3.1:8b` | 4.7GB | Fast tool execution, general chat |
| `qwen2.5:32b` | 18GB | Complex reasoning, planning |
| `qwen2.5:14b` | 8GB | Balanced performance |
| `deepseek-r1:14b` | 8GB | Reasoning tasks (no tools) |
| `nomic-embed-text` | 274MB | Memory/embedding features |

```bash
# Pull recommended models
ollama pull llama3.1:8b
ollama pull qwen2.5:32b
ollama pull nomic-embed-text
```

### GPU Configuration

Ollama auto-detects GPUs. For specific GPU assignment:

```bash
# Use specific GPU
CUDA_VISIBLE_DEVICES=0 ollama serve

# Limit VRAM usage
OLLAMA_MAX_VRAM=8g ollama serve
```

### Network Access

To allow remote connections:

```bash
# Listen on all interfaces
OLLAMA_HOST=0.0.0.0:11434 ollama serve

# With custom port
OLLAMA_HOST=0.0.0.0:8080 ollama serve
```

**Security Note:** Only expose Ollama on trusted networks. Use Tailscale or SSH tunnels for remote access.

## Next Steps

- [Configuration Reference](./configuration.md) - All options
- [Skills Guide](./skills.md) - Creating custom skills
- [Use Cases](./use-cases.md) - Common workflows
