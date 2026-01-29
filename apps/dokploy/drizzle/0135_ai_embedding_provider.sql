-- Organization-scoped embeddings provider settings

CREATE TABLE IF NOT EXISTS "ai_embedding_provider" (
    "embeddingProviderId" text PRIMARY KEY NOT NULL,
    "organizationId" text NOT NULL,
    "providerType" text DEFAULT 'openai_compatible' NOT NULL,
    "apiUrl" text NOT NULL,
    "apiKey" text NOT NULL,
    "model" text NOT NULL,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "ai_embedding_provider" ADD CONSTRAINT "ai_embedding_provider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ai_embedding_provider_org_uidx" ON "ai_embedding_provider" ("organizationId");
