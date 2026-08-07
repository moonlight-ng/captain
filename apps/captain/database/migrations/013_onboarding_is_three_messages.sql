-- Onboarding used to be an interview: pick a currency, pick a ranking mode,
-- then type airline preferences as free text. It asked all three before the
-- traveller had been told what Captain does, and every answer it collected is
-- already seeded by DEFAULT_PROFILE and editable on /profile. It is now three
-- messages and no questions, so the intermediate steps have nothing to mean.
--
-- Travellers stranded mid-interview are moved to 'complete' rather than being
-- asked again. They keep whatever they had already chosen; the defaults cover
-- the rest, and /profile is where the remainder gets changed either way.

update captain.traveller_profiles
set onboarding_step = 'complete',
  onboarding_completed_at = coalesce(onboarding_completed_at, now()),
  updated_at = now()
where onboarding_step in ('currency', 'ranking', 'airlines');

alter table captain.traveller_profiles
  drop constraint if exists traveller_profiles_onboarding_step_check;

alter table captain.traveller_profiles
  add constraint traveller_profiles_onboarding_step_check
  check (onboarding_step in ('welcome', 'complete'));
