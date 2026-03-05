# Ripley Code

A powerful local AI coding agent that runs on your own hardware. Direct connection to LM Studio - no middleware needed. Think Claude Code, but completely local and private.

## What's New in v4.0.0

- **Direct to LM Studio** - No more AI Router middleware. One process, one connection.
- **Named model profiles** - 7 models with friendly names and `/model` switching
- **Auto-discovery** - Model IDs detected from LM Studio on startup
- **Local vision** - Send images directly to vision models (Qwen3 VL)
- **Extensible prompts** - Drop `.md` files in `prompts/` for custom system prompts
- **Agentic mode built-in** - Tool-calling loop runs locally (read_file, list_files, search_code)
- **Model shown in prompt** - `[nemotron] You →` so you always know what model you're using

## Prerequisites

1. **LM Studio** running on `localhost:1234` with any model loaded
2. **Node.js** 18+

## Installation

```bash
npm install -g git+https://github.com/mrchevyceleb/ripley-code.git
```

### Upgrade

```bash
npm install -g git+https://github.com/mrchevyceleb/ripley-code.git
```

## Usage

```bash
cd your-project
ripley
```

### One-Shot Mode

```bash
ripley "Add a dark mode toggle to the header"
```

### YOLO Mode (auto-apply all changes)

```bash
ripley yolo
```

## Model Switching

Switch between models with friendly names:

```
/model              Show all models
/model nemotron     Switch to Nemotron (daily driver)
/model coder        Switch to Qwen2.5 Coder 32B
/model max          Switch to 80B max quality (slow)
/model vision       Switch to Qwen3 VL 30B
/model vision-fast  Switch to Qwen3 VL 8B
/model chat         Switch to GPT-OSS 20B
/model mistral      Switch to Mistral Small 24B
```

Model choice persists across sessions. The active model shows in your prompt:

```
⚡ [nemotron] You → fix the auth bug
⚡ [coder] You → refactor this whole module
```

## Prompt System

Ripley ships with two prompts:

- `base` - General coding assistant (default)
- `code-agent` - Optimized for agentic tool-calling mode

Add custom prompts by dropping `.md` files in the `prompts/` directory:

```
/prompt             Show available prompts
/prompt base        Switch to base prompt
```

## Commands

### File Commands

| Command | Description |
|---------|-------------|
| `/files` | List files currently in context |
| `/read <path>` | Add file to context (supports globs) |
| `/unread <path>` | Remove file from context |
| `/tree` | Show project structure |
| `/find <pattern>` | Find files matching pattern |
| `/grep <text>` | Search for text in files |
| `/image <path>` | Add image (vision model or Gemini fallback) |

### Mode Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle PLAN mode (preview only) |
| `/ask` | Toggle ASK mode (questions only) |
| `/yolo` | Toggle YOLO mode (auto-apply) |
| `/agent` | Toggle agentic mode (AI reads files on demand) |
| `/model [name]` | Show/switch model |
| `/prompt [name]` | Show/switch system prompt |

### Git, Session, Config, System

| Command | Description |
|---------|-------------|
| `/git` | Git status |
| `/diff` | Uncommitted changes |
| `/log` | Recent commits |
| `/clear` | Clear conversation & context |
| `/save <name>` | Save session |
| `/load <name>` | Load session |
| `/config` | Show configuration |
| `/run <cmd>` | Run shell command |
| `/undo` | Show backups |
| `/restore <path>` | Restore from backup |
| `/help` | All commands |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate command history |
| `Tab` | Auto-complete |
| `Shift+Tab` | Cycle modes (code → plan → ask) |
| `Alt+V` | Paste screenshot from clipboard |
| `Escape` | Cancel current request |

## Architecture

```
Ripley Code v4.0.0  ──────────▶  LM Studio (localhost:1234)
├── ripley.js                     Any local model
├── models.json
├── prompts/
│   ├── base.md
│   └── code-agent.md
└── lib/
    ├── lmStudio.js       Direct API client
    ├── modelRegistry.js   Model switching
    ├── promptManager.js   Prompt loading
    ├── agenticRunner.js   Tool-calling loop
    ├── streamHandler.js   SSE processing
    ├── visionAnalyzer.js  Vision + Gemini fallback
    └── [9 more modules]
```

## Vision Support

When a vision model is loaded (`/model vision` or `/model vision-fast`):
- Images are sent directly to LM Studio as multimodal content
- Supports clipboard paste (`Alt+V`) and file path (`/image screenshot.png`)

When a non-vision model is loaded:
- Falls back to Gemini API to convert images to text descriptions
- Requires `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable

## Project Instructions

Create `RIPLEY.md` in your project root for project-specific AI context (like CLAUDE.md for Claude Code):

```markdown
# RIPLEY.md

This file provides project-specific instructions to Ripley Code.

## Project Overview
- React 18 with TypeScript
- Use functional components
- API is in src/api/
```

Also supports the legacy `.ripley/instructions.md` as a fallback.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `RIPLEY_LM_STUDIO_URL` | LM Studio URL | `http://localhost:1234` |
| `GEMINI_API_KEY` | Gemini vision fallback | — |

## Changelog

### v4.0.0
- Direct LM Studio connection (removed AI Router dependency)
- Named model profiles with `/model` switching
- Auto-discovery of model IDs from LM Studio
- Local vision model support with Gemini fallback
- Extensible prompt system (drop .md files in prompts/)
- Agentic tool-calling loop runs locally
- Model name shown in prompt prefix

### v3.0.0
- Streaming responses, command history, tab completion
- Token tracking, image support, watch mode
- Session persistence, project instructions

## License

MIT
