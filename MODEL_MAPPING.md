# Custom Clawdbot + LiteLLM + Ollama

This setup routes clawdbot requests through LiteLLM to your Tailscale Ollama endpoint.

## Architecture

```
Clawdbot (custom) -> LiteLLM (localhost:4000) -> Ollama (100.121.61.16:11434)
   |                    |                           |
   |                    Anthropic API              via Tailscale
   No claude-cli sync   translation
```

## Custom Build Changes

The custom clawdbot at `/Users/zayed/Downloads/clawdbot` has:
1. **Claude-cli sync disabled** - Won't override your local config with OAuth credentials
2. **Ollama provider added** - Built-in support (though requires LiteLLM translation)

## Model Mapping

| Clawdbot Model | Alias | Ollama Model | Size |
|----------------|-------|--------------|------|
| `claude-haiku-4-5` | haiku | qwen2.5:32b | 19 GB |
| `claude-sonnet-4-5` | sonnet | gpt-oss:120b | 65 GB |
| `claude-opus-4-5` | opus | gpt-oss:120b | 65 GB |
| `deepseek-r1` | - | deepseek-r1:14b | 9 GB |
| `deepseek-v3` | - | deepseek-v3.2:cloud | remote |

## Quick Start

```bash
# Use the startup script
./start-clawdbot.sh

# Or manually:

# 1. Start LiteLLM (litellm conda env)
source ~/miniconda3/etc/profile.d/conda.sh && conda activate litellm
litellm --config /Users/zayed/Downloads/serve_ollama/config.yaml --port 4000

# 2. Start Custom Clawdbot
node /Users/zayed/Downloads/clawdbot/dist/index.js gateway --port 18789 --allow-unconfigured
```

## Switch Models in Clawdbot

```
/model haiku    -> qwen2.5:32b (fast, 32B params)
/model sonnet   -> gpt-oss:120b (powerful, 120B params)
/model opus     -> gpt-oss:120b (same as sonnet)
```

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| LiteLLM | http://localhost:4000 | API translation (Anthropic -> Ollama) |
| Ollama | http://100.121.61.16:11434 | Model serving (Tailscale) |
| Clawdbot | ws://127.0.0.1:18789 | Gateway |

## Key Config Files

| File | Purpose |
|------|---------|
| `config.yaml` | LiteLLM model routing |
| `~/.clawdbot/clawdbot.json` | Main clawdbot config (anthropic baseUrl override) |
| `~/.clawdbot/agents/main/agent/models.json` | Model definitions |
| `~/.clawdbot/agents/main/agent/auth-profiles.json` | API keys |

## Rebuild Custom Clawdbot

```bash
cd /Users/zayed/Downloads/clawdbot
pnpm build
```
