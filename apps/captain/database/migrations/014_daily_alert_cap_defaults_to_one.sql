-- The daily improvement-alert cap has been one since smart notifications
-- landed: DEFAULT_PROFILE sets it to 1 and ensureProfile writes that value
-- explicitly on every insert, so no traveller has ever been created with two.
-- The column default still said 2, inherited from the settings restore that
-- predates the smart-notification change and carried forward unexamined by the
-- baseline squash. It has been latent rather than wrong, because nothing reads
-- it -- but it is the value anyone reading the schema would believe, and the
-- onboarding message already promises new travellers one update a day.
--
-- Two remains the ceiling. Existing rows are deliberately left alone: a
-- traveller sitting at two raised their own cap on /profile, and a backfill
-- would silently take that back.

alter table captain.traveller_profiles
  alter column max_alerts_per_day set default 1;
