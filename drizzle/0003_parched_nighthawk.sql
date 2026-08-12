CREATE TABLE IF NOT EXISTS `receipt_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`bet_id` integer,
	`kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`code` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "receipt_snapshots_kind_check" CHECK("receipt_snapshots"."kind" IN ('bet', 'sealed', 'settled')),
	CONSTRAINT "receipt_snapshots_status_check" CHECK("receipt_snapshots"."status" IN ('active', 'superseded', 'cancelled')),
	CONSTRAINT "receipt_snapshots_target_check" CHECK(("receipt_snapshots"."kind" = 'bet' AND "receipt_snapshots"."bet_id" IS NOT NULL) OR ("receipt_snapshots"."kind" IN ('sealed', 'settled') AND "receipt_snapshots"."bet_id" IS NULL)),
	CONSTRAINT "receipt_snapshots_revision_check" CHECK("receipt_snapshots"."revision" > 0),
	CONSTRAINT "receipt_snapshots_code_check" CHECK(length("receipt_snapshots"."code") > 0),
	CONSTRAINT "receipt_snapshots_payload_check" CHECK(json_valid("receipt_snapshots"."payload_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipt_snapshots_code_unique` ON `receipt_snapshots` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipt_snapshots_active_bet_unique` ON `receipt_snapshots` (`bet_id`) WHERE "receipt_snapshots"."kind" = 'bet' AND "receipt_snapshots"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipt_snapshots_active_match_kind_unique` ON `receipt_snapshots` (`match_id`,`kind`) WHERE "receipt_snapshots"."bet_id" IS NULL AND "receipt_snapshots"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipt_snapshots_bet_revision_unique` ON `receipt_snapshots` (`bet_id`,`revision`) WHERE "receipt_snapshots"."kind" = 'bet';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `receipt_snapshots_match_revision_unique` ON `receipt_snapshots` (`match_id`,`kind`,`revision`) WHERE "receipt_snapshots"."bet_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `receipt_snapshots_match_created_idx` ON `receipt_snapshots` (`match_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `receipt_snapshots_bet_created_idx` ON `receipt_snapshots` (`bet_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
