# Use Cases and Examples

Practical examples of using LocalBot for common workflows.

## Quick Reference

| Use Case | Interface | Command/Query |
|----------|-----------|---------------|
| Check genomics jobs | Chat/Bot | "show my tibanna jobs" |
| Generate report | Chat/Bot | "generate genomics report" |
| Run bash command | Chat | "run ls -la" |
| Read a file | Chat | "read /path/to/file" |
| Search files | Chat | "find all .py files" |
| Web search | Chat | "search web for latest python release" |

## Genomics Pipeline Monitoring

### Use Case 1: Daily Job Status Check

**Scenario:** Check pipeline status at start of day.

**Terminal Chat:**
```
/skill genomics-jobs
You: show my jobs
```

**Telegram Bot:**
```
You: show tibanna job status
```

**Output:** Table of recent jobs with status (completed/running/failed).

### Use Case 2: Check Failed Jobs

**Query:**
```
You: show failed jobs
```

**Direct command executed:**
```bash
showjobs -n 30 -status failed
```

### Use Case 3: Generate Status Report

**Full report with analysis:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "What's the overall pipeline health?"
```

**Quick jobs-only report:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "summary" --jobs-only
```

**Via chat:**
```
/skill genomics-report
You: generate a status report for today
```

### Use Case 4: Investigate Failures

**Query:**
```
You: generate failure report
```

Or directly:
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "What jobs failed and what might have caused them?"
```

**Output:** Detailed report with:
- List of failed job IDs
- Possible failure causes
- Recommendations

### Use Case 5: Check Specific Project

**Query:**
```
You: show jobs for project NewPanel-i100val-Run01
```

**Command:**
```bash
showjobs -p NewPanel-i100val-Run01
```

## General Development Tasks

### Use Case 6: File Operations

**Read a file:**
```
You: read the package.json file
```

**Edit a file:**
```
You: add a new script "test:watch" to package.json that runs "vitest --watch"
```

**Search for files:**
```
You: find all TypeScript files in src/
```

### Use Case 7: Running Commands

**Simple command:**
```
You: run npm test
```

**Complex command:**
```
You: run git log --oneline -10
```

**With explanation:**
```
You: what's in my current directory?
```
(Agent runs `ls -la` and explains results)

### Use Case 8: Code Exploration

**Find function:**
```
You: find where the Agent class is defined
```

**Understand code:**
```
You: explain what the router does in this project
```

### Use Case 9: Web Research

**Search:**
```
You: search the web for Ollama tool calling documentation
```

**Fetch URL:**
```
You: fetch and summarize https://example.com/docs
```

## Report Generation Workflows

### Use Case 10: Custom Question Reports

**Specific question:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "Are there any jobs that have been running for more than 2 hours?"
```

**Comparative analysis:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "Compare today's success rate to yesterday"
```

### Use Case 11: Scheduled Reports

**Create cron job for daily reports:**
```bash
# Add to crontab
0 8 * * * /Users/zayed/clawd/scripts/genomics-report.sh "Daily summary" -o ~/reports/daily-$(date +\%Y\%m\%d).md
```

### Use Case 12: Export for Sharing

**Generate and copy:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "Weekly summary" -o ~/Desktop/weekly-report.md
```

## Skill-Based Workflows

### Use Case 13: Activate Skill for Session

**Terminal:**
```
/skill genomics-jobs
You: [all subsequent queries use this skill context]
...
/skill off
```

### Use Case 14: Create Custom Skill

**Create skill file:**
```bash
mkdir -p ~/clawd/skills/my-workflow
cat > ~/clawd/skills/my-workflow/SKILL.md << 'EOF'
---
name: my-workflow
description: My custom workflow
triggers:
  - my workflow
  - custom task
---

# My Workflow

When the user asks about my workflow, do these steps:
1. Run `command1`
2. Check output
3. Run `command2`

## Commands

```bash
command1 --flag
command2 --option value
```
EOF
```

**Reload and use:**
```
/reload
/skill my-workflow
You: run my workflow
```

### Use Case 15: Override Skill for Project

**Create workspace-specific version:**
```bash
mkdir -p ./skills
cp ~/clawd/skills/genomics-jobs/SKILL.md ./skills/genomics-jobs.md
# Edit ./skills/genomics-jobs.md for project-specific commands
```

Workspace skills override global skills with same name.

## Telegram Bot Workflows

### Use Case 16: Mobile Job Monitoring

From phone:
```
You: any failed tibanna jobs?
Bot: [shows failed jobs list]

You: generate quick report
Bot: [generates jobs-only report, shows summary]
```

### Use Case 17: On-the-Go Commands

```
You: run showjobs -status running
Bot: [executes command, shows output]
```

### Use Case 18: Model Switching

```
/models
[Shows available models]

/model qwen2.5:32b
[Switches to smarter model for complex tasks]
```

## Advanced Workflows

### Use Case 19: Chained Operations

**Query:**
```
You: Find all failed jobs, get their IDs, and check the logs for the first one
```

**Agent will:**
1. Run `showjobs -status failed`
2. Extract job IDs
3. Run `tibanna log -j <first_job_id>`
4. Show results

### Use Case 20: Conditional Workflows

**Query:**
```
You: If there are any failed jobs, generate a failure report. Otherwise, just show a summary.
```

**Agent will:**
1. Check for failed jobs
2. Decide based on results
3. Execute appropriate action

### Use Case 21: Data Pipeline

**Script-based workflow:**
```bash
#!/bin/bash
# daily-check.sh

# Generate report
REPORT=$(/Users/zayed/clawd/scripts/genomics-report.sh "daily summary" --jobs-only)

# Check for failures
if echo "$REPORT" | grep -q "Failed:.*[1-9]"; then
    # Alert (could send to Slack, email, etc.)
    echo "ALERT: There are failed jobs!"
    echo "$REPORT"
fi
```

## Tips and Best Practices

### For Efficient Queries

1. **Be specific:**
   - Bad: "show stuff"
   - Good: "show failed jobs from today"

2. **Use direct commands:**
   - "run showjobs" is faster than "what's the job status"

3. **Leverage skills:**
   - Activate skill once, ask multiple related questions

### For Report Generation

1. **Use `--jobs-only` for speed** when you don't need file/EC2 data

2. **Ask specific questions** for more focused analysis

3. **Save reports** with `-o` for later reference

### For Development

1. **Use `/context`** to verify your context is loaded

2. **Use `/tools`** to see available capabilities

3. **Use `/model`** to switch between fast/smart models
