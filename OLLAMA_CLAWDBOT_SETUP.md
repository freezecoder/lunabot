# Clawdbot + Ollama Local LLM Setup

## Overview

This document describes how to route Clawdbot's Anthropic API requests through LiteLLM to local Ollama models, enabling fully local LLM inference.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Clawdbot   │────▶│   pi-ai     │────▶│   LiteLLM   │────▶│   Ollama    │
│   (TUI)     │     │  (patched)  │     │   (proxy)   │     │  (Tailscale)│
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
     │                    │                   │                    │
     │              baseUrl patched      Translates           Serves local
     │              to localhost:4000    Anthropic ↔ OpenAI   models
     │                    │                   │                    │
     ▼                    ▼                   ▼                    ▼
 WebSocket            /v1/messages      /v1/messages          /api/chat
 ws://127.0.0.1:18789  (Anthropic)      (accepts both)        (native)
```

## The Problem

1. **Clawdbot/pi-ai hardcodes `https://api.anthropic.com`** in the model catalog
2. **Claude-cli OAuth sync** overwrites local API key configurations
3. **Anthropic tool_use format** differs from OpenAI function calling format
4. **Local models** need proper tool calling support to work with Clawdbot's agent

## Solution Components

### 1. Disable Claude-CLI OAuth Sync

Prevents external credentials from overwriting local LiteLLM config.

**File:** `/Users/zayed/Downloads/clawdbot/src/agents/auth-profiles/external-cli-sync.ts`

```typescript
import type {
  AuthProfileStore,
} from "./types.js";

export function syncExternalCliCredentials(
  _store: AuthProfileStore,
  _options?: { allowKeychainPrompt?: boolean },
): boolean {
  // CUSTOMIZATION: Skip external CLI sync to use local Ollama/LiteLLM instead
  // This prevents claude-cli OAuth credentials from overriding our local config.
  return false;
}
```

### 2. Patch pi-ai Base URL

Redirects all Anthropic API calls to LiteLLM proxy.

**File:** `clawdbot/node_modules/.pnpm/@mariozechner+pi-ai@*/node_modules/@mariozechner/pi-ai/dist/models.generated.js`

**Patch command:**
```bash
PI_AI_MODELS=$(find /Users/zayed/Downloads/clawdbot/node_modules -path "*pi-ai*/dist/models.generated.js" | head -1)
sed -i '' 's|baseUrl: "https://api.anthropic.com"|baseUrl: "http://localhost:4000"|g' "$PI_AI_MODELS"
```

**Verify patch:**
```bash
grep -c 'localhost:4000' "$PI_AI_MODELS"
# Should return: 21
```

### 3. LiteLLM Configuration

**File:** `/Users/zayed/Downloads/serve_ollama/config.yaml`

```yaml
model_list:
  - model_name: claude-haiku-4-5
    litellm_params:
      model: ollama/llama3.1:8b      # or your preferred model
      api_base: http://100.121.61.16:11434
      drop_params: true
    model_info:
      supports_function_calling: true

  - model_name: claude-sonnet-4-5
    litellm_params:
      model: ollama/llama3.1:70b     # larger model for sonnet
      api_base: http://100.121.61.16:11434
      drop_params: true
    model_info:
      supports_function_calling: true

  - model_name: claude-opus-4-5
    litellm_params:
      model: ollama/llama3.1:70b
      api_base: http://100.121.61.16:11434
      drop_params: true
    model_info:
      supports_function_calling: true

general_settings:
  master_key: sk-litellm-local
  drop_params: true

litellm_settings:
  drop_params: true
```

### 4. Auth Profiles Configuration

**File:** `/Users/zayed/.clawdbot/agents/main/agent/auth-profiles.json`

```json
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-litellm-local"
    }
  },
  "lastGood": {
    "anthropic": "anthropic:default"
  }
}
```

---

## Build & Recompilation

### Prerequisites

```bash
# Node.js and pnpm
node --version  # v18+ required
pnpm --version  # v8+ required

# Python environment for LiteLLM
conda activate litellm  # or your venv
pip install litellm
```

### Rebuild Clawdbot

