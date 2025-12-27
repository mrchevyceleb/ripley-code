# Ripley Code

A local AI coding agent that runs on your own hardware using Qwen 2.5 Coder via LM Studio.

## Features

- **Read project files** — Loads files into context so AI understands your codebase
- **Write/edit files** — AI can create new files or modify existing ones
- **@ mentions** — Use `@filename` to quickly add files to context
- **Run shell commands** — Execute npm, git, and other terminal commands
- **Show diffs** — See colorful diffs before applying changes
- **Git integration** — Quick status, diff, and log commands
- **Search** — Find files and grep through code
- **Undo changes** — All edits are backed up and can be restored

## Prerequisites

1. **LM Studio** running with Qwen 2.5 Coder 14B on `localhost:1234`
2. **AI Router** running on `localhost:3000`

## Installation

```bash
cd C:\ripley-code
npm install
npm link --force  # Makes 'ripley' command available globally
```

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

### System Commands

| Command | Description |
|---------|-------------|
| `/run <cmd>` | Run a shell command |
| `/undo` | Show recent backups |
| `/restore <path>` | Restore last backup of a file |
| `/help` | Show all commands |
| `/exit` | Exit Ripley |

## How It Works

1. **Scans your project** — Reads package.json, tsconfig.json, and other config files
2. **Builds context** — Creates a summary of your project structure
3. **Handles @ mentions** — Auto-loads any files you reference with `@`
4. **Sends to AI** — Your request + context goes to the AI Router
5. **Parses response** — Extracts file operations and commands from AI output
6. **Shows diffs** — Displays changes before applying
7. **Applies with confirmation** — Only writes files after you approve

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  RIPLEY CODE CLI (localhost)                        │
│  ├── fileManager.js    — Read/write/backup files   │
│  ├── contextBuilder.js — Build project context     │
│  ├── commandRunner.js  — Execute shell commands    │
│  ├── diffViewer.js     — Show pretty diffs         │
│  ├── parser.js         — Parse AI file operations  │
│  └── ripley.js         — Main CLI interface        │
└─────────────────────────────────────────────────────┘
                         │
                         ▼ HTTP POST
┌─────────────────────────────────────────────────────┐
│  AI ROUTER (localhost:3000)                         │
│  — Routes requests to LM Studio with system prompts │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│  LM STUDIO (localhost:1234)                         │
│  — Qwen 2.5 Coder 14B on 4090 GPU                   │
└─────────────────────────────────────────────────────┘
```

## File Context Strategy

Ripley is smart about what it loads:

- **Always reads:** package.json, tsconfig.json, README.md, config files
- **@ mentions:** Instantly load files referenced in your message
- **Glob support:** Use patterns like `@src/**/*.tsx`
- **Scans structure:** Gets folder tree (ignores node_modules, .git, etc.)
- **Size limits:** Skips files > 100KB and binary files
- **Respects .gitignore:** Ignores patterns from your gitignore

## Backups

All file changes are automatically backed up to `.ripley/backups/` with timestamps.

- `/undo` — See recent backups
- `/restore <path>` — Restore a file to its last backup

## Environment Variables

- `RIPLEY_API_URL` — AI Router URL (default: `http://localhost:3000`)

## Tips

- Use `/compact` for shorter AI responses
- Use `/context` to check token usage before big requests
- Use `/grep` to find where something is used before asking AI to change it
- Reference files with `@` instead of manually using `/read`

## License

MIT
