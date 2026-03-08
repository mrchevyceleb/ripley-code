# Hooks

Hooks are automated actions that fire at lifecycle points during a Ripley session. They can run AI agents or shell commands.

## Hook Points

| Point | When it fires |
|-------|--------------|
| `beforeTurn` | Before the AI processes a user message |
| `afterTurn` | After the AI responds |
| `afterWrite` | After a file is written |
| `afterCommand` | After a shell command runs |
| `onError` | When an error occurs |

## Triggers

- `always` - Fire every time the hook point is reached
- `fileChanged` - Only when files were modified
- `commandRan` - Only when a command was executed
- `hasErrors` - Only when an error occurred

## Hook Types

### Agent Hook (AI-powered)
Runs a prompt through an AI model. Can use the current model or any named model.
- **Single agent**: One model runs the task
- **A/B multi-agent**: Two models alternate, each seeing the other's output (e.g., writer + reviewer)

### Shell Hook
Runs a shell command. Supports template variables:
- `{{file}}` - The file that was written
- `{{files}}` - All files changed (comma-separated)
- `{{projectDir}}` - The project root directory

## Inject Modes

Hook output can be injected into the conversation:
- `prepend` - Added before the next user message
- `system` - Invisible system context
- `append` - Added after the next user message

## Scope

- **Global**: `~/.ripley/hooks.json` - applies to all projects
- **Project**: `.ripley/hooks.json` - project-specific, overrides global hooks with the same name

## Commands

- `/hooks` - Interactive list with toggle (Space to enable/disable, arrow keys to navigate)
- `/hooks add` - Create a hook (includes AI-refined instruction wizard)
- `/hooks edit [name]` - Edit an existing hook
- `/hooks remove <name>` - Remove a hook
- `/hooks toggle <name>` - Enable/disable by name (non-interactive)
- `/hooks test <name>` - Test-fire a hook with sample data

## Example: Creating a Hook

Walk the user through `/hooks add`. The wizard will ask:
1. Hook point (when to fire)
2. Hook type (Prompt/Agent/Shell)
3. For agent hooks: which model, the task/instructions, read-only vs read-write
4. Trigger condition
5. Scope (global or project)
6. The wizard can also accept a natural language description and use AI to refine it into proper hook instructions

## File Format

Hooks are stored in JSON files organized by hook point:

```json
{
  "afterTurn": [
    {
      "name": "code-review",
      "enabled": true,
      "agentA": { "model": "local:current", "task": "Review the code changes for bugs" },
      "trigger": "fileChanged",
      "readOnly": true,
      "inject": "prepend",
      "timeout": 60000
    }
  ]
}
```
