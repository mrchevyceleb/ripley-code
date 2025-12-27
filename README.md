# Ripley Code

A powerful local AI coding agent that runs on your own hardware using Qwen 2.5 Coder via LM Studio. Think Claude Code, but completely local and private.

## What's New in v3.0.0

- **Streaming responses** — Watch AI responses appear in real-time
- **Command history** — Use up/down arrows to navigate previous commands
- **Tab completion** — Complete commands, file paths, and @ mentions
- **Token tracking** — See token counts and get limit warnings
- **Image support** — Send screenshots to vision models
- **Watch mode** — Auto-reload files when they change on disk
- **Conversation persistence** — Save and load chat sessions
- **Project instructions** — Custom AI instructions per project
- **Config files** — Persistent settings via `.ripley/config.json`
- **Improved diffs** — Better multi-file change batching with summaries

## Features

### Core Capabilities
- **Read project files** — Loads files into context so AI understands your codebase
- **Write/edit files** — AI can create new files or modify existing ones
- **@ mentions** — Use `@filename` to quickly add files to context
- **Run shell commands** — Execute npm, git, and other terminal commands
- **Show diffs** — See colorful diffs before applying changes
- **Git integration** — Quick status, diff, and log commands
- **Search** — Find files and grep through code
- **Undo changes** — All edits are backed up and can be restored

### Power Features
- **Streaming** — Real-time response streaming with typing effect
- **Command history** — Navigate with ↑/↓ arrows, persisted across sessions
- **Tab completion** — Auto-complete commands, `/read` paths, and `@` mentions
- **Token tracking** — Monitor context size with limit warnings
- **Image support** — Send screenshots/images to vision-capable models
- **Watch mode** — Files auto-reload when changed externally
- **Session management** — Save, load, and list conversation sessions
- **Project config** — Custom settings and instructions per project

## Prerequisites

1. **LM Studio** running with Qwen 2.5 Coder 14B on `localhost:1234`
2. **AI Router** running on `localhost:3000`

## Installation

```bash
cd C:\ripley-code
npm install
npm link --force  # Makes 'ripley' command available globally
```

### Installing on Other Computers

**Option 1: Clone from GitHub**
```bash
git clone https://github.com/mrchevyceleb/ripley-code.git
cd ripley-code
npm install
npm link --force
```

**Option 2: Copy files**
Copy the entire `ripley-code` folder, then run `npm install && npm link --force`

## Usage

### Interactive Mode

```bash
cd your-project
ripley
```

### One-Shot Mode

```bash
ripley "Add a dark mode toggle to the header"
```

### @ Mentions (Quick File Loading)

Reference files directly in your message:

```
Fix the bug in @src/api/auth.ts
```

Glob patterns work too:

```
Review @src/components/*.tsx for performance issues
```

## Commands

### File Commands

| Command | Description |
|---------|-------------|
| `/files` | List files currently in context |
| `/read <path>` | Add file to context (supports globs: `*.tsx`) |
| `/unread <path>` | Remove file from context |
| `/tree` | Show project structure |
| `/find <pattern>` | Find files matching pattern |
| `/grep <text>` | Search for text in all source files |

### Git Commands

| Command | Description |
|---------|-------------|
| `/git` | Show git status |
| `/diff` | Show uncommitted changes |
| `/log` | Show recent commits |

### Session Commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation & reset context |
| `/clearhistory` | Clear conversation only (keep files) |
| `/context` | Show context size & token estimate |
| `/compact` | Toggle compact mode (shorter responses) |
| `/save [name]` | Save conversation to a session file |
| `/load [name]` | Load a saved conversation session |
| `/sessions` | List all saved sessions |

### Configuration Commands

| Command | Description |
|---------|-------------|
| `/config` | Show current configuration |
| `/set <key> <value>` | Set a configuration value |
| `/instructions` | Show project-specific instructions |
| `/tokens` | Show token usage for this session |

### Streaming & Watch

| Command | Description |
|---------|-------------|
| `/stream` | Toggle streaming mode on/off |
| `/watch` | Toggle file watch mode on/off |

### Image Support

| Command | Description |
|---------|-------------|
| `/image <path>` | Add an image to the next message |

### System Commands

| Command | Description |
|---------|-------------|
| `/run <cmd>` | Run a shell command |
| `/undo` | Show recent backups |
| `/restore <path>` | Restore last backup of a file |
| `/help` | Show all commands |
| `/exit` | Exit Ripley |

## Configuration

Ripley stores configuration in `.ripley/config.json` in your project root.

### Available Settings

```json
{
  "apiUrl": "http://localhost:3000",
  "streaming": true,
  "compact": false,
  "tokenLimit": 16000,
  "autoSave": true,
  "watchMode": false
}
```

### Setting Values

```bash
/set streaming true
/set tokenLimit 32000
/set compact false
```

## Project Instructions

Create `.ripley/instructions.md` in your project root to give Ripley project-specific context:

