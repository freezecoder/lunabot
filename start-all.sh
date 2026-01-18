#!/bin/bash
set -e

SERVE_DIR="/Users/zayed/Downloads/serve_ollama"
CLAWDBOT_DIR="/Users/zayed/Downloads/clawdbot"
LITELLM_BIN="/Users/zayed/miniconda3/envs/litellm/bin/litellm"

echo "=== Starting Ollama + Clawdbot Setup ==="

# 1. Verify pi-ai patch
PI_AI=$(find "$CLAWDBOT_DIR/node_modules" -path "*pi-ai*/dist/models.generated.js" 2>/dev/null | head -1)
if [ -z "$PI_AI" ]; then
    echo "❌ pi-ai not found. Run 'pnpm install' in clawdbot first."
    exit 1
fi

PATCH_COUNT=$(grep -c 'localhost:4000' "$PI_AI" 2>/dev/null || echo "0")
if [ "$PATCH_COUNT" != "21" ]; then
    echo "⚠️  Re-applying pi-ai patch..."
    sed -i '' 's|baseUrl: "https://api.anthropic.com"|baseUrl: "http://localhost:4000"|g' "$PI_AI"
    PATCH_COUNT=$(grep -c 'localhost:4000' "$PI_AI")
fi
echo "✅ pi-ai patch verified ($PATCH_COUNT occurrences)"

# 2. Kill existing processes
echo "🧹 Cleaning up existing processes..."
pkill -f "litellm --config" 2>/dev/null || true
pkill -f "gateway --port 18789" 2>/dev/null || true
sleep 2

# 3. Start LiteLLM
echo "🚀 Starting LiteLLM on port 4000..."
cd "$SERVE_DIR"
nohup "$LITELLM_BIN" --config config.yaml --port 4000 > litellm.log 2>&1 &
LITELLM_PID=$!
sleep 3

# 4. Verify LiteLLM
if curl -s http://localhost:4000/v1/models -H "Authorization: Bearer sk-litellm-local" 2>/dev/null | grep -q "claude"; then
    echo "✅ LiteLLM running (PID: $LITELLM_PID)"
else
    echo "❌ LiteLLM failed to start. Check litellm.log"
    cat litellm.log | tail -20
    exit 1
fi

# 5. Start Clawdbot Gateway
echo "🚀 Starting Clawdbot Gateway on port 18789..."
cd "$CLAWDBOT_DIR"
nohup node dist/index.js gateway --port 18789 --allow-unconfigured > "$SERVE_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
sleep 2

# Verify gateway
if lsof -i :18789 2>/dev/null | grep -q LISTEN; then
    echo "✅ Gateway running (PID: $GATEWAY_PID)"
else
    echo "❌ Gateway failed to start. Check gateway.log"
    exit 1
fi

# 6. Show status
echo ""
echo "=========================================="
echo "           ✅ ALL SERVICES READY"
echo "=========================================="
echo ""
echo "LiteLLM:  http://localhost:4000"
echo "Gateway:  ws://127.0.0.1:18789"
echo ""
echo "Logs:"
echo "  - LiteLLM: $SERVE_DIR/litellm.log"
echo "  - Gateway: $SERVE_DIR/gateway.log"
echo ""
echo "Connect with:"
echo "  cd $CLAWDBOT_DIR && node dist/index.js tui --url ws://127.0.0.1:18789 --thinking off"
echo ""
echo "Or run agent command:"
echo "  cd $CLAWDBOT_DIR && node dist/index.js agent --local --message \"Hello\" --session-id test --thinking off"
echo ""
