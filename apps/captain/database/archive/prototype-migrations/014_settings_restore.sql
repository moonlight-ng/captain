alter table captain.traveller_profiles
  add column if not exists alerts_enabled boolean not null default true,
  add column if not exists max_alerts_per_day integer not null default 2,
  add column if not exists quiet_hours_enabled boolean not null default true,
  add column if not exists quiet_hours_start integer not null default 22,
  add column if not exists quiet_hours_end integer not null default 7;

alter table captain.traveller_profiles
  drop constraint if exists captain_profiles_max_alerts_per_day_check;
alter table captain.traveller_profiles
  add constraint captain_profiles_max_alerts_per_day_check
  check (max_alerts_per_day between 1 and 2);

alter table captain.traveller_profiles
  drop constraint if exists captain_profiles_quiet_hours_check;
alter table captain.traveller_profiles
  add constraint captain_profiles_quiet_hours_check
  check (
    quiet_hours_start between 0 and 23
    and quiet_hours_end between 0 and 23
  );
