# Ripley Code - Local Model Research Reference

Compiled March 3, 2026. All findings specific to running these models through LM Studio's OpenAI-compatible API on RTX 4090 (24GB VRAM).

---

## GPT-OSS 20B (openai/gpt-oss-20b)

### Architecture
- MoE Transformer, 20.9B total / 3.6B active params (Top-4 of 32 experts)
- Native context: **131,072 tokens (128K)** - NOT 32K
- Tokenizer: o200k_harmony (BPE)
- Checkpoint: 12.8 GiB, fits in 16GB VRAM with MXFP4 quant
- Text-only. No vision.

### Tool Calling
- Trained on **Harmony protocol** exclusively (special tokens: `<|start|>`, `<|end|>`, `<|channel|>`, `<|call|>`, etc.)
- LM Studio translates Harmony to/from standard OpenAI tool_calls format transparently
- Returns `finish_reason: "tool_calls"` when calling tools
- Function definitions internally use TypeScript namespace syntax (handled by LM Studio)

### Critical: Reasoning Field Preservation
- GPT-OSS uses three output channels: `analysis` (private CoT), `commentary` (action planning), `final` (user-facing)
- The `reasoning` field in API responses contains the analysis channel content
- **MUST preserve and replay the `reasoning` field from prior assistant messages in multi-turn tool calling**
- Without this, performance degrades significantly over multiple tool-call turns
- Field name: `reasoning` in LM Studio/Ollama/OpenRouter, `reasoning_content` in llama.cpp

### Inference Settings
- **Temperature: 1.0, top_p: 1.0** (counterintuitive but recommended by OpenAI for reasoning models)
- Set `Reasoning: high` in system message for tool-use tasks
- Set `tool_choice: "auto"` or `"required"` explicitly
- Do NOT use `response_format: json_object` (breaks the model completely)

### Known Issues
- LM Studio v0.3.30 Build 1 broke tool calling. Workaround: `JSON.stringify()` tool return values (return strings, not objects)
- Large JSON payloads in tool calls can cause parser failures
- Inference engine sometimes doesn't stop at `<|call|>` token
- Weak on hallucination (SimpleQA: 0.067). Will confidently fabricate things.
- Control tokens leak through: `<|start|>`, `<|channel|>`, `<|constrain|>` (already stripped in Ripley)

### System Prompt Best Practices
- High-level objectives only. Don't micromanage reasoning steps.
- To suppress verbose reasoning: "Do not respond with your thinking nor reasoning process"
- Instruction hierarchy is weaker than commercial models (system vs user conflicts)

---

## Qwen3 Coder 30B (qwen/qwen3-coder-30b)

### Architecture
- MoE, 30B total / ~3B active params
- 128K context window
- Designed specifically for agentic coding (NO thinking mode by design)

### Tool Calling
- Uses **Hermes-style XML format** natively:
  ```xml
  <tool_call>
  {"name": "function_name", "arguments": {"key": "value"}}
  </tool_call>
  ```
- LM Studio Jinja template translates to/from OpenAI format automatically
- Returns tool_calls in the response with varying finish_reason

### Inference Settings
- **Temperature: 0.7, top_p: 0.8** for coding tasks
- Q5+ quantization required for reliable tool calling
- Set adequate max_tokens (at least 4096) to prevent truncated tool calls

### Best Practices
- Benefits from explicit `<IMPORTANT>` blocks in system prompt to reinforce critical rules
- Has NO thinking mode. Don't enable thinking for this model.
- Known LM Studio bug with streaming tool calls (fixed in 0.3.30+)

---

## Qwen3.5 35B A3B (qwen/qwen3.5-35b-a3b)

### Architecture
- MoE hybrid architecture, 35B total / ~3B active
- 256K context window
- Thinks by default (can be disabled)

### Tool Calling
- Same Hermes-style XML format as Qwen3 Coder
- LM Studio handles translation

### Inference Settings
- **Temperature: 1.0, top_p: 0.95** when thinking is enabled
- **Temperature: 0.7, top_p: 0.8** when thinking is disabled
- Better for single-shot complex tasks than multi-iteration agentic work

