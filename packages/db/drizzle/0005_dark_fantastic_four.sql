ALTER TYPE "public"."message_source" ADD VALUE 'feishu';--> statement-breakpoint
CREATE TABLE "feishu_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"app_secret" text NOT NULL,
	"domain" text DEFAULT 'feishu' NOT NULL,
	"owner_open_id" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_bindings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "feishu_bindings_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
ALTER TABLE "feishu_bindings" ADD CONSTRAINT "feishu_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_bindings" ADD CONSTRAINT "feishu_bindings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feishu_bindings_active" ON "feishu_bindings" USING btree ("is_active") WHERE is_active = true;