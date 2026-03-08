# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## What is Ripley Code?

A local AI coding agent CLI (v4.0.0) that connects **directly** to LM Studio. Users run `ripley` in their project directory to get AI-assisted coding with file operations, streaming responses, named model switching, vision support, and agentic tool calling.

## Architecture (v4.0 - Direct to LM Studio)

```
Ripley Code v4.0   ──────────▶   LM Studio (localhost:1234)
(this repo)                      Any local model loaded
```

No middleware. No AI Router. One process.

## Key Files

| File | Purpose |
|------|---------|
| `ripley.js` | Main CLI (~2000 lines) |
| `models.json` | Model registry (friendly names, tags, descriptions) |
| `prompts/base.md` | Default system prompt |
| `prompts/code-agent.md` | Agentic mode system prompt |
| `lib/lmStudio.js` | Direct LM Studio API client |
| `lib/modelRegistry.js` | Model profiles + switching |
| `lib/promptManager.js` | Loads prompts from prompts/ directory |
| `lib/agenticRunner.js` | Tool-calling loop (read_file, list_files, search_code) |
| `lib/streamHandler.js` | SSE stream processing |
| `lib/visionAnalyzer.js` | Local vision + Gemini fallback |
| `lib/config.js` | Config management (lmStudioUrl, activeModel, activePrompt) |

## Installation

```bash
npm install -g ripley-code
```

Upgrade: `npm install -g ripley-code@latest`

## Development Setup (IMPORTANT - Do This First)

Before making any changes, ensure the global `ripley` command is symlinked to this repo so edits are instantly live:

```bash
npm link --force
```

This creates a symlink so the global `ripley` command points directly to `C:\ripley-code\ripley.js`. No rebuild or reinstall needed after edits. Just save and re-run `ripley`.

**Verify it's working:**
```bash
where ripley
# Should show C:\ripley-code\ripley.js
```

## Development Commands

```bash
# Run the CLI (in any project directory)
node ripley.js

# Test safely (preview mode)
node ripley.js
/plan
```

## Model System

7 named models defined in `models.json`. Model IDs auto-discovered from LM Studio's `/v1/models` endpoint on startup.

```
/model              List all models
/model nemotron     Switch to Nemotron
/model coder        Switch to Qwen2.5 Coder 32B
/model vision       Switch to vision model
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
| **code** (default) | — | AI applies file changes and runs commands |
| **plan** | `/plan` | Preview only - no changes applied |
| **ask** | `/ask` | AI explains but doesn't execute anything |

## AI Response Format

The AI outputs XML blocks that Ripley parses and executes:

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

1. Add case in the `switch` statement in `handleCommand()` in `ripley.js`
2. Update `showHelp()` function
3. Update README.md

## Adding New AI Tools (Agentic Mode)

Tools are now in `lib/agenticRunner.js` (not a separate server).

1. Define tool in `TOOLS` array (OpenAI-compatible format)
2. Implement executor function with path validation
3. Add to `executeTool()` switch
4. Optionally add display message in `sendAgenticMessage()` in ripley.js

## Project Instructions (RIPLEY.md)

Users create `RIPLEY.md` at their project root (like CLAUDE.md for Claude Code). It is automatically loaded into the AI system prompt on every message.

- **Primary**: `RIPLEY.md` at project root (recommended)
- **Fallback**: `.ripley/instructions.md` (legacy)
- `config.getInstructions()` returns `{ content, source }` or `null`
- `/instructions` command shows current instructions or creates `RIPLEY.md` template

## Vision

- **Local vision model loaded** (tags include 'vision'): Images sent directly as multimodal messages
- **Non-vision model loaded**: Falls back to Gemini API analysis (requires `GEMINI_API_KEY`)
- Clipboard paste via `Alt+V`, file via `/image <path>`

## Environment

- Windows with PowerShell
- GPU: NVIDIA GPU with sufficient VRAM for loaded models
- LM Studio at localhost:1234
- Node.js 18+
