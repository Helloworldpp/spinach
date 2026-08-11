CREATE TABLE `bets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`bettor_name` text NOT NULL,
	`bettor_key` text NOT NULL,
	`mode` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`winner_pick` text,
	`predicted_score_a` integer,
	`predicted_score_b` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bets_mode_check" CHECK("bets"."mode" IN ('winner', 'score')),
	CONSTRAINT "bets_amount_check" CHECK("bets"."amount_cents" > 0),
	CONSTRAINT "bets_selection_check" CHECK((
        "bets"."mode" = 'winner'
        AND "bets"."winner_pick" IN ('A', 'B')
        AND "bets"."predicted_score_a" IS NULL
        AND "bets"."predicted_score_b" IS NULL
      ) OR (
        "bets"."mode" = 'score'
        AND "bets"."winner_pick" IS NULL
        AND "bets"."predicted_score_a" IS NOT NULL
        AND "bets"."predicted_score_b" IS NOT NULL
        AND "bets"."predicted_score_a" >= 0
        AND "bets"."predicted_score_b" >= 0
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bets_match_bettor_mode_unique` ON `bets` (`match_id`,`bettor_key`,`mode`);--> statement-breakpoint
CREATE INDEX `bets_match_created_idx` ON `bets` (`match_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`player_a` text NOT NULL,
	`player_b` text NOT NULL,
	`race_to` integer DEFAULT 3 NOT NULL,
	`stake_limit_cents` integer DEFAULT 1000 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`result_score_a` integer,
	`result_score_b` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`settled_at` text,
	CONSTRAINT "matches_status_check" CHECK("matches"."status" IN ('open', 'closed', 'settled')),
	CONSTRAINT "matches_race_to_check" CHECK("matches"."race_to" > 0),
	CONSTRAINT "matches_stake_limit_check" CHECK("matches"."stake_limit_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `matches_status_created_idx` ON `matches` (`status`,`created_at`);