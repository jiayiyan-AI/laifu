CREATE TYPE "public"."agent_loop_completion" AS ENUM('success', 'fail', 'limit');--> statement-breakpoint
CREATE TYPE "public"."message_content_type" AS ENUM('text', 'json');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."message_source" AS ENUM('web', 'wechat');--> statement-breakpoint
CREATE TABLE "agent_loops" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"iterated_at" timestamp with time zone,
	"iterated_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"completion" "agent_loop_completion"
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content_type" "message_content_type" DEFAULT 'text' NOT NULL,
	"content" jsonb,
	"source" "message_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"name" text NOT NULL,
	"is_success" boolean,
	"parameters" jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_loops" ADD CONSTRAINT "agent_loops_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_loops" ADD CONSTRAINT "agent_loops_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_loops_thread" ON "agent_loops" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_loops_active" ON "agent_loops" USING btree ("thread_id","created_at") WHERE completed_at is null;--> statement-breakpoint
CREATE INDEX "messages_thread_created" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_message" ON "tool_calls" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_thread" ON "tool_calls" USING btree ("thread_id","created_at");