-- Where the respondent's text-size ladder STARTS (config.chatTextSize).
--
-- The in-session stepper stays the respondent's own — this names only the rung someone who has
-- never touched it opens on, and anyone with a stored preference never sees this value. Stores the
-- NAME rather than the ladder index so retuning the multipliers cannot silently change what an
-- authored value means. 'standard' is the size every questionnaire had before this column existed,
-- so backfilling the default leaves every live version rendering exactly as it did.
ALTER TABLE "app_questionnaire_config" ADD COLUMN "chatTextSize" TEXT NOT NULL DEFAULT 'standard';
