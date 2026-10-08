-- Phase 8: New York disability benefits (DBL) and company HSA contributions.
--
--   * The tax engine deducts the employee DBL contribution (0.5% of wages, at most $0.60 a week,
--     /tax-data/2026/states/ny.json); paycheck tax lines may carry ny_dbl, owed to the carrier.
--   * A company may collect the employee PFL and DBL contributions or pay them itself (the WCB
--     says an employer "is allowed, but not required" to collect them). Employees who filed
--     Form DB-130 are exempt from DBL contributions.
--   * Company HSA contributions are split by whether they go through the cafeteria plan, which
--     Florida's reemployment tax treats differently (open question 56).

alter table paycheck_lines drop constraint paycheck_lines_tax_code_check;
alter table paycheck_lines add constraint paycheck_lines_tax_code_check check (tax_code in (
  'federal_income', 'social_security_employee', 'social_security_employer', 'medicare_employee',
  'medicare_employer', 'additional_medicare', 'futa', 'state_income', 'nyc_income',
  'yonkers_income', 'state_unemployment', 'ny_reemployment_fund', 'ca_ett', 'ca_sdi', 'ny_pfl',
  'ny_dbl'));

alter table payroll_liability_payments drop constraint payroll_liability_payments_agency_check;
alter table payroll_liability_payments add constraint payroll_liability_payments_agency_check
  check (agency ~ '^(federal_941|federal_940|ny_pfl|ny_dbl|state_(withholding|unemployment):[A-Z]{2}|item:[0-9a-f-]{36})$');

alter table payroll_items drop constraint payroll_items_kind_check;
alter table payroll_items add constraint payroll_items_kind_check check (kind in (
  -- earnings
  'hourly', 'overtime', 'double_time', 'salary', 'bonus', 'commission', 'cash_tips',
  'paid_tips', 'vacation', 'sick', 'holiday', 'reimbursement', 'fringe_benefit', 'other_earning',
  -- pre-tax deductions
  'traditional_401k', 'traditional_403b', 'section_125', 'hsa', 'health_fsa',
  'dependent_care_fsa',
  -- post-tax deductions
  'roth_401k', 'roth_403b', 'garnishment', 'loan_repayment', 'other_deduction',
  -- employer contributions
  'retirement_match', 'employer_health', 'employer_hsa', 'employer_hsa_cafeteria',
  'other_employer_contribution'));

alter table payroll_settings
  add column ny_pfl_deducted boolean not null default true,
  add column ny_dbl_deducted boolean not null default true;

alter table employees add column ny_dbl_exempt boolean not null default false;
