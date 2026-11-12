ALTER TABLE "nodes" ADD COLUMN "engine_healthy" boolean;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "stats_api_healthy" boolean;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "engine_health_checked_at" timestamp with time zone;