### Thinking
- Uses `<think>` / `</think>` tags (enabled by default)
- Can be disabled via API: `enable_thinking: false`
- Disable thinking for fast tool-calling loops, enable for complex reasoning

---

## Nemotron 3 Nano 30B (nvidia/nemotron-3-nano)

### Architecture
- **Hybrid Mamba-2 + Transformer MoE** (NOT pure Mamba)
- 30B total / 3.5B active params (128 routed experts per MoE layer, 6 active)
- 52 layers: 23 Mamba-2 + 23 MoE + 6 GQA
- Up to **1M token context** (default 256K, expandable)
- 4x higher throughput than pure transformers (Mamba advantage)

### Tool Calling
- Uses **Qwen3-Coder XML format** (same parser: `qwen3_coder`):
  ```xml
  <tool_call>
  <function=function_name>
  <parameter=key>value</parameter>
  </function>
  </tool_call>
  ```
- **LM Studio has a Jinja template bug** for tools: "Cannot apply filter 'string' to NullValue"
- Workaround: Use `lmstudio-community` model versions with corrected templates
- Works better via llama.cpp server or vLLM than LM Studio for tool calling

### Inference Settings
- **Temperature: 0.6, top_p: 0.95** for tool calling
- **Temperature: 1.0, top_p: 1.0** for reasoning mode

### Thinking
- Uses `<think>` / `</think>` tags (token IDs 12 and 13)
- Controlled via `enable_thinking` parameter
- Reasoning + tool calling may be incompatible in parallel mode
- Disable thinking when doing tool calls for reliability

### Known Issues
- Heavily trained on Claude Code examples, sometimes hallucinates tools like `str_replace_editor`
- LM Studio template rendering bug blocks tool calls entirely (GitHub #1443)
- Parallel reasoning mode incompatible with tool calling

---

## GLM 4.7 Flash (zai-org/glm-4.7-flash)

### Architecture
- MoE with Multi-Head Latent Attention (MLA), pure Transformer
- ~30B total / ~3B active params
- Up to **200K token context**, 128K output tokens
- MLA compresses KV cache by up to 93% (very memory efficient)

### Tool Calling
- Uses **JSON-in-XML-tags format**:
  ```xml
  <tool_call>
  {"name": "function_name", "arguments": {"key": "value"}}
  </tool_call>
  ```
- Tool definitions provided in `<tools>` tags in system prompt
- Tool responses use `<|observation|>` role token and `<tool_response>` tags
- Parser: `glm47`

### Inference Settings
- **Temperature: 0.7, top_p: 1.0, min_p: 0.01** for tool calling
- **MUST disable repeat penalty** (set to 1.0). Default repeat penalty kills output quality.
- min_p must be set to 0.01 (default 0.05 is too high)

### Thinking
- Three modes: Interleaved (default), Preserved, Turn-level
- Uses `<think>` tags, reasoning appears in `reasoning_content` field
- When using thinking + tool calling, preserve `reasoning_content` blocks exactly across turns

### Known Issues
- **Scoring function bug (fixed Jan 21, 2026)**: Old GGUFs had wrong `scoring_func: softmax` instead of `sigmoid`. Must use updated GGUFs.
- LM Studio's bundled llama.cpp may not have all GLM-4.7 fixes
- Works significantly better via llama.cpp directly than LM Studio
- Default repeat penalty and min_p settings cause bad outputs
- Chat template: `[gMASK]<sop><|system|>...<|user|>...<|assistant|>`

---

## Quick Reference: Tier Assignment

| Tier | Model | Use Case | Tool Reliability |
|------|-------|----------|-----------------|
| Max | Qwen3 Coder Next 80B | Deep coding, complex refactors | High (if enough VRAM) |
| Coding | Qwen3 Coder 30B | Primary coding agent | High |
| Fast | GPT-OSS 20B | Quick tool calls, agentic tasks | High (with reasoning preservation) |
| General | Qwen3.5 35B | Chat, reasoning, single-shot | Medium for multi-turn |
| Speed | GLM 4.7 Flash | Quick queries, low VRAM | Medium (needs correct settings) |
| Legacy | Nemotron 3 Nano | Fast inference | Low in LM Studio (template bug) |
