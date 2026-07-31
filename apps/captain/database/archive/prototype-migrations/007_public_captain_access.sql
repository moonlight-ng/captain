-- Captain is public: preserve explicit suspensions and activate everyone else.
update captain.users
set status = 'active', updated_at = now()
where status in ('pending', 'allowlisted');

alter table captain.users
  drop constraint if exists users_status_check;

alter table captain.users
  drop constraint if exists captain_users_status_check;

alter table captain.users
  add constraint captain_users_status_check
  check (status in ('active', 'suspended'));
