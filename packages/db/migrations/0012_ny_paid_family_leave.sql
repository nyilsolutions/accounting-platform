-- New York Paid Family Leave: an employee contribution the tax engine now calculates from
-- /tax-data/2026/states/ny.json (0.432% of wages up to $411.91 a year). Paycheck tax lines may
-- carry it.
alter table paycheck_lines drop constraint paycheck_lines_tax_code_check;
alter table paycheck_lines add constraint paycheck_lines_tax_code_check check (tax_code in (
  'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
  'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
  'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi', 'ny_pfl'));