```markdown
# Project: My Awesome App

## Tech Stack
- React 18 with TypeScript
- Tailwind CSS
- Supabase for backend

## Coding Standards
- Use functional components with hooks
- Prefer named exports
- Use `const` by default

## Important Notes
- The API base URL is in `src/config.ts`
- Auth logic is in `src/hooks/useAuth.ts`
```

Ripley will automatically include these instructions in every request.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate command history |
| `Tab` | Auto-complete commands/files |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+D` | Exit Ripley |

## How It Works

1. **Scans your project** — Reads package.json, tsconfig.json, and other config files
2. **Loads instructions** — Includes `.ripley/instructions.md` if present
3. **Builds context** — Creates a summary of your project structure
4. **Handles @ mentions** — Auto-loads any files you reference with `@`
5. **Sends to AI** — Your request + context goes to the AI Router
6. **Streams response** — Shows AI response in real-time (if enabled)
7. **Parses response** — Extracts file operations and commands from AI output
8. **Shows diffs** — Displays batched changes with summary before applying
9. **Applies with confirmation** — Only writes files after you approve

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  RIPLEY CODE CLI v3.0.0 (localhost)                         │
│  ├── ripley.js           — Main CLI interface               │
│  ├── lib/                                                   │
│  │   ├── fileManager.js    — Read/write/backup files        │
│  │   ├── contextBuilder.js — Build project context          │
│  │   ├── commandRunner.js  — Execute shell commands         │
│  │   ├── diffViewer.js     — Show pretty diffs              │
│  │   ├── parser.js         — Parse AI file operations       │
│  │   ├── config.js         — Configuration management       │
│  │   ├── streamHandler.js  — SSE streaming support          │
│  │   ├── historyManager.js — Command history                │
│  │   ├── completer.js      — Tab completion                 │
│  │   ├── tokenCounter.js   — Token counting & limits        │
│  │   ├── watcher.js        — File change watching           │
│  │   └── imageHandler.js   — Image/screenshot support       │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼ HTTP POST / SSE Stream
┌─────────────────────────────────────────────────────────────┐
│  AI ROUTER (localhost:3000)                                  │
│  — Routes requests to LM Studio with system prompts          │
│  — Supports streaming via Server-Sent Events                 │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  LM STUDIO (localhost:1234)                                  │
│  — Qwen 2.5 Coder 14B on 4090 GPU                            │
│  — Or any compatible local model                             │
└─────────────────────────────────────────────────────────────┘
```

## File Context Strategy

Ripley is smart about what it loads:

- **Always reads:** package.json, tsconfig.json, README.md, config files
- **@ mentions:** Instantly load files referenced in your message
- **Glob support:** Use patterns like `@src/**/*.tsx`
- **Scans structure:** Gets folder tree (ignores node_modules, .git, etc.)
- **Size limits:** Skips files > 100KB and binary files
- **Respects .gitignore:** Ignores patterns from your gitignore

## Token Management

Ripley tracks token usage to help you stay within model limits:

- `/tokens` — View current session token usage
- `/context` — See context size estimate
- Automatic warnings when approaching limits
- Configurable token limit via `/set tokenLimit <value>`

## Watch Mode

Enable watch mode to auto-reload files when they change:

```bash
/watch
```

When enabled, any files in your context that change on disk will be automatically reloaded. Great for:
- Working with hot-reload dev servers
- Editing files in your IDE while chatting
- Keeping context fresh during development

## Session Persistence

Save your conversation to continue later:

```bash
/save my-feature      # Save current session
/sessions             # List all saved sessions
/load my-feature      # Load a saved session
```

Sessions are stored in `.ripley/sessions/` and include:
- Full conversation history
- Loaded files
- Configuration state

## Backups

All file changes are automatically backed up to `.ripley/backups/` with timestamps.

- `/undo` — See recent backups
- `/restore <path>` — Restore a file to its last backup

## Environment Variables

- `RIPLEY_API_URL` — AI Router URL (default: `http://localhost:3000`)

## Tips

- Use `/compact` for shorter AI responses
- Use `/stream` for real-time response streaming
- Use `/context` to check token usage before big requests
- Use `/grep` to find where something is used before asking AI to change it
- Reference files with `@` instead of manually using `/read`
- Create `.ripley/instructions.md` for project-specific AI guidance
- Use `/save` before experimenting with big changes
- Enable `/watch` when actively developing

## Changelog

### v3.0.0
- Added streaming responses with SSE support
- Added command history with up/down arrow navigation
- Added tab completion for commands and file paths
- Added token tracking with limit warnings
- Added image/screenshot support for vision models
- Added file watch mode for auto-reload
- Added conversation save/load persistence
- Added project-specific instructions support
- Added configuration file support
- Improved multi-file diff batching with summaries
- Better error handling and recovery

### v2.0.0
- Initial public release
- File management with @ mentions
- Git integration
- Backup/restore system
- Diff viewing

## License

MIT