```bash
cd /Users/zayed/Downloads/clawdbot

# Install dependencies
pnpm install

# Build
pnpm build

# Verify build
ls -la dist/index.js
```

### Re-apply pi-ai Patch After npm Install

**IMPORTANT:** The pi-ai patch is lost when you run `pnpm install`. Re-apply it:

```bash
PI_AI_MODELS=$(find /Users/zayed/Downloads/clawdbot/node_modules -path "*pi-ai*/dist/models.generated.js" | head -1)
echo "Patching: $PI_AI_MODELS"
sed -i '' 's|baseUrl: "https://api.anthropic.com"|baseUrl: "http://localhost:4000"|g' "$PI_AI_MODELS"
echo "Patched $(grep -c 'localhost:4000' "$PI_AI_MODELS") occurrences"
```

---

## Startup Procedure

### 1. Start LiteLLM Proxy

```bash
cd /Users/zayed/Downloads/serve_ollama

# Foreground (for debugging):
litellm --config config.yaml --port 4000

# Background:
nohup litellm --config config.yaml --port 4000 > litellm.log 2>&1 &
```

### 2. Start Clawdbot Gateway

```bash
cd /Users/zayed/Downloads/clawdbot

# Start custom gateway on port 18789
node dist/index.js gateway --port 18789 --allow-unconfigured
```

### 3. Connect TUI

```bash
cd /Users/zayed/Downloads/clawdbot
node dist/index.js tui --url ws://127.0.0.1:18789 --thinking off
```

---

## Testing Commands

### Test LiteLLM Health

```bash
curl -s http://localhost:4000/v1/models \
  -H "Authorization: Bearer sk-litellm-local" | python3 -m json.tool
```

### Test Basic Chat (OpenAI format)

```bash
curl -s http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-litellm-local" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "Say hello"}]}'
```

### Test Anthropic Format (/v1/messages)

```bash
curl -s http://localhost:4000/v1/messages \
  -H "x-api-key: sk-litellm-local" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4-5", "max_tokens": 100, "messages": [{"role": "user", "content": "Say hello"}]}'
```

### Test Tool Calling

```bash
curl -s http://localhost:4000/v1/messages \
  -H "x-api-key: sk-litellm-local" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 500,
    "tools": [{
      "name": "get_weather",
      "description": "Get weather for a location",
      "input_schema": {
        "type": "object",
        "properties": {"location": {"type": "string"}},
        "required": ["location"]
      }
    }],
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}]
  }' | python3 -m json.tool
```

### Test Clawdbot Agent Directly

```bash
cd /Users/zayed/Downloads/clawdbot
node dist/index.js agent --local --message "What is 2+2?" --session-id test --thinking off --json
```

### Monitor LiteLLM Connections

```bash
# Watch active connections to LiteLLM
watch -n 0.5 'lsof -i :4000 | grep ESTABLISHED'
```

---

## Recommended Models for Tool Calling

| Model | Size | Tool Calling | Notes |
|-------|------|--------------|-------|
| llama3.1:8b | ~5GB | ✅ Native | Best balance of speed/quality |
| llama3.1:70b | ~40GB | ✅ Native | Better quality, slower |
| mistral:7b | ~4GB | ✅ Good | Fast, decent tool support |
| qwen2.5:32b | ~18GB | ⚠️ Partial | Outputs JSON in text |
| deepseek-r1 | ~8GB | ❌ | Reasoning model, no tools |

**Pull recommended model on Ollama server:**
```bash
# On 100.121.61.16:
ollama pull llama3.1:8b
ollama pull llama3.1:70b  # if you have resources
```

---

## Troubleshooting

### Requests not hitting LiteLLM

1. Check pi-ai patch is applied:
   ```bash
   PI_AI=$(find /Users/zayed/Downloads/clawdbot/node_modules -path "*pi-ai*/dist/models.generated.js" | head -1)
   grep -c 'localhost:4000' "$PI_AI"  # Should be 21
   ```

2. Check no other gateway running:
   ```bash
   lsof -i :18789 -i :18799 | grep LISTEN
   ```

3. Verify auth-profiles.json has LiteLLM key:
   ```bash
   cat ~/.clawdbot/agents/main/agent/auth-profiles.json | grep sk-litellm
   ```

