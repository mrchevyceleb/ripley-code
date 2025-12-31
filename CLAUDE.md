# CLAUDE.md - Project Context for AI Assistants

## What is Ripley Code?

A local AI coding agent CLI (v3.3.0) that connects to LM Studio via an AI Router. Users run `ripley` in their project directory to get AI-assisted coding with file operations, streaming responses, vision analysis, and **agentic tool calling**.

## Architecture

```
User's Machine                    Main Server (Matt's PC)
┌──────────────┐                 ┌─────────────────────────────┐
│ ripley.js    │ ──HTTP POST──▶  │ AI Router (localhost:3000)  │
│ (this repo)  │ ◀──SSE Stream── │ C:\ai-router\               │
└──────────────┘                 │   └── prompts/              │
                                 │       ├── base.md           │
                                 │       ├── saas.md           │
                                 │       └── landing.md        │
                                 └─────────────┬───────────────┘
                                               │
                                               ▼
                                 ┌─────────────────────────────┐
                                 │ LM Studio (localhost:1234)  │
                                 │ NVIDIA Nemotron Nano 30B    │
                                 └─────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `ripley.js` | Main CLI (1400+ lines, all functionality) |
| `lib/streamHandler.js` | Streaming response handler, filters XML blocks & thinking |
| `lib/visionAnalyzer.js` | Gemini API integration for image analysis |
| `lib/parser.js` | Parses `<file_operation>` and `<run_command>` blocks |
| `lib/fileManager.js` | File operations (read, write, delete, backup) |
| `lib/commandRunner.js` | Executes shell commands with spinner UI |
| `lib/diffViewer.js` | Displays diffs and operation summaries |
| `lib/contextBuilder.js` | Manages conversation context and token limits |
| `lib/tokenCounter.js` | Token counting and cost estimation |
| `lib/completer.js` | Tab completion for commands and files |
| `lib/historyManager.js` | Command history and conversation save/load |
| `lib/imageHandler.js` | Image file handling and EXIF data |
| `lib/watcher.js` | File system watcher for auto-reload |
| `lib/markdownRenderer.js` | Renders Markdown to ANSI-styled terminal output |

## Interaction Modes

Three modes control how Ripley responds to user requests:

| Mode | Command | Behavior |
|------|---------|----------|
| **code** (default) | `/code` | AI applies file changes and runs commands automatically (with confirmation in YOLO off) |
| **plan** | `/plan` | AI only shows what it would do - no changes applied, no commands run |
| **ask** | `/ask` | AI explains what to do but doesn't execute anything |

## Key Features

### Streaming Output
- Responses stream in real-time using Server-Sent Events (SSE)
- XML blocks (`<file_operation>`, `<run_command>`, `<think>`) are filtered from display
- Orphan `</think>` tags (model reasoning without opening tag) are automatically cleaned

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

### YOLO Mode (`/yolo`)
Toggles auto-apply mode - file changes and commands execute without confirmation.

### Vision Analysis
- Image support via `/image <path>`
- Auto-analyzes images with Gemini API (requires `GEMINI_API_KEY` env var)
- Integrates analysis into conversation context

### Thinking Block Filtering
- Filters out `<think>` and `<thinking>` blocks from display
- Model reasoning stays hidden, only explanations shown to user
- Full response (with blocks) still captured for parsing

### Agentic Mode (`/agent`)
AI can read files and explore the project on demand using tool calling. This is the default mode.

**How it works:**
1. Ripley sends a minimal context (just file list, ~500 tokens) instead of full file contents
2. AI Router sends request to LM Studio with tool definitions
3. Model decides what files to read based on the question
4. Tools execute server-side, results fed back to model
5. Model generates final response with full context

**Benefits:**
- Much more efficient token usage
- AI only reads what's relevant to the question
- Faster initial response (less prompt processing)
- Can handle larger codebases

Toggle with `/agent` command. When off, uses traditional mode where files are pre-loaded.

### Markdown Rendering
- Responses render with ANSI styling in terminal
- **Bold**, *italic*, `inline code`, code blocks with language labels
- Headers colored by level, styled bullet points

## Agentic Tool System

The AI Router (`C:\ai-router\server.js`) implements tool calling for agentic mode. Tools are defined using OpenAI-compatible format and executed server-side.

### Current Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_file` | Read contents of a file | `path` (string, required) |
| `list_files` | List files in a directory | `path` (string), `recursive` (boolean) |
| `search_code` | Search for patterns in files | `pattern` (string, required), `path` (string), `file_pattern` (string) |

