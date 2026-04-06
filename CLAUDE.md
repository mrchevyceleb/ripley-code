# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## What is Banana Code?

An AI coding agent CLI (v1.3.0) powered by **Monkey Models** (cloud) with remote provider fallbacks. Users run `banana` in their project directory to get AI-assisted coding with file operations, streaming responses, model tier switching, vision support, and agentic tool calling.

## Architecture

```
Banana Code CLI   ──────────▶   Monkey Models (cloud API)
(this repo)                     4 tiers: Silverback, Mandrill, Gibbon, Tamarin
                  ──────────▶   Remote Providers (Anthropic, OpenAI, OpenRouter)
                  ──────────▶   LM Studio (localhost:1234, fallback)
```

## Key Files

| File | Purpose |
|------|---------|
| `banana.js` | Main CLI (~2000 lines) |
| `models.json` | Model registry (4 Monkey Models tiers) |
| `prompts/base.md` | Default system prompt |
| `prompts/code-agent.md` | Agentic mode system prompt |
| `lib/monkeyModels.js` | Monkey Models API client |
| `lib/lmStudio.js` | LM Studio API client (local fallback) |
| `lib/modelRegistry.js` | Model profiles + switching |
| `lib/promptManager.js` | Loads prompts from prompts/ directory |
| `lib/agenticRunner.js` | Tool-calling loop (read_file, list_files, search_code) |
| `lib/streamHandler.js` | SSE stream processing |
| `lib/visionAnalyzer.js` | Vision via Monkey Models proxy |
| `lib/config.js` | Config management (activeModel, activePrompt) |

## Installation

```bash
npm install -g banana-code
```

Upgrade: `npm install -g banana-code@latest`

## Development Setup (IMPORTANT - Do This First)

Before making any changes, ensure the global `banana` command is symlinked to this repo so edits are instantly live:

```bash
npm link --force
```

This creates a symlink so the global `banana` command points directly to `C:\ripley-code\banana.js`. No rebuild or reinstall needed after edits. Just save and re-run `banana`.

**Verify it's working:**
```bash
where banana
# Should show C:\ripley-code\banana.js
```

## Development Commands

```bash
# Run the CLI (in any project directory)
node banana.js

# Test safely (preview mode)
node banana.js
/plan
```

## Model System

4 Monkey Models tiers defined in `models.json`. Default: Mandrill.

```
/model              List all models
/model silverback   Switch to Silverback (best quality)
/model mandrill     Switch to Mandrill (balanced, default)
/model gibbon       Switch to Gibbon (fast)
/model tamarin      Switch to Tamarin (budget)
```

Model selection persists across sessions via config.

## Prompt System

Drop any `.md` file into `prompts/` and it becomes available:

```
/prompt             List available prompts
/prompt base        Switch to base prompt
/prompt code-agent  Switch to agentic prompt
```

## Interaction Modes

| Mode | Command | Behavior |
|------|---------|----------|
| **code** (default) | -- | AI applies file changes and runs commands |
| **plan** | `/plan` | Preview only - no changes applied |
| **ask** | `/ask` | AI explains but doesn't execute anything |

## AI Response Format

The AI outputs XML blocks that Banana parses and executes:

```xml
<file_operation>
<action>create|edit|delete</action>
<path>relative/path.ts</path>
<content>full file content</content>
</file_operation>

<run_command>
npm install axios
</run_command>
```

## Adding New CLI Commands

1. Add case in the `switch` statement in `handleCommand()` in `banana.js`
2. Update `showHelp()` function
3. Update README.md

## Adding New AI Tools (Agentic Mode)

Tools are now in `lib/agenticRunner.js` (not a separate server).

1. Define tool in `TOOLS` array (OpenAI-compatible format)
2. Implement executor function with path validation
3. Add to `executeTool()` switch
4. Optionally add display message in `sendAgenticMessage()` in banana.js

## Project Instructions (BANANA.md)

Users create `BANANA.md` at their project root (like CLAUDE.md for Claude Code). It is automatically loaded into the AI system prompt on every message.

- **Primary**: `BANANA.md` at project root (recommended)
- **Fallback**: `.banana/instructions.md` (legacy)
- `config.getInstructions()` returns `{ content, source }` or `null`
- `/instructions` command shows current instructions or creates `BANANA.md` template

## Vision

- Images sent as `image_url` content blocks to Monkey Models
- Server proxies through Gemini Flash for vision analysis transparently
- Clipboard paste via `Alt+V`, file via `/image <path>`

## Debug Logs

Logs are at `~/.banana/logs/banana-YYYY-MM-DD.log`. Enabled by default (set `BANANA_DEBUG=0` to disable). Override path with `BANANA_DEBUG_PATH`.

## Environment

- Windows with PowerShell
- Monkey Models API (cloud, requires BANANA_MONKEY_TOKEN)
- LM Studio at localhost:1234 (optional local fallback)
- Node.js 18+
