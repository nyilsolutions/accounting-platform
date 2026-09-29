-- Estimate lines without a product/service need an income account, like invoice lines, so the
-- estimate can be converted to an invoice.
alter table estimate_lines add column account_id uuid;
alter table estimate_lines
  add constraint estimate_lines_account_fk foreign key (company_id, account_id)
  references accounts (company_id, id);
