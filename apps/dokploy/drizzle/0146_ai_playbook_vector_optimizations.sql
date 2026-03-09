-- Playbook vector search optimizations

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_hash_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ("hashVector" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_384_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(384)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 384;

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_512_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(512)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 512;

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_768_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(768)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 768;

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_1024_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(1024)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 1024;

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_1536_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(1536)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 1536;

CREATE INDEX IF NOT EXISTS "ai_agent_playbook_embedding_3072_hnsw_idx"
ON "ai_agent_playbook"
USING hnsw ((("embeddingVector")::halfvec(3072)) halfvec_cosine_ops)
WHERE "embeddingVector" IS NOT NULL AND "embeddingDim" = 3072;
