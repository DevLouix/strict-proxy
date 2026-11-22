CREATE TABLE "gatekeeper_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gatekeeper_keys" ADD CONSTRAINT "gatekeeper_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "gatekeeper_keys_hash_uq" ON "gatekeeper_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE INDEX "gatekeeper_keys_active_idx" ON "gatekeeper_keys" USING btree ("active");
