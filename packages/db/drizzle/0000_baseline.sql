CREATE TABLE "container_mapping" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"container_name" text NOT NULL,
	"container_url" text,
	"status" text NOT NULL,
	"provisioning_step" text,
	"progress_pct" integer DEFAULT 0,
	"error_message" text,
	"azure_files_share" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"ready_at" timestamp with time zone,
	CONSTRAINT "container_mapping_container_name_unique" UNIQUE("container_name")
);
--> statement-breakpoint
CREATE TABLE "container_observed_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"observed_entitlements" text[] DEFAULT '{}' NOT NULL,
	"observed_token_version" integer DEFAULT 0 NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_tokens" (
	"user_id" uuid NOT NULL,
	"contact_id" text NOT NULL,
	"token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "context_tokens_user_id_contact_id_pk" PRIMARY KEY("user_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "email_addresses" (
	"localpart" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addrs" text[] DEFAULT '{}' NOT NULL,
	"cc_addrs" text[] DEFAULT '{}' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"reference_ids" text[] DEFAULT '{}' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"raw_blob_key" text,
	"attachment_keys" jsonb DEFAULT '[]' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"price_in" numeric(12, 4) NOT NULL,
	"price_out" numeric(12, 4) NOT NULL,
	"price_cached" numeric(12, 4) DEFAULT '0' NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"archived" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" text,
	"source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cny" numeric(12, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_balance" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_cny" numeric(12, 4) DEFAULT '0' NOT NULL,
	"free_quota_cny_month" numeric(12, 4) DEFAULT '0' NOT NULL,
	"used_cny_month" numeric(12, 4) DEFAULT '0' NOT NULL,
	"period_start" date DEFAULT date_trunc('month', now())::date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_entitlements" (
	"user_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"metadata" jsonb,
	CONSTRAINT "user_entitlements_user_id_feature_pk" PRIMARY KEY("user_id","feature")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"nickname" text,
	"avatar_url" text,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wechat_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ilink_bot_id" text NOT NULL,
	"bot_token" text NOT NULL,
	"base_url" text NOT NULL,
	"updates_cursor" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"thread_id" text,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_bindings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "wechat_bindings_ilink_bot_id_unique" UNIQUE("ilink_bot_id")
);
--> statement-breakpoint
ALTER TABLE "container_mapping" ADD CONSTRAINT "container_mapping_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_observed_state" ADD CONSTRAINT "container_observed_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_tokens" ADD CONSTRAINT "context_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_balance" ADD CONSTRAINT "user_balance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD CONSTRAINT "user_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bindings" ADD CONSTRAINT "wechat_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bindings" ADD CONSTRAINT "wechat_bindings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_addresses_user" ON "email_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "emails_user_received" ON "emails" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "emails_user_message" ON "emails" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_provider_model_effective" ON "pricing" USING btree ("provider","model","effective_at");--> statement-breakpoint
CREATE INDEX "threads_user_updated" ON "threads" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "usage_events_user_time" ON "usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_thread" ON "usage_events" USING btree ("thread_id","created_at") WHERE thread_id is not null;--> statement-breakpoint
CREATE INDEX "user_entitlements_active" ON "user_entitlements" USING btree ("user_id","feature") WHERE disabled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_external_id_unique" ON "users" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bindings_active" ON "wechat_bindings" USING btree ("is_active") WHERE is_active = true;--> statement-breakpoint
-- ── 以下三段 drizzle-kit 无法从 schema.ts 表达，手工补 (见 docs/drizzle.md §5.3 / §5.2)。
-- 改 schema.ts 重新 generate 时，确保把这三段保留/迁移到后续 migration。

-- users 邮箱部分唯一索引: lower(email) 全局唯一，仅非空时约束 (0003)
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" (lower("email")) WHERE "email" IS NOT NULL;--> statement-breakpoint

-- pricing_current view: 每个 provider+model 取最新生效价 (0008)
CREATE VIEW "pricing_current" AS
  SELECT DISTINCT ON (provider, model) *
  FROM "pricing"
  ORDER BY provider, model, effective_at DESC;--> statement-breakpoint

-- pricing 种子 (0008)。重复部署幂等: 命中 (provider,model,effective_at) 唯一索引则跳过。
INSERT INTO "pricing" (provider, model, price_in, price_out, price_cached, effective_at) VALUES
  ('alibaba',   'qwen3-coder-plus', 4.0,  16.0,  1.0, '2025-06-01'),
  ('alibaba',   'qwen-plus',        0.8,  2.0,   0.2, '2025-06-01'),
  ('anthropic', 'claude-sonnet-4',  22.0, 110.0, 5.5, '2025-06-01')
ON CONFLICT (provider, model, effective_at) DO NOTHING;
