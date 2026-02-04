-- Organization-scoped MCP servers configuration

CREATE TABLE IF NOT EXISTS "ai_mcp_server" (
    "mcpServerId" text PRIMARY KEY NOT NULL,
    "organizationId" text NOT NULL,
    "name" text NOT NULL,
    "serverUrl" text NOT NULL,
    "headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "isEnabled" boolean DEFAULT true NOT NULL,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "ai_mcp_server" ADD CONSTRAINT "ai_mcp_server_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ai_mcp_server_org_idx" ON "ai_mcp_server" ("organizationId");

