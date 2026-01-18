#!/bin/bash

echo "=== Stopping Ollama + Clawdbot Services ==="

pkill -f "litellm --config" 2>/dev/null && echo "✅ LiteLLM stopped" || echo "⚪ LiteLLM not running"
pkill -f "gateway --port 18789" 2>/dev/null && echo "✅ Gateway stopped" || echo "⚪ Gateway not running"

echo "Done."
