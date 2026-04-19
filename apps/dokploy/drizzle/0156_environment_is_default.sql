ALTER TABLE "environment" ADD COLUMN "isDefault" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "environment" SET "isDefault" = false;
--> statement-breakpoint
WITH production_defaults AS (
	SELECT DISTINCT ON ("projectId") "environmentId"
	FROM "environment"
	WHERE "name" = 'production'
	ORDER BY "projectId", "createdAt" ASC
)
UPDATE "environment" AS env
SET "isDefault" = true
FROM production_defaults AS defaults
WHERE env."environmentId" = defaults."environmentId";
--> statement-breakpoint
WITH fallback_defaults AS (
	SELECT DISTINCT ON (env."projectId") env."environmentId"
	FROM "environment" AS env
	WHERE NOT EXISTS (
		SELECT 1
		FROM "environment" AS existing_default
		WHERE existing_default."projectId" = env."projectId"
			AND existing_default."isDefault" = true
	)
	ORDER BY env."projectId", env."createdAt" ASC
)
UPDATE "environment" AS env
SET "isDefault" = true
FROM fallback_defaults AS defaults
WHERE env."environmentId" = defaults."environmentId";
