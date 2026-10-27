CREATE TABLE `guides` (
	`key` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`goal` text,
	`what_it_does` text NOT NULL,
	`look_for` text NOT NULL,
	`for_deeper_skin` text NOT NULL,
	`look_for_when_pregnant` text,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
