# Banana Code: Fork-from-opencode Plan

> The current `banana-cli` repo is a single-file Node CLI that's getting hard to extend. This plan forks `anomalyco/opencode` (TypeScript + Bun, 153k stars, MIT) and rebuilds Banana Code as a branded fork on top of it. The goal is a fork that **does not feel like an opencode fork** — it feels like Banana Code, powered by Monkey Models, with playful banana energy.

---

## Source of truth

- **Upstream:** `https://github.com/anomalyco/opencode` (default branch: `dev`)
- **License:** MIT (✅ free to fork and rebrand)
- **Runtime:** Bun (not Node — opencode is Bun-native)
- **Architecture:** TypeScript monorepo (Turbo), Effect-TS heavy, Vercel AI SDK for providers
- **Monkey Models endpoint:** `https://monkey-models-production.up.railway.app/v1` (OpenAI-compatible)
- **Tiers (current — only 3, not 4):** Silverback, Mandrill, Tamarin
  - Tarsier exists but is `secret: true` — internal use only, not exposed in CLI

---

## Decisions before starting

| Question | Decision | Why |
|---|---|---|
| Fork target | `anomalyco/opencode` `dev` branch | It's the canonical upstream |
| Repo name | `banana-code` (new GitHub repo, not a GH fork) | Hard fork — disconnect from upstream UI so Banana doesn't read as "fork of opencode" |
| Track upstream? | Yes, as `upstream` remote, manual rebases | Want to absorb their improvements, not auto-merged |
| Runtime | Stay on Bun | Don't fight the codebase; Bun is fine |
| Effect-TS | Keep | Refactoring out of Effect would be a year of work |
| Existing `banana-cli` repo | Archive after parity reached | Old repo stays as install fallback during cutover |
| npm package name | Keep `banana-code` | Already published, users have it installed |

---

## What banana keeps, what it deletes, what it inherits

