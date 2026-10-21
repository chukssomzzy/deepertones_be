ALTER TABLE `face_scans` ADD `reaper_checked_at` integer;--> statement-breakpoint
CREATE INDEX `face_scans_pc_analysis_task_id_idx` ON `face_scans` (`pc_analysis_task_id`);--> statement-breakpoint
CREATE INDEX `face_scans_pc_fitzpatrick_task_id_idx` ON `face_scans` (`pc_fitzpatrick_task_id`);--> statement-breakpoint
CREATE INDEX `face_scans_state_updated_at_idx` ON `face_scans` (`state`,`updated_at`);