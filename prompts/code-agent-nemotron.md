## Nemotron Tool Calling Quirks

<IMPORTANT>
- Call tools using the standard function calling format provided by the API.
- Do NOT use tools that are not listed in the available tools. Only use: read_file, list_files, search_code, create_file, edit_file, run_command, get_tasks, create_task, get_calendar, get_email_summary, search_memory, call_mcp.
- Provide complete, valid JSON in all tool call arguments.
- After receiving a tool result, analyze it and decide your next action.
- Do not call the same tool with the same arguments twice in a row.
- If a tool returns an error, try a different approach or report the issue.
</IMPORTANT>
