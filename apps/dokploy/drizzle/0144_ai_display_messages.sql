-- Persist authoritative AI display snapshots

CREATE TABLE IF NOT EXISTS "ai_display_message" (
    "messageId" text PRIMARY KEY NOT NULL,
    "conversationId" text NOT NULL,
    "sourceMessageId" text,
    "runId" text,
    "role" "aiMessageRole" NOT NULL,
    "kind" text DEFAULT 'message' NOT NULL,
    "content" text,
    "reasoning" text,
    "attachments" jsonb,
    "toolCalls" jsonb,
    "status" text DEFAULT 'sent' NOT NULL,
    "error" text,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "ai_display_message" ADD CONSTRAINT "ai_display_message_conversationId_ai_conversation_conversationId_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."ai_conversation"("conversationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_display_message" ADD CONSTRAINT "ai_display_message_sourceMessageId_ai_message_messageId_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."ai_message"("messageId") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_display_message" ADD CONSTRAINT "ai_display_message_runId_ai_run_runId_fk" FOREIGN KEY ("runId") REFERENCES "public"."ai_run"("runId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ai_display_message_conversation_created_idx" ON "ai_display_message" ("conversationId", "createdAt", "messageId");
CREATE INDEX IF NOT EXISTS "ai_display_message_run_created_idx" ON "ai_display_message" ("runId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_display_message_source_idx" ON "ai_display_message" ("sourceMessageId");


INSERT INTO "ai_display_message" (
    "messageId",
    "conversationId",
    "sourceMessageId",
    "runId",
    "role",
    "kind",
    "content",
    "reasoning",
    "attachments",
    "toolCalls",
    "status",
    "error",
    "createdAt",
    "updatedAt"
)
SELECT
    m."messageId",
    m."conversationId",
    m."messageId" AS "sourceMessageId",
    NULL AS "runId",
    m."role",
    'message' AS "kind",
    m."content",
    NULL AS "reasoning",
    m."attachments",
    m."toolCalls",
    'sent' AS "status",
    NULL AS "error",
    m."createdAt",
    m."createdAt" AS "updatedAt"
FROM "ai_message" m
WHERE m."role" <> 'system'
ON CONFLICT ("messageId") DO NOTHING;
