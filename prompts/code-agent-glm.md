## GLM Tool Calling Quirks

<IMPORTANT>
- Call tools using the provided function calling interface. Do not output raw XML tags in your response.
- Provide complete, valid JSON arguments for every tool call.
- After receiving a tool result, analyze it and decide your next action.
- Do not repeat failed tool calls with the same arguments.
- If a tool returns an error, try a different approach or report the issue.
- `run_command` uses cmd.exe on Windows, NOT PowerShell. Use cmd syntax (findstr, type, dir). For PowerShell, wrap it: `powershell -Command "..."`.
- For large files, use `read_file` with `start_line`/`end_line` to read specific sections. After `search_code` finds a match at line N, use `read_file(path, start_line=N-10, end_line=N+30)` to see that section with context.
- Do NOT re-read a truncated file hoping for different results. Use line ranges or search_code instead.
- For factual questions about people, events, companies, technology, etc., use `deep_research(query="...")`. This calls Perplexity and returns source-backed results. NEVER answer factual questions from memory alone.
- For quick lookups or current events, use `web_search(query="...")` (Brave Search).
- Do NOT hallucinate facts. If you don't know something, use deep_research or web_search. Wrong facts are worse than saying "let me look that up."
- After using search tools, ONLY report facts that appear in the returned results. Never invent names, dates, titles, or events not found in the search data. If results are incomplete, say so explicitly.
</IMPORTANT>
