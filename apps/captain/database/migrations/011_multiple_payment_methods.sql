-- A profile may keep multiple tokenised cards. The partial default-card index
-- from migration 004 continues to guarantee at most one default per user.
drop index if exists captain.captain_payment_methods_one_active_idx;

comment on table captain.payment_methods is
  'Tokenized payment instruments only. Multiple active cards are allowed; no PAN or CVC is stored.';