### Model outputs JSON instead of tool_use

The model doesn't support Anthropic tool format. Switch to llama3.1:
```yaml
# In config.yaml
model: ollama/llama3.1:8b  # instead of qwen2.5
```

### "thinking not supported" error

Add `--thinking off` to TUI or use `drop_params: true` in LiteLLM config.

### OAuth credentials keep coming back

Verify external-cli-sync.ts is patched and clawdbot is rebuilt:
```bash
grep -A5 "syncExternalCliCredentials" /Users/zayed/Downloads/clawdbot/dist/agents/auth-profiles/external-cli-sync.js
# Should show "return false"
```

---

## Quick Start Script

Save as `/Users/zayed/Downloads/serve_ollama/start-all.sh`:

```bash
#!/bin/bash
set -e

SERVE_DIR="/Users/zayed/Downloads/serve_ollama"
CLAWDBOT_DIR="/Users/zayed/Downloads/clawdbot"

echo "=== Starting Ollama + Clawdbot Setup ==="

# 1. Verify pi-ai patch
PI_AI=$(find "$CLAWDBOT_DIR/node_modules" -path "*pi-ai*/dist/models.generated.js" | head -1)
PATCH_COUNT=$(grep -c 'localhost:4000' "$PI_AI" 2>/dev/null || echo "0")
if [ "$PATCH_COUNT" != "21" ]; then
    echo "⚠️  Re-applying pi-ai patch..."
    sed -i '' 's|baseUrl: "https://api.anthropic.com"|baseUrl: "http://localhost:4000"|g' "$PI_AI"
fi
echo "✅ pi-ai patch verified"

# 2. Kill existing processes
pkill -f "litellm --config" 2>/dev/null || true
pkill -f "gateway --port 18789" 2>/dev/null || true
sleep 2

# 3. Start LiteLLM
echo "🚀 Starting LiteLLM..."
cd "$SERVE_DIR"
nohup /Users/zayed/miniconda3/envs/litellm/bin/litellm --config config.yaml --port 4000 > litellm.log 2>&1 &
sleep 3

# 4. Verify LiteLLM
if curl -s http://localhost:4000/v1/models -H "Authorization: Bearer sk-litellm-local" | grep -q "claude"; then
    echo "✅ LiteLLM running"
else
    echo "❌ LiteLLM failed to start"
    exit 1
fi

# 5. Start Clawdbot Gateway
echo "🚀 Starting Clawdbot Gateway..."
cd "$CLAWDBOT_DIR"
nohup node dist/index.js gateway --port 18789 --allow-unconfigured > gateway.log 2>&1 &
sleep 2
echo "✅ Gateway running on ws://127.0.0.1:18789"

echo ""
echo "=== Ready! ==="
echo "Connect with: cd $CLAWDBOT_DIR && node dist/index.js tui --url ws://127.0.0.1:18789 --thinking off"
```

Make executable:
```bash
chmod +x /Users/zayed/Downloads/serve_ollama/start-all.sh
```

---

## File Reference

| File | Purpose |
|------|---------|
| `serve_ollama/config.yaml` | LiteLLM model routing config |
| `serve_ollama/start-all.sh` | Startup script |
| `clawdbot/src/agents/auth-profiles/external-cli-sync.ts` | Disabled OAuth sync |
| `clawdbot/node_modules/.../pi-ai/dist/models.generated.js` | Patched baseUrl |
| `~/.clawdbot/agents/main/agent/auth-profiles.json` | API key for LiteLLM |

---

## Maintenance

### After `pnpm install` in clawdbot:
```bash
# Re-apply pi-ai patch
./serve_ollama/start-all.sh  # Does this automatically
```

### After pulling new Ollama models:
```bash
# Update config.yaml with new model names
vim /Users/zayed/Downloads/serve_ollama/config.yaml
# Restart LiteLLM
pkill -f litellm && litellm --config config.yaml --port 4000
```

### To switch models:
Edit `config.yaml` and change `model: ollama/MODEL_NAME` under each claude model entry.

---

*Last updated: 2026-01-17*
