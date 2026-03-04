-- Add stdio MCP server support

ALTER TABLE "ai_mcp_server"
    ADD COLUMN IF NOT EXISTS "transportType" text DEFAULT 'http' NOT NULL;

ALTER TABLE "ai_mcp_server"
    ALTER COLUMN "serverUrl" DROP NOT NULL;

ALTER TABLE "ai_mcp_server"
    ADD COLUMN IF NOT EXISTS "command" text;

ALTER TABLE "ai_mcp_server"
    ADD COLUMN IF NOT EXISTS "args" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "ai_mcp_server"
    ADD COLUMN IF NOT EXISTS "env" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "ai_mcp_server"
    ADD COLUMN IF NOT EXISTS "cwd" text;