### 🍌 Banana keeps (port from `banana-cli`)
- **Monkey Models tier system** — Silverback / Mandrill / Tamarin (now config, not code)
- **Brand:** banana puns, yellow theme, monkey/banana copy, splash, ASCII art
- **`BANANA.md` project instructions file** (replaces opencode's `AGENTS.md`)
- **Custom prompts** in `prompts/` (port to opencode's agent system)
- **Easter eggs / playful UX** (banana puns in spinners, errors, splash)

### 🗑️ Delete from `banana-cli`
- `lib/agenticRunner.js` — opencode's tool system is better
- `lib/mcpClient.js` — opencode has native MCP
- `lib/lmStudio.js` — opencode supports OpenAI-compatible providers natively
- `lib/streamHandler.js` — Vercel AI SDK handles this
- `lib/visionAnalyzer.js` — Monkey Models server proxies vision (already does)
- `lib/oauthOpenAI.js`, `lib/providerClients.js`, `lib/providerStore.js`, `lib/providerManager.js` — opencode handles
- `lib/markdownRenderer.js`, `lib/diffViewer.js`, `lib/borderRenderer.js`, `lib/statusBar.js`, `lib/interactivePicker.js` — opencode TUI replaces
- `lib/historyManager.js`, `lib/tokenCounter.js`, `lib/contextBuilder.js` — opencode session system replaces
- `lib/hookManager.js`, `lib/watcher.js`, `lib/fileManager.js`, `lib/fsUtils.js`, `lib/parser.js`, `lib/completer.js`, `lib/inlineComplete.js` — all replaced
- `banana.js` (the 2000-line monolith) — replaced by opencode CLI entry

### 🎁 Inherit from opencode
- Real TUI (Bubble Tea-style)
- Build/Plan agents with Tab-switch
- LSP integration
- Tool system: read, write, edit, grep, glob, shell, webfetch, websearch, task, todo, plan, lsp, skill, mcp
- Plugin system with typed hooks
- MCP support
- Snapshot / sync / share
- VS Code extension SDK
- Provider abstraction (Vercel AI SDK)
- Server mode (remote operation)
- Sub-agents (`@general` syntax)

---

## Phase 0 — Pre-flight (before tomorrow)

These are the only manual decisions. Everything else is mechanical.

- [ ] Create new GitHub repo: `mrchevyceleb/banana-code` (empty, no README — Phase 1 fills it)
- [ ] Decide on workspace location. Suggested: `C:\banana-code` (NOT `C:\banana-cli` — keep old repo around as reference)
- [ ] Confirm npm package name strategy:
  - Option A: `banana-code` keeps publishing from new repo. Bump major to v2.0.0. Old `banana-cli` codebase becomes reference-only.
  - Option B: Publish new fork as `@banana/code` scoped, leave `banana-code` v1.x as legacy.
  - **Recommended: A** — clean cutover, users get auto-upgrade prompt.

---

## Phase 1 — Bootstrap the fork (~1 hour)

Goal: a clone of opencode renamed to banana-code that builds and runs.

### 1.1 Clone with full history (so we can rebase from upstream later)

```bash
cd C:\
git clone https://github.com/anomalyco/opencode.git banana-code
cd banana-code
git remote rename origin upstream
git remote add origin https://github.com/mrchevyceleb/banana-code.git
git checkout -b main upstream/dev
```

### 1.2 Verify it builds

```bash
bun install
cd packages/opencode
bun run typecheck
bun run dev   # should start the TUI
```

If this fails on Windows, `cd C:\banana-code\packages\opencode` and read `BUN_SHELL_MIGRATION_PLAN.md` and `AGENTS.md` first. Don't proceed until it runs.

### 1.3 First commit

```bash
git add -A
git commit -m "chore: initial fork from anomalyco/opencode dev @ <SHA>"
git push -u origin main
```

---

## Phase 2 — De-opencode the brand (~3 hours)

This is the most important phase. The goal is that no user-visible string says "opencode" anywhere, and the fork doesn't read as derivative. Internal package names can stay (no need to rename `@opencode-ai/core` everywhere — that's invisible).

### 2.1 Rename the binary

`packages/opencode/bin/opencode` → `packages/opencode/bin/banana`

`packages/opencode/package.json`:
```json
"bin": { "banana": "./bin/banana" }
```

Top-level `package.json` and `install` script: replace install commands.

### 2.2 Config directory rename

Search for `~/.config/opencode`, `~/.local/share/opencode`, `OPENCODE_INSTALL_DIR`, `OPENCODE_*` env vars. Replace with `~/.config/banana`, `BANANA_*`.

Files to check (grep `opencode` in `packages/opencode/src`):
- `src/installation/*` — install paths
- `src/config/paths.ts` — XDG paths
- `src/env/*` — env var loading
- `packages/core/src/global.ts` — global config dir

**Compatibility shim:** read `~/.config/banana/` first, fall back to `~/.config/opencode/` for one release so existing opencode users who switch don't lose state. Then drop the shim.

### 2.3 Rename `AGENTS.md` → `BANANA.md`

`AGENTS.md` is a magic filename in opencode (auto-loaded into agent context). Banana's equivalent is `BANANA.md`.

- Find loader in `packages/opencode/src/agent/agent.ts` and config code
- Change resolution order: `BANANA.md` → `AGENTS.md` (fallback) → `CLAUDE.md` (legacy fallback)
- Update docs and scaffolding templates

### 2.4 Strip opencode user-facing copy

Replace in user-visible strings (NOT in internal type names or imports):

| opencode says | banana says |
|---|---|
| "opencode" | "Banana Code" |
| "OpenCode Zen" (their hosted service) | DELETE — banana uses Monkey Models |
| "anomalyco" / "SST" branding | "Banana Code by Matt Johnston" |
| "build" agent | keep name `build` (it's a sensible default) but tagline can be playful |
| "plan" agent | keep name `plan` |
| Welcome / splash screen | Replace with banana ASCII + monkey emoji |
| Default error messages | Banana-flavored where natural ("🍌 The banana slipped...") |

**Where to grep:**
```
packages/opencode/src/cli/        # CLI entry, splash, help
packages/opencode/src/tui/         # if exists, otherwise packages/ui or packages/console
packages/console/                  # TUI strings
packages/web/                      # if shipping web (probably skip for v1)
```

### 2.5 Strip / hide unused features for v1

Keep the codebase but hide from CLI / docs to reduce surface area:
- Desktop app (`packages/desktop`, `packages/desktop-electron`) — leave on disk, don't ship
- VS Code SDK (`sdks/vscode`) — same
- Web (`packages/web`) — same
- Slack integration (`packages/slack`) — same
- Enterprise (`packages/enterprise`) — same
- Share / sync (`packages/opencode/src/share`, `src/sync`) — disable in config defaults

These aren't deleted (we may want them later) — just not built or advertised.

### 2.6 README, install script, and docs

- New `README.md` — banana-flavored, monkey emoji, "powered by Monkey Models", install instructions
- New `install` script — `curl -fsSL get.banana.code/install | bash` (set up later) or just `npm i -g banana-code`
- Localized README files (`README.es.md`, `README.fr.md`, etc.) — DELETE all 30+. Banana doesn't need i18n yet.
- Add new `BANANA.md` at the root for our own self-hosting

### 2.7 Theme the TUI yellow/green/banana

Find theme files (likely `packages/ui` or `packages/console/src/theme/`). Define a `banana` theme:
- Primary: banana yellow (`#FFE135`)
- Accent: jungle green (`#3FA34D`)
- Spinner: yellow with banana-pun phrases ("Peeling layers...", "Going bananas...", "Monkey see, monkey code...", "Ripening...")
- Error: warm orange, never red-screaming
- Cursor: banana shape if possible, else yellow

Set as default theme. Old themes stay available via config.

### 2.8 Easter eggs (per CLAUDE.md global rules)

Required playful elements:
- Splash screen on `banana` startup — random banana ASCII art (3-4 variants)
- Spinner messages rotate through banana puns (~15 phrases)
- `banana --version` prints with a 🍌
- `/joke` slash command — random banana/monkey one-liner
- `/banana` slash command — easter egg, prints big ASCII banana
- Konami-style sequence in TUI → triggers brief animation (low priority)

### 2.9 Commit checkpoint

```bash
git checkout -b feat/banana-rebrand
git add -A
git commit -m "feat: rebrand opencode shell as Banana Code"
git push -u origin feat/banana-rebrand
```

PR into `main`. This is the "fork no longer feels like opencode" milestone.

---

## Phase 3 — Wire Monkey Models as a first-class provider (~2 hours)

Goal: `banana` ships with Silverback / Mandrill / Tamarin in the model picker out of the box, no config needed.

### 3.1 Strategy: ship Monkey as a built-in OpenAI-compatible provider

opencode discovers providers via the AI SDK + `models.dev` registry + user config. We bake Monkey into the default config.

### 3.2 Default config additions

In the default config that ships with banana (likely `packages/opencode/src/config/defaults.ts` or similar — grep for the config schema in `src/config/config.ts`):

```ts
provider: {
  monkey: {
    npm: "@ai-sdk/openai-compatible",
    name: "Monkey Models",
    options: {
      baseURL: "https://monkey-models-production.up.railway.app/v1",
      apiKey: "{env:BANANA_MONKEY_TOKEN}",
    },
    models: {
      silverback: {
        name: "Silverback 🦍",
        attachment: true,        // native vision via Kimi K2.6
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        release_date: "2025-01-01",
        temperature: true,
      },
      mandrill: {
        name: "Mandrill 🐒",
        attachment: true,        // server proxies via Gemini Flash
        reasoning: true,
        tool_call: true,
        limit: { context: 262000, output: 100000 },
        release_date: "2025-01-01",
        temperature: true,
      },
      tamarin: {
        name: "Tamarin 🐵",
        attachment: true,        // server proxies via Gemini Flash
        reasoning: false,
        tool_call: true,
        limit: { context: 256000, output: 4096 },
        release_date: "2025-01-01",
        temperature: true,
      },
    },
  },
}
```

### 3.3 Default token

Bundle the public `AUTH_TOKEN` from monkey-models so banana works on first install with zero setup. Same approach `banana-cli` uses today.

```
BANANA_MONKEY_TOKEN_DEFAULT = "086399eca157e4ad2fc0fecfb254da1118d226ac53371757267388b23bd10fa6"
```

(This is a public token already in the existing CLI. Keeping the install-and-go UX.)

Loader logic: `process.env.BANANA_MONKEY_TOKEN || BANANA_MONKEY_TOKEN_DEFAULT`.

### 3.4 Default model

Set Mandrill as the default selection (matches current banana-cli default — actually `models.json` says "default: silverback" but banana-cli docs say mandrill — **resolve this with Matt before tomorrow** if relevant).

In the default config:
```ts
model: "monkey/mandrill"
```

### 3.5 BYOK support

Forward `X-OpenRouter-Key` header if user configures it. opencode's openai-compatible adapter supports custom headers — wire it through.

### 3.6 Hide unused providers from default UI

Keep them registered (for power users), but the model picker should default to showing Monkey models first. Find the model picker (TUI) and add a "favorites" or "primary" pinning.

### 3.7 Commit

```bash
git checkout -b feat/monkey-provider
# ...edits...
git commit -m "feat: ship Monkey Models as default provider with 3 tiers"
git push
```

---

## Phase 4 — Port banana's prompts (~1 hour)

Goal: banana's `prompts/code-agent.md`, `prompts/plan.md`, etc. become first-class agents in opencode.

### 4.1 Map prompt files to agents

| `banana-cli/prompts/X.md` | opencode agent |
|---|---|
| `base.md` | merged into default `build` agent |
| `code-agent.md` | becomes `build` agent system prompt (replaces opencode's default) |
| `plan.md` | becomes `plan` agent system prompt |
| `code-agent-qwen.md` | custom agent: `build-qwen` |
| `code-agent-glm.md` | custom agent: `build-glm` |
| `code-agent-gptoss.md` | custom agent: `build-gptoss` |
| `code-agent-nemotron.md` | custom agent: `build-nemotron` |

opencode agent files live at `packages/opencode/src/agent/prompt/*.txt`. Built-in agents are configured in code.

### 4.2 Read opencode's existing agent prompts first

Before overwriting, read:
- `packages/opencode/src/agent/prompt/explore.txt`
- `packages/opencode/src/agent/prompt/summary.txt`
- `packages/opencode/src/agent/prompt/title.txt`
- `packages/opencode/src/agent/prompt/compaction.txt`
- `packages/opencode/src/agent/agent.ts` (orchestration)

Banana's prompts are tuned for a different tool surface (banana's old XML format vs. opencode's tool-call format). They will need rewriting to match opencode's tool conventions, not just copy-pasted.

### 4.3 Write banana-flavored prompts

Banana's voice in agent prompts: direct, concise, no preamble, occasional banana metaphor when natural — NEVER forced. Per Matt's CLAUDE.md: "no em dashes, no emojis unless requested, bullets over prose."

### 4.4 Commit

```
feat: port banana's agent prompts; replace default opencode prompts
```

---

## Phase 5 — Port `BANANA.md` project instructions (~30 min)

This is mostly already covered in Phase 2.3. Verify:

- [ ] `BANANA.md` at project root is auto-loaded into agent context
- [ ] Fallback chain: `BANANA.md` → `AGENTS.md` → `CLAUDE.md` (read first one that exists)
- [ ] `/instructions` command (or whatever opencode calls it) shows current loaded file
- [ ] Banana's `scripts/createBananaDir.js` postinstall logic ports over (creates `~/.banana/` for logs, etc.)

---

## Phase 6 — Banana-flavored TUI polish (~3 hours)

This is where it stops feeling like opencode and starts feeling like banana code.

### 6.1 Splash / startup
- ASCII banana logo (3-4 variants, randomized)
- "Banana Code v2.0.0 — powered by Monkey Models 🐒"
- Tip of the day from a banana-themed list ("press Tab to switch agents, banana-style")

### 6.2 Slash commands (banana-only additions)
- `/monkey` — show current Monkey Models status, latency, balance (if available)
- `/peel` — `/help` alias, banana flavor
- `/ripen` — placeholder for "compact context" if opencode has one, otherwise alias to summary
- `/joke` — random banana/monkey one-liner
- `/banana` — easter egg (big banana ASCII)

### 6.3 Spinner copy

Replace generic "thinking..." spinner with rotating banana puns:
```
"Peeling layers..."
"Going bananas..."
"Monkey see, monkey code..."
"Climbing the tree..."
"Ripening..."
"Swinging through the codebase..."
"Sniffing for bugs..."
"Bunching files..."
"Going ape..."
"Picking the best banana..."
"Don't slip..."
"Just monkeying around..."
"Loading more potassium..."
"Vine to vine..."
"Splitting the banana..."
```

### 6.4 Error / status copy

Soften but don't sugarcoat. Examples:
- Network error: "🍌 Lost the signal swinging between trees. Retrying..."
- Auth fail: "🐒 Your Monkey Models token isn't ripe. Run `banana auth` to refresh."
- Tool call rejected: "🍌 That one's a slippery move. Try a different approach?"

### 6.5 Commit

```
feat: banana-flavored TUI polish (splash, spinner, slash commands, error copy)
```

---

## Phase 7 — Test matrix (~1 hour)

Before tagging v2.0.0:

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes from `packages/opencode/`
- [ ] Fresh install on clean Windows 11 box works
- [ ] Fresh install on macOS works
- [ ] `banana` starts, splash renders, model picker shows 3 Monkey tiers
- [ ] Silverback can do a simple coding task end-to-end (read, edit, run shell)
- [ ] Mandrill same
- [ ] Tamarin same
- [ ] Vision: paste an image, Silverback handles it natively, Mandrill goes through proxy
- [ ] `BANANA.md` auto-loads into context
- [ ] `/joke`, `/banana`, `/monkey` slash commands work
- [ ] LM Studio at `localhost:1234` works as a custom provider (config-only test)
- [ ] Anthropic / OpenAI direct (BYO key) works
- [ ] MCP server config works
- [ ] Migration path: existing `~/.banana/` settings honored

---

## Phase 8 — Release & cutover (~30 min)

### 8.1 npm publish
```bash
cd packages/opencode
# update version to 2.0.0 in package.json
bun publish --access public --tag latest
```

### 8.2 Old repo

In `C:\banana-cli`:
- Add deprecation notice to README pointing at new repo
- Final commit on `main`
- Archive on GitHub (Settings → Archive)

### 8.3 Doppler / Railway

No change. Monkey Models server is unchanged.

### 8.4 Announce

(out of scope for this plan — Matt's call)

---

## Upstream sync strategy (post-launch)

```bash
# every couple weeks
git fetch upstream
git checkout main
git merge upstream/dev
# resolve conflicts in:
#   - bin/banana (we renamed)
#   - config defaults (Monkey provider)
#   - TUI theme files
#   - splash / spinner copy
#   - prompts
# everything else should merge clean
```

The only files that consistently conflict will be the brand layer. If we keep brand changes localized to a few files (config defaults, theme, splash, copy), conflicts stay manageable.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Effect-TS learning curve slows us down | Don't refactor — only edit at the seams (config, theme, copy). Treat opencode internals as read-only. |
| Bun-only features break on Node | Banana installs Bun via the install script. Don't try to support Node-only environments in v1. |
| Upstream rebase pain | Keep brand changes in <10 files. Use config-driven theming where possible. |
| Monkey Models server downtime | Banana already supports remote provider fallback; ship Anthropic/OpenAI as second-tier defaults. |
| Users miss old `banana-cli` features | List them in v2 release notes, link to legacy repo install. |
| "Why is this opencode under the hood" criticism | We credit MIT origin in LICENSE + a small note in README. Beyond that, the brand is ours. Standard fork ethics. |
| Token leak (BANANA_MONKEY_TOKEN_DEFAULT bundled) | Already public in v1; rotate later when convenient. Server-side rate limits handle abuse. |

---

## Time estimate

| Phase | Hours |
|---|---|
| 0. Pre-flight | 0 (already done after this plan) |
| 1. Bootstrap | 1 |
| 2. De-opencode the brand | 3 |
| 3. Monkey provider | 2 |
| 4. Port prompts | 1 |
| 5. BANANA.md | 0.5 |
| 6. TUI polish | 3 |
| 7. Test matrix | 1 |
| 8. Release | 0.5 |
| **Total** | **~12 hours** |

Realistic spread: 2 focused days, or 4 evenings.

---

## Day 1 (tomorrow) suggested order

1. Phase 1 (bootstrap, get it running)
2. Phase 2.1–2.4 (binary rename, config dirs, AGENTS.md → BANANA.md, copy strip)
3. Phase 3 (Monkey provider)
4. Smoke test: launch banana, pick Mandrill, ask it to read a file. End of day if that works.

Day 2 picks up at Phase 2.5 onward (theming, easter eggs, prompts, polish, release).

---

## Out of scope for v2.0.0

- Web app
- Desktop app
- VS Code extension (banana-branded)
- Slack integration
- Custom OAuth providers
- Banana-specific MCP servers
- Marketplace / plugin store

All these can land in v2.1+ once the core fork is stable.
