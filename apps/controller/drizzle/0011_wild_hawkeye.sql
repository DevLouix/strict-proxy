DROP INDEX "vpn_sessions_user_uq";--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "auto_drain_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_sessions_user_device_uq" ON "vpn_sessions" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_sessions_session_uq" ON "vpn_sessions" USING btree ("session_id");