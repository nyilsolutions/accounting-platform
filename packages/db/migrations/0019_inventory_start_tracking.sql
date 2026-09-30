-- Phase 10a: starting to track inventory on a date (open question 61, ADR 0018).
--
--   * An item converted to inventory (QuickBooks inventory items import as non-inventory) is
--     tracked from its inventory_start_date: documents dated before it keep posting as they did,
--     with no quantities.
--   * An "inventory starting value" transaction records each item's quantity and value on that
--     date as 'opening' movements. When the value is already in the books (brought over from
--     QuickBooks in the Inventory Asset balance) it posts nothing; otherwise it posts the asset
--     against an offset account.

alter table items add column inventory_start_date date,
  add constraint items_inventory_start_stocked check (
    inventory_start_date is null or item_type in ('inventory', 'assembly'));

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment', 'paycheck', 'payroll_liability_payment',
  'inventory_adjustment', 'inventory_build', 'inventory_opening'));

alter table inventory_moves drop constraint inventory_moves_kind_check;
alter table inventory_moves add constraint inventory_moves_kind_check check (kind in (
  'purchase', 'purchase_return', 'sale', 'sale_return', 'adjustment', 'build_consume',
  'build_produce', 'opening'));

create table inventory_opening_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  transaction_id    uuid not null,
  line_no           smallint not null check (line_no between 1 and 1000),
  item_id           uuid not null,
  quantity          numeric(19,4) not null check (quantity > 0),
  value             numeric(19,4) not null check (value >= 0),
  -- The account the value is posted against; null when it is already in the books.
  offset_account_id uuid,
  unique (transaction_id, line_no),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, offset_account_id) references accounts (company_id, id)
);
alter table inventory_opening_lines enable row level security;
create policy inventory_opening_lines_tenant on inventory_opening_lines for all
  using (company_id = app_current_company_id()) with check (company_id = app_current_company_id());
grant select, insert, update, delete on inventory_opening_lines to acct_app;

-- A starting value already in the books posts no lines, like a zero-value adjustment (0018).
create or replace function app_check_transaction_balanced() returns trigger
  language plpgsql
  as $$
  declare
    txn_id uuid;
    cur_version int;
    total_debit numeric;
    total_credit numeric;
    line_count int;
    hdr record;
  begin
    if tg_table_name = 'journal_lines' then txn_id := new.transaction_id; else txn_id := new.id; end if;
    select version, txn_type, total into hdr from transactions where id = txn_id;
    cur_version := hdr.version;
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into total_debit, total_credit, line_count
      from journal_lines where transaction_id = txn_id and version = cur_version;
    if line_count = 0 and hdr.txn_type in ('payment', 'bill_payment') and hdr.total = 0 then
      return null;
    end if;
    if line_count = 0
        and hdr.txn_type in ('inventory_adjustment', 'inventory_build', 'inventory_opening') then
      return null;
    end if;
    if line_count < 2 then
      raise exception 'Transaction % must have at least two lines', txn_id using errcode = 'check_violation';
    end if;
    if total_debit <> total_credit then
      raise exception 'Transaction % is not balanced: debits % <> credits %', txn_id, total_debit, total_credit
        using errcode = 'check_violation';
    end if;
    return null;
  end $$;
