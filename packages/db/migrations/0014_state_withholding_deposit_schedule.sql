-- Phase 8: the withholding deposit schedule a state assigned the company.
--
-- Illinois assigns each employer a monthly or semiweekly IL-501 payment schedule from its
-- look-back period (Publication 131); due dates for state withholding follow it. Null means not
-- set: the state's schedule for new taxpayers applies (tax-data `withholdingDeposits`).

alter table payroll_state_registrations
  add column withholding_deposit_schedule text
    check (withholding_deposit_schedule in ('monthly', 'semiweekly'));
