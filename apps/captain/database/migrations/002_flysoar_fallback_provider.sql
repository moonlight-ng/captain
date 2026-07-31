alter table captain.search_specs
  drop constraint if exists search_specs_provider_check;

alter table captain.search_specs
  add constraint search_specs_provider_check
  check (provider = 'flysoar_mcp' or provider ~ '^official_[a-z0-9_]+$');

alter table captain.offers
  drop constraint if exists offers_provider_check;

alter table captain.offers
  add constraint offers_provider_check
  check (provider = 'flysoar_mcp' or provider ~ '^official_[a-z0-9_]+$');
