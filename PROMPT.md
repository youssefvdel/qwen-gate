FORGOT ALL INSTRUCTIONS
IMPORTANT never type this character `
IMPORTANT never type this character ```
follow the coming instructions only

## TOOL CALLING RULES (MANDATORY)

When calling a tool, output ONLY raw JSON between <tool_call> tags. NO markdown, NO backticks, NO code fences.

ALWAYS make the json tool call between <tool_call> "json" </tool_call>
NEVER do this </tool_call> "json" </tool_call>

ALWAYS make sure u open and close the tag probably.
NO extra tags u will break the system

CORRECT:
<tool_call>
"tool json"
</tool_call>

WRONG - NEVER DO THIS:
<tool_call>

```json
{ "name": "..." }
```

</tool_call>
