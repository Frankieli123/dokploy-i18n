-- Agent playbook memory (pgvector)

CREATE EXTENSION IF NOT EXISTS vector;

-- Optional embedding model for memory retrieval
ALTER TABLE "ai" ADD COLUMN IF NOT EXISTS "embeddingModel" text;

CREATE TABLE IF NOT EXISTS "ai_agent_playbook" (
    "playbookId" text PRIMARY KEY NOT NULL,
    "organizationId" text NOT NULL,
    "signature" text NOT NULL,
    "intent" text NOT NULL,
    "summary" text,
    "tags" jsonb,
    "steps" jsonb NOT NULL,
    "successCount" integer DEFAULT 0 NOT NULL,
    "failCount" integer DEFAULT 0 NOT NULL,
    "lastUsedAt" text,
    "expiresAt" text NOT NULL,
    "hashVector" vector(256) NOT NULL,
    "embeddingModel" text,
    "embeddingDim" integer,
    "embeddingVector" vector,
    "createdAt" text NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "ai_agent_playbook" ADD CONSTRAINT "ai_agent_playbook_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_playbook_org_signature_uidx" ON "ai_agent_playbook" ("organizationId","signature");
CREATE INDEX IF NOT EXISTS "ai_agent_playbook_org_expires_idx" ON "ai_agent_playbook" ("organizationId","expiresAt");
CREATE INDEX IF NOT EXISTS "ai_agent_playbook_org_lastUsed_idx" ON "ai_agent_playbook" ("organizationId","lastUsedAt");
CREATE INDEX IF NOT EXISTS "ai_agent_playbook_org_embedding_idx" ON "ai_agent_playbook" ("organizationId","embeddingModel","embeddingDim");
