ALTER TABLE `matches` ADD `winner_prize_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `matches` SET `winner_prize_bps` = 2000 WHERE `status` = 'settled';
