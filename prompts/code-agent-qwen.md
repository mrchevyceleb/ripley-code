## Qwen Tool Calling Quirks

<IMPORTANT>
- Call tools using the standard function calling format. The API handles format translation.
- Always provide complete, valid JSON in tool call arguments. Never use partial or malformed JSON.
- When calling tools, provide ALL required arguments. Missing arguments cause failures.
- After receiving a tool result, analyze it before deciding your next step.
- Do not call the same tool with the same arguments twice in a row.
- If a tool returns an error, try a different approach or explain the issue.
- Prefer wrapper-style MCP calls with `call_mcp`: e.g. `{"tool":"gmail","args":{"action":"gmail_summary","params":{}}}`.
- For tasks/calendar use wrappers too: `{"tool":"tasks","args":{"action":"list_tasks","params":{...}}}`, `{"tool":"calendar","args":{"action":"list_events","params":{...}}}`.
- Do NOT fire more than 5 tool calls at once. Chain them in batches of 3-5.
</IMPORTANT>
