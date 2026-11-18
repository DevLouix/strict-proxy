CREATE TABLE "gated_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"required_tier" text DEFAULT 'standard' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vpn_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_credentials" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "gated_links" ADD CONSTRAINT "gated_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_sessions" ADD CONSTRAINT "vpn_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "node_credentials_user_node_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "gated_links_url_uq" ON "gated_links" USING btree ("url");--> statement-breakpoint
CREATE INDEX "gated_links_active_idx" ON "gated_links" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_sessions_user_uq" ON "vpn_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vpn_sessions_device_idx" ON "vpn_sessions" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_credentials_user_node_device_uq" ON "node_credentials" USING btree ("user_id","node_id","device_id");
