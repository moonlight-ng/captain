-- Booking-ready passenger details and encrypted passport storage.
-- Only a masked suffix is ever returned to the browser.

create extension if not exists pgcrypto;

alter table captain.passengers
  add column middle_name text,
  add column nationality text,
  add column country_of_residence text,
  add column passport_number_encrypted bytea,
  add column passport_last4 text,
  add column passport_issuing_country text,
  add column passport_expires_on date;

alter table captain.passengers
  add constraint passengers_nationality_check
    check (nationality is null or nationality ~ '^[A-Z]{2}$'),
  add constraint passengers_country_of_residence_check
    check (country_of_residence is null or country_of_residence ~ '^[A-Z]{2}$'),
  add constraint passengers_passport_last4_check
    check (passport_last4 is null or passport_last4 ~ '^[A-Z0-9]{4}$'),
  add constraint passengers_passport_issuing_country_check
    check (passport_issuing_country is null or passport_issuing_country ~ '^[A-Z]{2}$');

comment on column captain.passengers.passport_number_encrypted is
  'OpenPGP AES-256 ciphertext. The plaintext passport number is never returned by profile APIs.';

comment on column captain.passengers.passport_last4 is
  'Display-only suffix used to confirm which encrypted passport is on file.';
