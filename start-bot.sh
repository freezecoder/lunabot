#!/bin/bash
# Start LocalBot Telegram bot

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Check for token
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN not set"
    echo ""
    echo "To set up:"
    echo "1. Talk to @BotFather on Telegram"
    echo "2. Create a new bot with /newbot"
    echo "3. Copy the token"
    echo "4. Add to .env file: TELEGRAM_BOT_TOKEN=your_token"
    exit 1
fi

# Set defaults
export OLLAMA_HOST="${OLLAMA_HOST:-http://100.121.61.16:11434}"
export DEFAULT_MODEL="${DEFAULT_MODEL:-llama3.1:8b}"
export SKILLS_DIR="${SKILLS_DIR:-./skills}"

echo "🤖 Starting LocalBot..."
echo "📡 Ollama: $OLLAMA_HOST"
echo "🧠 Model: $DEFAULT_MODEL"

# Check Ollama connectivity
echo "Checking Ollama connection..."
if curl -s --connect-timeout 5 "$OLLAMA_HOST/api/tags" > /dev/null 2>&1; then
    echo "✅ Ollama is reachable"
else
    echo "⚠️  Warning: Cannot reach Ollama at $OLLAMA_HOST"
    echo "   The bot will start but may fail on requests"
fi

# Run the bot
exec npm run bot
