-- Store every deduplicated offer that passed both web checks. Search responses
-- remain naturally bounded by their tool and token budgets; the database must
-- not silently discard representative airlines after verification.
alter table captain.search_runs
  drop constraint if exists captain_search_runs_retained_offer_count_check;

alter table captain.search_runs
  add constraint captain_search_runs_retained_offer_count_check
  check (retained_offer_count is null or retained_offer_count >= 0);

drop trigger if exists captain_offers_limit_storage on captain.offers;
drop function if exists captain.enforce_offer_storage_limit();
