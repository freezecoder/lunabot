#!/bin/bash
# Run this after 'pnpm install' in clawdbot to re-apply patches

CLAWDBOT_DIR="/Users/zayed/Downloads/clawdbot"

echo "=== Re-applying patches after pnpm install ==="

# Find pi-ai models.generated.js
PI_AI=$(find "$CLAWDBOT_DIR/node_modules" -path "*pi-ai*/dist/models.generated.js" 2>/dev/null | head -1)

if [ -z "$PI_AI" ]; then
    echo "❌ pi-ai not found. Make sure pnpm install completed successfully."
    exit 1
fi

echo "Found: $PI_AI"

# Check current state
CURRENT=$(grep -c 'localhost:4000' "$PI_AI" 2>/dev/null || echo "0")
ANTHROPIC=$(grep -c 'api.anthropic.com' "$PI_AI" 2>/dev/null || echo "0")

echo "Current state: $CURRENT localhost:4000, $ANTHROPIC api.anthropic.com"

if [ "$ANTHROPIC" -gt "0" ]; then
    echo "🔧 Applying patch..."
    sed -i '' 's|baseUrl: "https://api.anthropic.com"|baseUrl: "http://localhost:4000"|g' "$PI_AI"

    # Verify
    NEW_COUNT=$(grep -c 'localhost:4000' "$PI_AI")
    echo "✅ Patched $NEW_COUNT occurrences"
else
    echo "✅ Already patched ($CURRENT occurrences)"
fi

echo ""
echo "Don't forget to rebuild clawdbot if you modified source files:"
echo "  cd $CLAWDBOT_DIR && pnpm build"
