-- Phase 11c: a licensed state tax engine plugs in beside the built-in one (ADR 0026).
--
-- The built-in engine keeps federal taxes and the five states it has sourced data for. Any other
-- state (and local taxes) can be calculated by a licensed engine behind StateTaxEngine. Its
-- lines use general codes and name their jurisdiction:
--   state_other  a state tax other than income tax or unemployment (e.g. a disability fund)
--   local_income a local income tax (city, county, school district)
--   local_other  any other local tax
-- and are owed to agencies 'state_other:<ST>:<code>' or 'local:<ST>:<code>'.

alter table paycheck_lines drop constraint paycheck_lines_tax_code_check;
alter table paycheck_lines add constraint paycheck_lines_tax_code_check check (tax_code in (
  'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
  'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
  'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi', 'ny_pfl',
  'ny_dbl', 'state_other', 'local_income', 'local_other'));
alter table paycheck_lines
  -- The engine's code for the jurisdiction (e.g. a locality or fund code) and its name.
  add column jurisdiction_code text check (jurisdiction_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  add column jurisdiction_name text check (length(jurisdiction_name) between 1 and 80),
  add constraint paycheck_lines_jurisdiction_check check (
    (tax_code in ('state_other', 'local_income', 'local_other'))
      = (jurisdiction_code is not null and jurisdiction_name is not null and state is not null));

alter table prior_payroll_lines drop constraint prior_payroll_lines_tax_code_check;
alter table prior_payroll_lines add constraint prior_payroll_lines_tax_code_check check (tax_code in (
  'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
  'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
  'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi', 'ny_pfl',
  'ny_dbl', 'state_other', 'local_income', 'local_other'));
alter table prior_payroll_lines
  add column jurisdiction_code text check (jurisdiction_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  add column jurisdiction_name text check (length(jurisdiction_name) between 1 and 80),
  add constraint prior_payroll_lines_jurisdiction_check check (
    (tax_code in ('state_other', 'local_income', 'local_other'))
      = (jurisdiction_code is not null and jurisdiction_name is not null and state is not null));

alter table payroll_liability_payments drop constraint payroll_liability_payments_agency_check;
alter table payroll_liability_payments add constraint payroll_liability_payments_agency_check
  check (agency ~ '^(federal_941|federal_940|ny_pfl|ny_dbl|state_(withholding|unemployment):[A-Z]{2}|(state_other|local):[A-Z]{2}:[A-Za-z0-9_.-]{1,40}|item:[0-9a-f-]{36})$');
