# Slash Commands

All commands start with `/`. Type `/help` to see the full list.

## File Commands
- `/files` - List files currently in context
- `/read <path>` - Add a file to context (also: `@filename` in messages)
- `/unread <path>` - Remove a file from context
- `/tree` - Show project directory structure
- `/find <pattern>` - Find files matching a glob pattern
- `/grep <text>` - Search for text across project files
- `/image <path>` - Add an image for vision analysis

## Git Commands
- `/git` - Show git status
- `/diff` - Show uncommitted changes
- `/log` - Show recent commits

## Session Commands
- `/clear` - Clear conversation and context
- `/clearhistory` - Clear conversation only (keep files)
- `/save <name>` - Save conversation to a named session
- `/load <name>` - Load a saved session
- `/sessions` - List all saved sessions
- `/context` - Show context size and token usage
- `/tokens` - Show token usage for this session
- `/compact` - Toggle compact response mode
- `/think` - Toggle thinking/reasoning mode

## Modes
- `/work` - Default mode. AI reads, writes, and runs commands.
- `/plan` - AI explores and creates a structured plan but makes no changes.
- `/implement` - Execute a saved plan from `.banana/plan.md`
- `/ask` - AI answers questions but performs no file operations.
- `/mode` - Show which mode is active
- `/yolo` - Toggle auto-apply (skip confirmation for file changes)

## Agent & Hook Commands
- `/agent [model] [task]` - Spawn a sub-agent (no args = interactive picker)
- `/hooks` - Manage lifecycle hooks (interactive toggle list)
- `/steer <text>` - Inject steering text into the next AI turn (or interrupt current turn)

## Model & Prompt Commands
- `/model [name]` - Show or switch the active model
- `/model search <query>` - Search OpenRouter for cloud models
- `/connect [provider]` - Connect a provider (Anthropic, OpenAI, OpenRouter)
- `/prompt [name]` - Show or switch the system prompt

## Config Commands
- `/config` - Show current configuration
- `/set <key> <value>` - Update a config value
- `/instructions` - View or create project instructions (BANANA.md)
- `/mcp` - MCP server status, setup, auth, tools
- `/watch` - Toggle file watch mode
- `/stream` - Toggle streaming mode

## System Commands
- `/run <cmd>` - Run a shell command
- `/undo` - Show recent file backups
- `/restore <path>` - Restore a file from backup
- `/commands` - List custom commands from `~/.banana/Commands/`
- `/version` - Show version
- `/exit` - Exit Banana

## Keyboard Shortcuts
- `Tab` - Autocomplete commands and file paths
- `Shift+Tab` - Cycle modes (work -> plan -> ask)
- `Alt+V` - Paste screenshot from clipboard
- `Esc Esc` (double-tap) - Cancel current AI request
- `Up/Down` - Navigate command history
- `@filename` - Inline file reference (auto-loads into context)
