alter table captain.traveller_profiles
  drop constraint if exists traveller_profiles_onboarding_step_check;

alter table captain.traveller_profiles
  add constraint traveller_profiles_onboarding_step_check
  check (onboarding_step in ('welcome', 'currency', 'ranking', 'airlines', 'complete'));
