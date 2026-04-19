CREATE TABLE IF NOT EXISTS "webServerSettings" (
  "id" text PRIMARY KEY NOT NULL,
  "serverIp" text,
  "certificateType" "certificateType" DEFAULT 'none' NOT NULL,
  "https" boolean DEFAULT false NOT NULL,
  "host" text,
  "additionalHosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "letsEncryptEmail" text,
  "sshPrivateKey" text,
  "enableDockerCleanup" boolean DEFAULT false NOT NULL,
  "logCleanupCron" text DEFAULT '0 0 * * *',
  "metricsConfig" jsonb DEFAULT '{"server":{"type":"Dokploy","refreshRate":60,"port":4500,"token":"","retentionDays":2,"cronJob":"","urlCallback":"","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb NOT NULL,
  "cleanupCacheApplications" boolean DEFAULT false NOT NULL,
  "cleanupCacheOnPreviews" boolean DEFAULT false NOT NULL,
  "cleanupCacheOnCompose" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
