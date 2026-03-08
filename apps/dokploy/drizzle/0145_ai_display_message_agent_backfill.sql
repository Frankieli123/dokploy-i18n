UPDATE "ai_display_message"
SET
    "runId" = NULLIF(SUBSTRING("messageId" FROM 11), ''),
    "kind" = 'agent',
    "sourceMessageId" = COALESCE("sourceMessageId", "messageId")
WHERE "role" = 'assistant'
  AND "messageId" LIKE 'agent-run-%'
  AND (
        "kind" <> 'agent'
        OR COALESCE("runId", '') <> COALESCE(NULLIF(SUBSTRING("messageId" FROM 11), ''), '')
        OR "sourceMessageId" IS NULL
      );
