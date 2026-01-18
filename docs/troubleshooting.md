# Troubleshooting Guide

Solutions for common issues with LocalBot.

## Connection Issues

### "Cannot connect to Ollama"

**Symptoms:**
- "Failed to list models"
- "Connection refused"
- Timeout errors

**Solutions:**

1. **Check Ollama is running:**
   ```bash
   curl http://localhost:11434/api/tags
   # Should return JSON with models
   ```

2. **Check OLLAMA_HOST:**
   ```bash
   echo $OLLAMA_HOST
   # Should be http://localhost:11434 or your remote URL
   ```

3. **For remote Ollama:**
   ```bash
   # On remote machine, ensure listening on all interfaces
   OLLAMA_HOST=0.0.0.0 ollama serve

   # Check firewall allows port 11434
   ```

4. **Restart Ollama:**
   ```bash
   # macOS
   brew services restart ollama

   # Linux
   sudo systemctl restart ollama
   ```

### "Model not found"

**Symptoms:**
- "model 'xyz' not found"

**Solutions:**

1. **Pull the model:**
   ```bash
   ollama pull qwen2.5:32b
   ```

2. **Check available models:**
   ```bash
   ollama list
   # or in chat
   /models
   ```

3. **Check model name spelling:**
   ```bash
   # Correct format
   llama3.1:8b
   qwen2.5:32b

   # Wrong
   llama3.1-8b
   qwen2.5
   ```

## Tool Execution Issues

### "Model explains instead of executing"

**Symptoms:**
- Model describes what command to run but doesn't run it
- "You can run this command: ..."

**Solutions:**

1. **Use direct language:**
   - Bad: "can you check jobs?"
   - Good: "run showjobs"

2. **Use skill with direct commands:**
   ```
   /skill genomics-jobs
   You: show jobs
   ```

3. **Check model supports tools:**
   ```
   /models
   # Look for 🔧 icon
   ```

4. **Try different model:**
   ```
   /model llama3.1:8b
   ```

### "Tools called unnecessarily"

**Symptoms:**
- "hello" triggers memory_search or web_search

**Solutions:**

1. **Memory tools are opt-in:**
   ```bash
   # Don't set this unless needed
   # LOCALBOT_ENABLE_MEMORY=true
   ```

2. **System prompt should prevent this** - if still happening, check context loaded:
   ```
   /context
   ```

### "Command not found"

**Symptoms:**
- "showjobs: command not found"

**Solutions:**

1. **Check command is in PATH:**
   ```bash
   which showjobs
   ```

2. **Use full path:**
   ```
   You: run /Users/zayed/miniconda3/bin/showjobs
   ```

3. **Add to PATH in .env or shell profile**

## Skill Issues

### "Skill not loading"

**Symptoms:**
- `/skills` doesn't show your skill
- "Skill 'xyz' not found"

**Solutions:**

1. **Check file location:**
   ```bash
   ls ~/clawd/skills/
   # Should see your skill
   ```

2. **Check file format:**
   ```bash
   cat ~/clawd/skills/my-skill/SKILL.md
   # Should have --- frontmatter ---
   ```

3. **Reload skills:**
   ```
   /reload
   /skills
   ```

4. **Check for syntax errors in frontmatter:**
   ```yaml
   # Correct
   ---
   name: my-skill
   description: Description here
   ---

   # Wrong - missing quotes for special chars
   ---
   description: This has: colons and "quotes"
   ---
   ```

### "Skill not auto-detecting"

**Symptoms:**
- Keyword should trigger skill but doesn't

**Solutions:**

1. **Check triggers in skill:**
   ```yaml
   triggers:
     - keyword1
     - keyword2
   ```

2. **Check keyword mapping in bot.ts:**
   ```typescript
   // SKILL_KEYWORDS must include your keywords
   ```

3. **Use explicit activation:**
   ```
   /skill my-skill
   ```

### "Skill commands not executing"

**Symptoms:**
- Skill activates but commands don't run

**Solutions:**

1. **Check command syntax in skill:**
   ```markdown
   # Use code blocks
   ```bash
   actual_command --flags
   ```
   ```

2. **Add to SKILL_COMMANDS for direct execution**

3. **Make instructions more explicit:**
   ```markdown
   IMPORTANT: Execute these commands, don't just explain them.
   ```

