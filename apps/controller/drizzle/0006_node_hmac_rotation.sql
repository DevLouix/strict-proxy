ALTER TABLE "nodes" ADD COLUMN "previous_hmac_secret" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "previous_hmac_secret_expires_at" timestamp with time zone;