### Adding New Tools

1. **Define the tool** in `C:\ai-router\server.js` in the `tools` array:
```javascript
{
  type: 'function',
  function: {
    name: 'tool_name',
    description: 'What the tool does',
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'Parameter description'
        }
      },
      required: ['param1']
    }
  }
}
```

2. **Implement the executor** function:
```javascript
function executeToolName(projectDir, param1) {
  // Security: validate paths stay within projectDir
  // Execute the tool logic
  // Return { result } or { error: 'message' }
}
```

3. **Add to the switch** in `executeTool()`:
```javascript
case 'tool_name':
  return executeToolName(projectDir, args.param1);
```

4. **Update Ripley's display** (optional) in `sendAgenticMessage()`:
```javascript
const toolMessages = {
  tool_name: '🔧 Doing something',
  // ...
};
```

### Tool Execution Flow

```
User asks question
       ↓
Ripley sends to /api/chat/agentic with projectDir
       ↓
AI Router builds messages with tool definitions
       ↓
LM Studio returns tool_calls (or final response)
       ↓
AI Router executes tools, adds results to messages
       ↓
Loop until model gives final response (max 10 iterations)
       ↓
Stream events back to Ripley (tool_call, tool_result, content)
       ↓
Ripley displays progress and final response
```

### Security Considerations
- All file paths are validated to stay within `projectDir`
- Tools ignore `node_modules`, `.git`, etc.
- File reads are truncated at 50KB
- Search results capped at 50 matches
- Max 10 tool call iterations per request

## AI Router Prompts

The prompts in `C:\ai-router\prompts\` control AI behavior:

| Prompt | Purpose | Tech Stack |
|--------|---------|-----------|
| `base.md` | General coding assistant | Any language/framework |
| `saas.md` | SaaS/app builder | TypeScript + Next.js + Tailwind + Supabase |
| `landing.md` | Landing page builder | HTML/CSS (dark glassmorphism, 12 sections) |

**Prompt Design Rules:**
- Non-interactive mode required (no prompts that need user input)
- Output XML blocks for file operations and commands
- Use `<think>` tags for reasoning (will be filtered from display)
- Don't ask permission - Ripley CLI handles confirmations

## Development

### Adding a New Command
1. Add case in the main `switch` statement in `ripley.js` (~line 500)
2. Update `/help` output in `showHelp()`
3. Update README.md

### Modifying AI Behavior
Edit prompts in `C:\ai-router\prompts\` (main server only, not in this repo).

### Testing
```bash
node ripley.js
```

Run in any project directory. Test with `/plan` mode first to preview changes safely.

### Server Restart
After editing prompts on the main server, restart the AI Router:
```bash
# On main server (Matt's PC)
node C:\ai-router\server.js
```

## Dependencies

- `chalk` - Terminal colors and styling
- `diff` - File diffing and comparison
- `ignore` - .gitignore parsing
- `glob` - File pattern matching

## Git Info

- **Repo:** https://github.com/mrchevyceleb/ripley-code.git
- **Main branch:** main
- **Distribution:** Changes pushed here are used by other machines (pull required)
- **Windows:** Using PowerShell

## Important Notes

- After pushing changes, users on other machines need to re-pull from GitHub
- After editing prompts on main server, restart the AI Router
- Each project creates a `.ripley/` config directory locally
- Version number in `ripley.js` should be updated with significant changes
- my gpu is a 4090
- the AI router is located at "C:\ai-router"