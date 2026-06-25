CREATE TABLE "user_oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"external_login" text,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"token_scopes" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_oauth_connections" ADD CONSTRAINT "user_oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_oauth_connections_user_provider_unique" ON "user_oauth_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "user_oauth_connections_provider_account_unique" ON "user_oauth_connections" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "user_oauth_connections_user" ON "user_oauth_connections" USING btree ("user_id");