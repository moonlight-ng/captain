alter table captain.login_tokens
  drop constraint if exists login_tokens_redirect_path_check;

alter table captain.login_tokens
  add constraint login_tokens_redirect_path_check
  check (redirect_path in ('/trip', '/preferences', '/settings', '/payment', '/travellers'));
