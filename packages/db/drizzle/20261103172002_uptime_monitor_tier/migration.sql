-- metadata
ALTER TABLE "uptime_monitors" ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'core';
