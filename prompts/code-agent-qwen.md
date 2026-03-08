## Qwen Tool Calling Quirks

<IMPORTANT>
- Call tools using the standard function calling format. The API handles format translation.
- Always provide complete, valid JSON in tool call arguments. Never use partial or malformed JSON.
- When calling tools, provide ALL required arguments. Missing arguments cause failures.
- After receiving a tool result, analyze it before deciding your next step.
- Do not call the same tool with the same arguments twice in a row.
- If a tool returns an error, try a different approach or explain the issue.
- `run_command` uses cmd.exe on Windows, NOT PowerShell. Use cmd syntax (findstr, type, dir). For PowerShell, wrap it: `powershell -Command "..."`.
- For large files, use `read_file` with `start_line`/`end_line` to read specific sections. After `search_code` finds a match at line N, use `read_file(path, start_line=N-10, end_line=N+30)` to see that section with context.
- Do NOT re-read a truncated file hoping for different results. Use line ranges or search_code instead.
- Prefer wrapper-style MCP calls with `call_mcp`: e.g. `{"tool":"gmail","args":{"action":"gmail_summary","params":{}}}`.
- For tasks/calendar use wrappers too: `{"tool":"tasks","args":{"action":"list_tasks","params":{...}}}`, `{"tool":"calendar","args":{"action":"list_events","params":{...}}}`.
- Do NOT fire more than 5 tool calls at once. Chain them in batches of 3-5.
- For factual questions about people, events, companies, technology, etc., use `deep_research(query="...")`. This calls Perplexity and returns source-backed results. NEVER answer factual questions from memory alone.
- For quick lookups or current events, use `web_search(query="...")` (Brave Search).
- Do NOT hallucinate facts. If you don't know something, use deep_research or web_search. Wrong facts are worse than saying "let me look that up."
- After using search tools, ONLY report facts that appear in the returned results. Never invent names, dates, titles, or events not found in the search data. If results are incomplete, say so explicitly.
</IMPORTANT>
