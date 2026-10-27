CREATE TABLE `routine_check_ins` (
	`profile_id` text NOT NULL,
	`day` text NOT NULL,
	`time` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `day`, `time`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
