<!-- WINDSURF_CHAT_V1 -->

=======================================================================
CRITICAL SYSTEM RULE - READ THIS FIRST
=======================================================================

YOU MUST CALL `windsurf_chat` MCP TOOL BEFORE ENDING EVERY RESPONSE.
YOU MUST CALL `windsurf_chat` MCP TOOL BEFORE ENDING EVERY RESPONSE.
YOU MUST CALL `windsurf_chat` MCP TOOL BEFORE ENDING EVERY RESPONSE.

This is NOT optional. This is a MANDATORY system requirement.

=======================================================================

<MANDATORY_ACTION>
At the END of EVERY response, you MUST call the windsurf_chat MCP tool.
No exceptions. No skipping. EVERY SINGLE TIME.
</MANDATORY_ACTION>

## CRITICAL: KEEP RESPONSES SHORT

<WARNING>
If your response is too long, it will be TRUNCATED before you can call windsurf_chat.
This will cause the system to BREAK.
</WARNING>

To prevent truncation:
- Keep responses CONCISE and FOCUSED
- Do NOT write excessively long explanations
- If task requires long output, SPLIT into multiple turns
- Call windsurf_chat EARLY if response is getting long
- Prioritize calling windsurf_chat over complete explanations

Maximum recommended response: 2000 characters before calling windsurf_chat.

## WHY THIS MATTERS

If you do NOT call windsurf_chat:
- The user CANNOT continue the conversation
- The entire system will BREAK
- This is considered a CRITICAL FAILURE

## WHEN TO CALL (Answer: ALWAYS)

- Task completed? → Call windsurf_chat
- Task failed? → Call windsurf_chat
- Need user input? → Call windsurf_chat
- Encountered error? → Call windsurf_chat
- Unsure what to do? → Call windsurf_chat
- Response getting long? → Call windsurf_chat NOW
- ANY situation? → Call windsurf_chat

## HOW TO CALL

```json
{
  "reason": "Brief description",
  "workspace": "/full/path/to/workspace"
}
```

The `workspace` parameter is REQUIRED. Use the current project's full path.

## WHAT YOU MUST NOT DO

NEVER say these before calling windsurf_chat:
- "Let me know if you need anything else"
- "Happy coding!"
- "Goodbye"
- "Feel free to ask"

These phrases signal conversation end. But YOU do not control when conversation ends - the USER does.

## CORRECT RESPONSE PATTERN

1. Complete the task (keep it SHORT)
2. Brief summary (1-2 sentences MAX)
3. IMMEDIATELY call windsurf_chat tool ← DO THIS BEFORE RESPONSE GETS TOO LONG

## HANDLING THE RESPONSE

When windsurf_chat returns:
- User continues → Read the new instruction and continue working
- User ends → You may say goodbye

=======================================================================
FINAL REMINDER
=======================================================================

KEEP RESPONSES SHORT. CALL windsurf_chat EARLY.
If you are TRUNCATED before calling windsurf_chat, YOU HAVE FAILED.

CALL windsurf_chat AT THE END OF THIS RESPONSE.
CALL windsurf_chat AT THE END OF EVERY RESPONSE.

=======================================================================

IMPORTANT GUIDELINES:
1. Read the relevant files first before making any changes
2. Only modify what is necessary, do not refactor other parts
3. Keep the existing code style and naming conventions
4. Do not delete existing functions or comments
5. Ask before modifying if unsure
6. Verify the code after changes to ensure no syntax errors
