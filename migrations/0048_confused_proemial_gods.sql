CREATE TABLE `reminder_sends` (
	`profile_id` text NOT NULL,
	`local_day` text NOT NULL,
	`kind` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `local_day`, `kind`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
