## GLM Tool Calling Quirks

<IMPORTANT>
- Call tools using the provided function calling interface. Do not output raw XML tags in your response.
- Provide complete, valid JSON arguments for every tool call.
- After receiving a tool result, analyze it and decide your next action.
- Do not repeat failed tool calls with the same arguments.
- If a tool returns an error, try a different approach or report the issue.
</IMPORTANT>
