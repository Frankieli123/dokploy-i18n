ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "volumeBackup" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text,
  "user_id" text,
  "user_email" text NOT NULL,
  "user_role" text NOT NULL,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text,
  "resource_name" text,
  "metadata" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditLog_organizationId_idx" ON "audit_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditLog_userId_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditLog_createdAt_idx" ON "audit_log" USING btree ("created_at");
