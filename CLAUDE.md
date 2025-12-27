# CLAUDE.md - Project Context for AI Assistants

## What is Ripley Code?

A local AI coding agent CLI that connects to LM Studio via an AI Router. Users run `ripley` in their project directory to get AI-assisted coding with file operations.

## Architecture

```
User's Machine                    Main Server (Matt's PC)
┌──────────────┐                 ┌─────────────────────────────┐
│ ripley.js    │ ──HTTP POST──▶  │ AI Router (localhost:3000)  │
│ (this repo)  │ ◀──SSE Stream── │ C:\ai-router\               │
└──────────────┘                 │   └── prompts/              │
                                 │       ├── base.md (chat)    │
                                 │       ├── saas.md (apps)    │
                                 │       ├── landing.md (html) │
                                 │       └── code-agent.md     │
                                 └─────────────┬───────────────┘
                                               │
                                               ▼
                                 ┌─────────────────────────────┐
                                 │ LM Studio (localhost:1234)  │
                                 │ Qwen 2.5 Coder 14B          │
                                 └─────────────────────────────┘
```

## Key Files

- `ripley.js` - Main CLI (1200+ lines, handles everything)
- `lib/` - Helper modules (file ops, diffing, streaming, etc.)
- `.ripley/` - Per-project config directory (created in user's projects)

## Important Features

### YOLO Mode (`/yolo`)
Toggles auto-apply mode - file changes and commands run without confirmation.
Implemented in `handleFileOperations()` and `handleCommands()` functions.

### File Operations
AI outputs `<file_operation>` blocks that get parsed and applied:
```xml
<file_operation>
<action>create|edit|delete</action>
<path>relative/path.ts</path>
<content>full file content</content>
</file_operation>
```

### Shell Commands
AI outputs `<run_command>` blocks:
```xml
<run_command>
npm install axios
</run_command>
```

## AI Router Prompts (on main server only)

The prompts in `C:\ai-router\prompts\` tell Ripley how to behave:
- **Non-interactive flags required** - CLI can't handle interactive prompts
- **Don't ask permission** - Just make changes, CLI handles confirmations
- **TypeScript for apps** - saas.md uses TypeScript + Next.js + Tailwind
- **Vanilla for landing pages** - landing.md outputs HTML/CSS only

## Common Tasks

### Adding a new command
1. Add case in the main `switch` statement (~line 400)
2. Update `/help` output
3. Update README.md

### Modifying AI behavior
Edit prompts in `C:\ai-router\prompts\` (main server only, not in this repo)

### Testing
Run `node ripley.js` in any project directory

## Git Info

- Repo: `https://github.com/mrchevyceleb/ripley-code.git`
- Main branch: `main`
- Push changes here to update the distributable CLI

## Dependencies

- `chalk` - Terminal colors
- `diff` - File diffing
- `ignore` - .gitignore parsing
- `glob` - File pattern matching
