CREATE TABLE "client_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text DEFAULT 'android' NOT NULL,
	"version" text NOT NULL,
	"build_number" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_release_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"abi" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_crash_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" text,
	"platform" text DEFAULT 'android' NOT NULL,
	"app_version" text,
	"build_number" integer,
	"abi" text,
	"device" text,
	"os_version" text,
	"message" text NOT NULL,
	"stack" text,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "client_releases_platform_build_uq" ON "client_releases" USING btree ("platform","build_number");--> statement-breakpoint
CREATE INDEX "client_releases_status_idx" ON "client_releases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "client_release_artifacts_release_abi_uq" ON "client_release_artifacts" USING btree ("release_id","abi");--> statement-breakpoint
CREATE UNIQUE INDEX "client_crash_reports_report_uq" ON "client_crash_reports" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "client_crash_reports_created_idx" ON "client_crash_reports" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "client_releases" ADD CONSTRAINT "client_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_release_artifacts" ADD CONSTRAINT "client_release_artifacts_release_id_client_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."client_releases"("id") ON DELETE cascade ON UPDATE no action;
