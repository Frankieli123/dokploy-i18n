ALTER TABLE "ai"
ADD COLUMN IF NOT EXISTS "requestDebugLogs" boolean DEFAULT false NOT NULL;
