# Ripley Code Overview

Ripley Code is a local AI coding agent CLI that connects directly to LM Studio. Users run `ripley` in their project directory.

## Core Features

- **File operations**: Read, create, edit files with AI assistance
- **Slash commands**: `/help` for full list. Covers files, git, sessions, modes, models, hooks.
- **Named models**: Switch between local models loaded in LM Studio (`/model`)
- **Cloud models**: Connect OpenRouter, Anthropic, or OpenAI providers (`/connect`)
- **System prompts**: Multiple prompt profiles in `prompts/` directory (`/prompt`)
- **Project instructions**: `RIPLEY.md` at project root for per-project AI customization
- **Interaction modes**: work (default), plan (preview only), ask (questions only)
- **Vision**: Image analysis via vision models or Gemini fallback (`/image`, `Alt+V`)
- **Hooks**: Automated AI or shell actions at lifecycle points (`/hooks`)
- **Sub-agents**: Spawn independent AI sessions for subtasks (`/agent`)
- **MCP integration**: External tool servers for email, calendar, tasks, etc. (`/mcp`)
- **Steering**: Redirect or inject context mid-conversation (`/steer`)
- **YOLO mode**: Auto-apply all changes without confirmation (`/yolo`)

## Topics

For detailed help on a specific feature, use these topic names:
- `hooks` - Lifecycle hooks (beforeTurn, afterTurn, etc.)
- `models` - Model system, switching, providers
- `commands` - All slash commands and keyboard shortcuts
- `project-instructions` - RIPLEY.md setup and usage
- `agents` - Sub-agent system
- `overview` - This page