## Context Issues

### "Context not loading"

**Symptoms:**
- `/context` shows no files
- Bot doesn't know user name

**Solutions:**

1. **Check CONTEXT_DIR:**
   ```bash
   echo $CONTEXT_DIR
   ls $CONTEXT_DIR
   ```

2. **Check file extensions:**
   ```bash
   # Must be .md or .txt
   ls ~/clawd/*.md
   ```

3. **Reload context:**
   ```
   /reload
   /context
   ```

### "Wrong context loaded"

**Symptoms:**
- Bot has wrong personality
- Agent context overriding global

**Solutions:**

1. **Check both directories:**
   ```bash
   ls ~/clawd/
   ls ./agent/
   ```

2. **Agent files override global** - check for conflicts:
   ```
   /context
   # Look at [global] vs [agent] tags
   ```

## Report Generation Issues

### "Report generation fails"

**Symptoms:**
- "LLM generation failed"
- Empty report

**Solutions:**

1. **Check Ollama is running:**
   ```bash
   curl $OLLAMA_HOST/api/tags
   ```

2. **Check model exists:**
   ```bash
   ollama list | grep qwen2.5
   ```

3. **Check prompt file was created:**
   ```bash
   ls /tmp/genomics-reports/*/prompt.txt
   ```

4. **Try with different model:**
   ```bash
   genomics-report.sh "test" --model llama3.1:8b
   ```

### "Report takes too long"

**Solutions:**

1. **Use `--jobs-only` flag:**
   ```bash
   genomics-report.sh "summary" --jobs-only
   ```

2. **Use faster model:**
   ```bash
   genomics-report.sh "summary" --model llama3.1:8b
   ```

3. **Reduce data collection:**
   ```bash
   # Edit script to collect fewer records
   showjobs -n 50  # instead of -n 100
   ```

### "Wrong dates in report"

**Symptoms:**
- Report shows 2023 instead of current year

**Explanation:**
- LLM hallucination from training data
- Doesn't affect accuracy of job data

**Mitigation:**
- Add current date to prompt
- Use actual data, ignore LLM's date mentions

## Performance Issues

### "Slow responses"

**Solutions:**

1. **Check model size:**
   ```
   /model llama3.1:8b  # Faster
   ```

2. **Check network latency** (for remote Ollama):
   ```bash
   ping 100.121.61.16
   ```

3. **Check GPU usage:**
   ```bash
   nvidia-smi  # For NVIDIA GPUs
   ```

### "High memory usage"

**Solutions:**

1. **Use smaller model:**
   ```bash
   DEFAULT_MODEL=llama3.1:8b
   ```

2. **Limit Ollama VRAM:**
   ```bash
   OLLAMA_MAX_VRAM=8g ollama serve
   ```

3. **Clear conversation:**
   ```
   /clear
   ```

## Telegram Bot Issues

### "Bot not responding"

**Solutions:**

1. **Check token:**
   ```bash
   echo $TELEGRAM_BOT_TOKEN
   ```

2. **Check bot is running:**
   ```bash
   npm run bot
   # Look for "Bot started" message
   ```

3. **Check bot permissions** in Telegram:
   - Message @BotFather
   - Verify bot is not blocked

### "Messages not updating"

**Symptoms:**
- Streaming doesn't work
- Messages stuck on "Thinking..."

**Solutions:**

1. **Check rate limits** - Telegram limits edits

2. **Restart bot:**
   ```bash
   # Ctrl+C then
   npm run bot
   ```

## Getting Help

### Debug Mode

```bash
# Run with debug output
DEBUG=* npm run chat
```

### Check Logs

```bash
# Telegram bot logs
npm run bot 2>&1 | tee bot.log
```

### Test Components

```bash
# Test Ollama
curl $OLLAMA_HOST/api/generate -d '{"model":"llama3.1:8b","prompt":"Hi","stream":false}'

# Test showjobs
showjobs -n 5

# Test skill loading
node -e "import('./dist/src/skills/loader.js').then(m => m.loadSkillsWithPrecedence().then(console.log))"
```

### Report Issues

Include in bug reports:
- Error message
- Environment (macOS/Linux, Ollama version)
- Configuration (OLLAMA_HOST, models)
- Steps to reproduce
