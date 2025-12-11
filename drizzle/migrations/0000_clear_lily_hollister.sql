CREATE TABLE `action_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`action_type` text NOT NULL,
	`action_description` text NOT NULL,
	`metadata_json` text,
	`has_error` integer DEFAULT false NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`check_type` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`steps_json` text NOT NULL,
	`trigger_source` text,
	`ai_analysis` text,
	`ai_analysis_json` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `knowledge_base` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`description` text,
	`tags` text,
	`metadata_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_base_url_unique` ON `knowledge_base` (`url`);--> statement-breakpoint
CREATE TABLE `monitored_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jules_session_id` text NOT NULL,
	`original_prompt` text NOT NULL,
	`title` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	`current_status` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitored_sessions_jules_session_id_unique` ON `monitored_sessions` (`jules_session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`title` text,
	`endpoint_type` text NOT NULL,
	`repo_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_session_id_unique` ON `sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `supervisor_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`jules_state` text NOT NULL,
	`jules_context` text,
	`action_type` text NOT NULL,
	`tool_used` text,
	`response_content` text,
	`processing_ms` integer,
	`metadata` text,
	FOREIGN KEY (`session_id`) REFERENCES `monitored_sessions`(`jules_session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_logs_session_id` ON `supervisor_logs` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_logs_action_created` ON `supervisor_logs` (`action_type`,`created_at`);