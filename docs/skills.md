# Skills Guide

Complete guide to using and creating skills in LocalBot.

## What Are Skills?

Skills are markdown files that inject domain-specific knowledge and instructions into the AI's context. When a skill is activated, the AI gains specialized knowledge and can execute domain-specific commands.

**Two types of skills:**

1. **Prompt Skills** (`.md` files) - Inject context/instructions
2. **Tool Skills** (`.yaml` files) - Define executable tools

This guide focuses on Prompt Skills, which are most commonly used.

## Using Skills

### Terminal Chat Mode

```bash
# List available skills
/skills

# Activate a skill
/skill genomics-jobs

# Now all queries use this skill context
You: show jobs
  [Using skill: genomics-jobs]
Assistant: [runs showjobs command]

# Deactivate skill
/skill off
```

### Telegram Bot Mode

Skills are auto-detected by keywords:

```
User: check my tibanna jobs
Bot: [auto-detects genomics-jobs skill, runs showjobs]

User: generate genomics report
Bot: [auto-detects genomics-report skill, runs report generator]
```

## Skill File Format

### Basic Structure

```markdown
---
name: my-skill
description: Short description of what this skill does
invocation: auto
triggers:
  - keyword1
  - keyword2
  - phrase to match
---

# Skill Title

Main content and instructions for the AI...

## Commands

```bash
example_command --flag value
```

## Usage Examples

Describe how to use this skill...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (used in `/skill name`) |
| `description` | Yes | Brief description (shown in `/skills`) |
| `invocation` | No | `auto` (default) or `manual` |
| `triggers` | No | Keywords for auto-detection |
| `tags` | No | Categories for organization |
| `version` | No | Version string |
| `author` | No | Author name |
| `priority` | No | Override order (higher = loaded later) |

### Invocation Modes

- **auto** (default): Skill can be auto-detected by keywords
- **manual**: Only activated via `/skill name`

## Creating a New Skill

### Step 1: Create Skill File

Choose a location:
- `~/clawd/skills/my-skill.md` - Global (all projects)
- `./skills/my-skill.md` - Workspace-specific

For complex skills with multiple files:
```
~/clawd/skills/my-skill/
└── SKILL.md
```

### Step 2: Write Frontmatter

```markdown
---
name: my-skill
description: Describe what this skill enables
triggers:
  - keyword1
  - keyword2
---
```

### Step 3: Write Content

The content should include:

1. **Overview** - What the skill does
2. **Commands** - Specific commands the AI should use
3. **Examples** - Usage patterns
4. **Notes** - Important considerations

### Step 4: Test

```bash
# Reload skills
/reload

# List skills
/skills

# Activate and test
/skill my-skill
You: do something with my-skill
```

## Example Skills

### Simple Command Skill

```markdown
---
name: docker-helper
description: Docker container management commands
triggers:
  - docker
  - container
  - image
---

# Docker Helper

Help with Docker container management.

## Common Commands

**List containers:**
```bash
docker ps -a
```

**List images:**
```bash
docker images
```

**Stop all containers:**
```bash
docker stop $(docker ps -q)
```

## Usage

When the user asks about Docker, use these commands to help them manage containers and images.
```

### Complex Domain Skill

```markdown
---
name: genomics-jobs
description: Monitor Tibanna genomics pipeline jobs
triggers:
  - tibanna
  - genomics
  - showjobs
  - pipeline job
---

# Genomics Jobs Monitoring

Monitor genomics analysis jobs on AWS via Tibanna.

## Quick Commands

| Task | Command |
|------|---------|
| Show all jobs | `showjobs` |
| Show running | `showjobs -status running` |
| Show failed | `showjobs -status failed` |
| Job summary | `showjobs -n 50 \| grep -E '^\|' \| awk -F'\|' '{print $7}' \| sort \| uniq -c` |

## Detailed Usage

### Check Job Status
```bash
showjobs -n 30
```

### Filter by Status
```bash
showjobs -status completed
showjobs -status failed
showjobs -status running
```

## Important Notes

- `showjobs` runs locally (reads from DynamoDB)
- Job submission requires SSH to remote server
- Always check for failed jobs that need retry
```

### Report Generation Skill

```markdown
---
name: genomics-report
description: Generate LLM-summarized genomics pipeline reports
triggers:
  - genomics report
  - pipeline report
  - generate report
---

# Genomics Report Generator

Generate comprehensive reports from pipeline data.

## Quick Start

```bash
/Users/zayed/clawd/scripts/genomics-report.sh "your question"
```

## Examples

**General status:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh
```

**Failure analysis:**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "what failed and why?"
```

**Quick summary (jobs only):**
```bash
/Users/zayed/clawd/scripts/genomics-report.sh "summary" --jobs-only
```

## Options

- `--model, -m` - LLM model to use
- `--output, -o` - Output file path
- `--jobs-only` - Skip file/EC2 collection
```

## Direct Command Mapping

For Telegram bot, you can map keywords directly to commands:

In `src/telegram/bot.ts`:

```typescript
const SKILL_KEYWORDS: Record<string, string[]> = {
  'my-skill': ['keyword1', 'keyword2', 'my phrase'],
};

const SKILL_COMMANDS: Record<string, Array<{
  patterns: string[];
  command: string;
  description: string;
}>> = {
  'my-skill': [
    {
      patterns: ['do task', 'run task'],
      command: 'my-command --flag',
      description: 'Execute the task'
    },
  ],
};
```

This enables:
- Keyword detection → skill activation
- Pattern matching → direct command execution

## Skill Directories

Skills are loaded from multiple directories in order:

1. `LOCALBOT_EXTRA_SKILLS_DIRS` (colon-separated paths)
2. `~/.localbot/skills-bundled/` (bundled)
3. `~/.localbot/skills/` (managed)
4. `./skills/` (workspace)
5. `~/clawd/skills/` (global context)

Later directories override earlier ones with the same skill name.

## Best Practices

### DO

- Write clear, specific commands
- Include examples of expected output
- Group related commands logically
- Use code blocks for all commands
- Include error handling notes

### DON'T

- Include overly long content (hurts model performance)
- Mix unrelated functionality
- Assume model knows domain specifics
- Forget to add triggers for auto-detection

### Keeping Skills Focused

Bad:
```markdown
# Everything Skill
Docker commands, Git commands, AWS commands, database queries...
```

Good:
```markdown
# Docker Helper
Only Docker-related commands and workflows.
```

## Debugging Skills

### Skill Not Loading

```bash
# Check skill syntax
cat ~/clawd/skills/my-skill/SKILL.md

# Check directory permissions
ls -la ~/clawd/skills/

# Reload and check
/reload
/skills
```

### Skill Not Triggering

- Check triggers in frontmatter
- Verify keyword is in your message
- Use `/skill name` to force activation

### Commands Not Executing

- Model may explain instead of execute
- Use more direct language: "run", "execute", "show me"
- Check the skill instructions are clear about execution
