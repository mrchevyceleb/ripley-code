# Banana Code

AI coding agent CLI powered by Monkey Models. Run cloud models with 4 quality tiers, or connect Anthropic/OpenAI/OpenRouter with `/connect`.

## What's New in v1.2.0

- **Monkey Models integration** - 4 branded tiers: Silverback, Mandrill, Gibbon, Tamarin
- **Multi-provider support** - Monkey Models (default) + Anthropic/OpenAI/OpenRouter
- **Vision via cloud proxy** - Images routed through Gemini Flash transparently
- **Extensible prompts** - Drop `.md` files in `prompts/` for custom system prompts
- **Agentic mode built-in** - Tool-calling loop runs locally (read_file, list_files, search_code)
- **Model shown in prompt** - `[mandrill] You -->` so you always know what tier you're using

## Prerequisites

1. **Node.js** 18+
2. **Monkey Models token** (set via `BANANA_MONKEY_TOKEN` env var or `/connect`)
3. **LM Studio** (optional, for local model fallback)

## Installation

```bash
npm install -g banana-code
```

### Upgrade

```bash
npm install -g banana-code@latest
```

## Usage

```bash
cd your-project
banana
```

### One-Shot Mode

```bash
banana "Add a dark mode toggle to the header"
```

### YOLO Mode (auto-apply all changes)

```bash
banana yolo
```

## Model Tiers

Switch between Monkey Models tiers:

```
/model              Show all models
/model silverback   Switch to Silverback (best quality, heavy coding)
/model mandrill     Switch to Mandrill (balanced, default)
/model gibbon       Switch to Gibbon (fast, quick fixes)
/model tamarin      Switch to Tamarin (budget, simple tasks)
/model anthropic:claude-sonnet-4.6   Switch to connected Anthropic model
/model openai:codex-5.3-medium       Switch to connected OpenAI Codex model
/model search gemini                 Search OpenRouter catalog and add/switch model
```

Connect remote providers:

```
/connect                   Interactive provider wizard
/connect anthropic         Connect Anthropic with API key
/connect openrouter        Connect OpenRouter with API key
/connect openai            Connect OpenAI via OAuth device code
/connect status            Show connection status
```

Model choice persists across sessions. The active model shows in your prompt:

```
[mandrill] You --> fix the auth bug
[silverback] You --> refactor this whole module
```

## Prompt System

Banana ships with two prompts:

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
| `/image <path>` | Add image (vision via Monkey Models proxy) |

### Mode Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle PLAN mode (preview only) |
| `/ask` | Toggle ASK mode (questions only) |
| `/yolo` | Toggle YOLO mode (auto-apply) |
| `/agent` | Toggle agentic mode (AI reads files on demand) |
| `/steer <message>` | Steer next turn, or interrupt + redirect a running turn |
| `/model [name]` | Show/switch model |
| `/connect [provider]` | Connect/manage remote providers |
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
| `Up` / `Down` | Navigate command history |
| `Tab` | Auto-complete |
| `Shift+Tab` | Cycle modes (code -> plan -> ask) |
| `Alt+V` | Paste screenshot from clipboard |
| `Escape` | Cancel current request |

## Architecture

```
Banana Code v1.2.0  ──────────>  Monkey Models (cloud API)
├── banana.js                     4 tiers: Silverback, Mandrill, Gibbon, Tamarin
├── models.json                 + Remote Providers (Anthropic, OpenAI, OpenRouter)
├── prompts/                    + LM Studio (local fallback)
│   ├── base.md
│   └── code-agent.md
└── lib/
    ├── monkeyModels.js    Monkey Models API client
    ├── lmStudio.js        Local LM Studio API client (fallback)
    ├── providerStore.js   Global provider credentials/aliases
    ├── providerManager.js Provider routing + auth handling
    ├── modelRegistry.js   Model switching
    ├── promptManager.js   Prompt loading
    ├── agenticRunner.js   Tool-calling loop
    ├── streamHandler.js   SSE processing
    ├── visionAnalyzer.js  Vision via Monkey Models proxy
    └── [9 more modules]
```

## Vision Support

Images are sent as `image_url` content blocks to Monkey Models. The server transparently proxies them through Gemini Flash for analysis and injects a rich text description for the coding model.

- Clipboard paste (`Alt+V`) and file path (`/image screenshot.png`)
- Supported formats: base64 data URIs and public URLs

## Project Instructions

Create `BANANA.md` in your project root for project-specific AI context (like CLAUDE.md for Claude Code):

```markdown
# BANANA.md

This file provides project-specific instructions to Banana Code.

## Project Overview
- React 18 with TypeScript
- Use functional components
- API is in src/api/
```

Also supports the legacy `.banana/instructions.md` as a fallback.

## Steering Messages

Use `/steer` to inject additional guidance into the next turn without editing prompts:

```text
/steer Focus on minimal diffs and skip refactors unless requested
/steer status
/steer show
/steer clear
/steer on
/steer off
```

Queued steering messages are inserted as extra user guidance before your next request, then automatically consumed after a successful turn.
If a turn is currently running, enter `/steer <text>` and press Enter to interrupt and continue with the new steering.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BANANA_MONKEY_TOKEN` | Monkey Models API token | -- |
| `BANANA_LM_STUDIO_URL` | LM Studio URL (local fallback) | `http://localhost:1234` |
| `GEMINI_API_KEY` | Gemini vision fallback | -- |
| `ANTHROPIC_API_KEY` | Anthropic API key fallback (if not saved via `/connect`) | -- |
| `OPENROUTER_API_KEY` | OpenRouter API key fallback (if not saved via `/connect`) | -- |
| `BANANA_DEBUG` | Enable/disable debug logging (`1`/`0`) | `1` (enabled by default) |
| `BANANA_DEBUG_PATH` | Debug log file path | `~/.banana/logs/banana-YYYY-MM-DD.log` |

By default, Banana writes debug logs to `~/.banana/logs/` on every run.
Set `BANANA_DEBUG=0` to turn this off.

## Changelog

### v1.2.0
- Rebranded from Ripley Code to Banana Code
- Monkey Models integration (4 cloud tiers: Silverback, Mandrill, Gibbon, Tamarin)
- Vision via Monkey Models Gemini proxy
- Banana yellow (#FFD60A) color scheme
- New ASCII banner and breathing glow animation

### v4.0.0 (as Ripley Code)
- Direct LM Studio connection (removed AI Router dependency)
- Named model profiles with `/model` switching
- Auto-discovery of model IDs from LM Studio
- Local vision model support with Gemini fallback
- Extensible prompt system (drop .md files in prompts/)
- Agentic tool-calling loop runs locally

## License

MIT
