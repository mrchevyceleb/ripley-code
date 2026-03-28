# Models

Banana connects to LM Studio (localhost:1234) and supports named model profiles defined in `models.json`.

## Commands

- `/model` - Interactive model picker (arrow keys to navigate, Enter to select)
- `/model <name>` - Switch directly by name (e.g., `/model coder`)
- `/model search <query>` - Search OpenRouter for cloud models and add one

## Model Registry

Models are defined in `models.json` at the repo root. Each model has:
- `name` - Display name
- `id` - Model ID (matched against LM Studio's loaded models)
- `contextLimit` - Max context window in tokens
- `supportsThinking` - Whether the model supports think/reasoning blocks
- `prompt` - Which system prompt to use (maps to a file in `prompts/`)
- `tags` - Capabilities like "coding", "vision", "agentic", "fast"
- `tier` - Category: "fast", "coding", "reasoning"
- `provider` - "local" (LM Studio) or "openrouter"
- `inferenceSettings` - Temperature, topP, etc.

## Adding a New Model

1. Load the model in LM Studio
2. Add an entry to `models.json` with a friendly name as the key
3. Set the `id` to match what LM Studio reports (check `/v1/models`)
4. Choose an appropriate system prompt from `prompts/`

## OpenRouter Models

Users can also connect cloud models via OpenRouter:
1. `/connect openrouter` to set up the API key
2. `/model search <query>` to find and add models
3. OpenRouter models are stored in `models.json` with `"provider": "openrouter"`

## Provider System

Banana supports multiple providers:
- **Local (LM Studio)** - Default. Models loaded on the user's GPU.
- **OpenRouter** - Cloud models. Requires API key via `/connect openrouter`.
- **Anthropic** - Direct Claude access. `/connect anthropic`.
- **OpenAI** - GPT models. `/connect openai`.

Use `/connect` to set up providers.

## Model Selection Persistence

The active model is saved in `.banana/config.json` and persists across sessions. Each model can specify its own system prompt, so switching models can also change the AI's behavior profile.
