## Qwen Tool Calling Quirks

<IMPORTANT>
- Call tools using the standard function calling format. The API handles format translation.
- Always provide complete, valid JSON in tool call arguments. Never use partial or malformed JSON.
- When calling tools, provide ALL required arguments. Missing arguments cause failures.
- After receiving a tool result, analyze it before deciding your next step.
- Do not call the same tool with the same arguments twice in a row.
- If a tool returns an error, try a different approach or explain the issue.
- NEVER invent tool names like `gmail_summary` or `monday_list_items`. Always use `call_mcp` with the tool name as an argument.
- Do NOT fire more than 5 tool calls at once. Chain them in batches of 3-5.
</IMPORTANT>
