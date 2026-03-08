# Sub-Agents

Sub-agents are independent AI sessions spawned from the main conversation. They run a specific task using a chosen model, then report back.

## Commands

- `/agent` - Interactive picker: choose model, enter task, launch
- `/agent <model> <task>` - Quick launch with a specific model and task

## How They Work

1. A sub-agent gets its own conversation context (not the main conversation)
2. It has access to all the same tools (read files, write files, search, run commands)
3. It runs until the task is complete or it hits the turn limit
4. Its output is injected back into the main conversation as context

## Use Cases

- **Parallel work**: Spawn an agent to handle a subtask while you continue
- **Different model strengths**: Use a reasoning model for architecture, a fast model for boilerplate
- **Isolated exploration**: Let an agent read and analyze code without polluting your main context

## Agent Models

Sub-agents can use any model from the model registry. Common pattern:
- Main conversation on a fast model for interactive work
- Sub-agent on a reasoning model for complex analysis

## Read-Only vs Read-Write

When spawning agents (especially via hooks), you can choose:
- **Read-only**: Agent can read files and search but cannot modify anything
- **Read-write**: Agent has full access to create/edit files and run commands
