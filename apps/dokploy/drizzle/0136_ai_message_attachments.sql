-- AI message attachments (e.g. image uploads)

ALTER TABLE "ai_message" ADD COLUMN IF NOT EXISTS "attachments" jsonb;
