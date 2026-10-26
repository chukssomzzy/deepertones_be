CREATE TABLE `routine_outcome_counts` (
	`goal` text NOT NULL,
	`skin_type` text DEFAULT '' NOT NULL,
	`country` text NOT NULL,
	`code` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`fainter` integer DEFAULT 0 NOT NULL,
	`flared` integer DEFAULT 0 NOT NULL,
	`flared_or_stopped` integer DEFAULT 0 NOT NULL,
	`fainter_and_flared_or_stopped` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`goal`, `skin_type`, `country`, `code`)
);
