# Monkey Models - Banana Code Model Routing Server

## Overview

monkey-models is an OpenAI-compatible proxy server on Railway that powers all Banana Code products. It maps branded tier names to real OpenRouter models, injects per-tier system prompt personalities, and provides a Gemini Flash vision proxy so non-vision models can "see" images.

Users type `silverback` as the model name. The server resolves it to the actual model, injects the Silverback personality, handles vision, and forwards to OpenRouter. The user never knows what model is running underneath.

## Infrastructure

| Item | Value |
|------|-------|
| Railway project | monkey-models |
| Railway project ID | (see Doppler) |
| Railway service ID | (see Doppler) |
| Production URL | https://monkey-models-production.up.railway.app |
| Health check | https://monkey-models-production.up.railway.app/health |
| GitHub repo | (private) |
| Doppler config | monkey-models / prd |
| npm package | banana-code-setup |
| Auth token | (stored in Doppler as AUTH_TOKEN) |

## Environment Variables (Doppler: monkey-models / prd)

| Name | Purpose |
|------|---------|
| AUTH_TOKEN | Server auth token (64 hex chars) |
| OPENROUTER_API_KEY | System OpenRouter key for all tier requests |
| GOOGLE_API_KEY | Gemini Flash key for vision proxy |

## Model Tiers

| Tier | Display Name | Quality |
|------|-------------|---------|
| silverback | Silverback | Best |
| mandrill | Mandrill | Balanced |
| gibbon | Gibbon | Fast |
| tamarin | Tamarin | Budget |

Underlying model names are NEVER exposed to users. All UI, CLI output, and configs show only branded tier names. See Doppler/server source for model mappings.

You can also pass any raw OpenRouter model ID (e.g. `anthropic/claude-sonnet-4-6`) as a passthrough. It forwards without tier personality injection.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Health check, tier list, vision status |
| GET | /v1/tiers | Yes | Tier details with descriptions |
| GET | /v1/models | Yes | OpenAI-compatible model list |
| POST | /v1/chat/completions | Yes | Chat completions (streaming or not) |

Auth: Bearer token in Authorization header.

## How It Works

### Request Flow
1. User sends request with `model: "silverback"` to monkey-models
2. Server resolves tier -> actual OpenRouter model ID
3. Injects tier personality system prompt (prepended to existing system messages)
4. Appends personality reinforcement at END of system prompt (critical for third-party tools)
5. For all tier requests: routes any images to Gemini Flash, gets text description, injects as text
6. Forwards to OpenRouter with resolved model ID
7. Streams response back to user

### Vision Proxy
All 4 tiers report `hasVision: true` even though the underlying models lack native vision. The server handles it transparently:
1. Server scans ALL message roles (user, tool, assistant) for image blocks
2. Supports both OpenAI-style (`image_url`) and Anthropic-style (`source.data` base64) formats
3. Sends images to Gemini Flash (using GOOGLE_API_KEY)
4. Gemini describes the images in detail
5. Description is injected as text, replacing the image in the message
6. The coding model receives the text description, not the raw image

The user never knows two models are involved. It just works.

**Client-side requirement:** Third-party tools (Kilo Code, OpenCode, etc.) need `modalities: { input: ["text", "image"] }` in their model config to actually send images to the API. Without it, the client reads images locally and never sends them. The `banana-code-setup` CLI (v1.3.0+) includes this automatically.

### System Prompt Personalities
Each tier has a hidden system prompt personality injected before every request:

- **Silverback:** Chill supportive genius. Goes all out. Explains everything. Proactive. UX-obsessed. Playful "toy" design defaults. Signs off with next steps. MUST acknowledge user before starting work.
- **Mandrill:** Sharp and efficient. Balanced quality/speed. Clear updates. Acknowledges before working.
- **Gibbon:** Fast and nimble. Minimal words. Ship and iterate. Quick one-liner before working.
- **Tamarin:** Lightweight. Focused. Gets simple tasks done. Brief acknowledgment before working.

### Third-Party Tool Problem
Tools like OpenCode, Kilo Code, VS Code Copilot, Continue, and Cline inject their own massive system prompts. The model sees:
1. Banana Code personality (prepended)
2. Tool's own system prompt (middle, often huge)
3. Banana Code reinforcement (appended, reads last)

The reinforcement at the end helps but isn't bulletproof. Full personality control only happens in Banana Code's own apps (mobile IDE, terminal app, cloud coder) where we control the entire prompt.

## BYOK (Bring Your Own Key)
Users can use their own OpenRouter key instead of the system key by passing:
```
X-OpenRouter-Key: sk-or-v1-abc123...
```
The Authorization header is always the server auth token.

## Setup CLI (banana-code-setup)

Published on npm. Zero-config setup for any machine.

```bash
npx banana-code-setup           # auto-detect and configure all tools
npx banana-code-setup --uninstall  # remove from all tools
```

### What it auto-configures:
- **OpenCode** - writes to ~/.config/opencode/opencode.json + auth.json
- **Kilo Code** - writes to ~/.config/kilo/kilo.json + auth.json
- **VS Code Copilot** - writes github.copilot.chat.customOAIModels to VS Code settings.json
- **Continue** - writes to ~/.continue/config.json

### What it prints manual instructions for:
- **Cline** (VS Code extension, stores config internally)
- **Cursor** (stores settings internally)
- **aichat** (uses YAML config)

No flags needed. API key is baked in. Detected tools are configured automatically.

## cURL Test

```bash
curl https://monkey-models-production.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer $BANANA_MONKEY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "silverback",
    "messages": [{"role": "user", "content": "Say hello and your name"}],
    "stream": false
  }'
```

## Source Code Structure

```
monkey-models/
  src/
    index.ts      - Express server, auth, endpoints, OpenRouter forwarding
    tiers.ts      - Tier definitions, model ID resolution
    prompts.ts    - Per-tier system prompt personalities + reinforcement
    vision.ts     - Gemini Flash vision proxy
  cli/
    setup.mjs     - npx banana-code-setup CLI
    package.json  - npm package config
  nixpacks.toml   - Railway build config
  railway.json    - Railway deploy config (healthcheck, restart policy)
  SETUP.md        - Quick reference cheat sheet
```

## Deployment

Push to main on GitHub. Railway auto-deploys.

```bash
cd /path/to/monkey-models
git add -A && git commit -m "fix: whatever" && git push origin main
```

Railway watches the main branch and redeploys automatically.

## Why Not OpenRouter/Fireworks/Together?

Investigated registering monkey-models as a provider on OpenRouter. Won't work because:
- OpenRouter providers must host actual GPU inference
- monkey-models is a proxy that calls BACK into OpenRouter (circular)
- Same issue with Fireworks and Together

The scalable solution for third-party tool support is the npm CLI (banana-code-setup). For Banana Code's own apps (mobile IDE, terminal, cloud), they just point at the Railway URL directly.

## Role in Banana Code Ecosystem

monkey-models is the backbone API for all three Banana Code products:

1. **Cloud Coding App** (mobile-first, surgical one-shot edits) - uses Silverback
2. **Banana IDE** (VS Code-level coding sessions) - uses Mandrill (heavy) + Gibbon (autocomplete)
3. **Agentic/Background Tasks** (bulk operations) - uses Tamarin

All three products hit the same Railway endpoint. One server, all tiers, all products.
