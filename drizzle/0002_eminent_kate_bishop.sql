ALTER TABLE `matches` ADD `winner_rollover_in_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `winner_rollover_out_cents` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `winner_rollover_source_match_id` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `score_rollover_in_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `score_rollover_out_cents` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `score_rollover_source_match_id` integer;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `matches_rollover_nonnegative_insert`
BEFORE INSERT ON `matches`
WHEN NEW.`winner_rollover_in_cents` < 0
  OR NEW.`winner_rollover_out_cents` < 0
  OR NEW.`score_rollover_in_cents` < 0
  OR NEW.`score_rollover_out_cents` < 0
BEGIN
  SELECT RAISE(ABORT, 'rollover amounts must be nonnegative');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `matches_rollover_nonnegative_update`
BEFORE UPDATE OF
  `winner_rollover_in_cents`,
  `winner_rollover_out_cents`,
  `score_rollover_in_cents`,
  `score_rollover_out_cents`
ON `matches`
WHEN NEW.`winner_rollover_in_cents` < 0
  OR NEW.`winner_rollover_out_cents` < 0
  OR NEW.`score_rollover_in_cents` < 0
  OR NEW.`score_rollover_out_cents` < 0
BEGIN
  SELECT RAISE(ABORT, 'rollover amounts must be nonnegative');
END;--> statement-breakpoint
CREATE UNIQUE INDEX `matches_winner_rollover_source_unique` ON `matches` (`winner_rollover_source_match_id`) WHERE `winner_rollover_source_match_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `matches_score_rollover_source_unique` ON `matches` (`score_rollover_source_match_id`) WHERE `score_rollover_source_match_id` IS NOT NULL;--> statement-breakpoint
PRAGMA optimize;
