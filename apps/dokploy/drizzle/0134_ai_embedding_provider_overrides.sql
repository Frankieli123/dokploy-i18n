-- Optional dedicated provider settings for embeddings

ALTER TABLE "ai" ADD COLUMN IF NOT EXISTS "embeddingProviderType" text;
ALTER TABLE "ai" ADD COLUMN IF NOT EXISTS "embeddingApiUrl" text;
ALTER TABLE "ai" ADD COLUMN IF NOT EXISTS "embeddingApiKey" text;
