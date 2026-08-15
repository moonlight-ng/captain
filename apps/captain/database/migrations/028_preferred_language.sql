alter table captain.traveller_profiles
  add column preferred_language text not null default 'en',
  add column preferred_language_source text not null default 'default',
  add column preferred_language_set_at timestamptz,
  add constraint captain_traveller_profiles_preferred_language_check
    check (preferred_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  add constraint captain_traveller_profiles_language_source_check
    check (preferred_language_source in ('default', 'detected', 'user'));
