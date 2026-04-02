ALTER TABLE "user"
ADD COLUMN IF NOT EXISTS "additionalHosts" jsonb DEFAULT '[]'::jsonb NOT NULL;
