-- Phase 10a: inventory (ADR 0018).
--
--   * Inventory part and assembly items carry an inventory asset account, a cost of goods sold
--     account (items.expense_account_id) and a reorder point. Assemblies list their components.
--   * The company's costing method: FIFO or average cost. It can't change once inventory has
--     moved (checked by the service).
--   * inventory_moves: every change in quantity, from the posted transaction that caused it
--     (purchases, sales, returns, adjustments, builds). Derived data: the service replaces a
--     transaction's moves when it is saved and removes them when it is voided or deleted, then
--     recosts the item. Outflows get their cost from the costing method; inflows from their
--     document (a purchase's amount) or the item's current cost (returns, uncosted increases).
--   * Journal lines a transaction carries because of inventory (cost of goods sold against the
--     inventory asset) are marked role = 'inventory', so they can be recalculated on their own
--     when an earlier change recosts later transactions.

alter table companies add column inventory_costing text not null default 'fifo'
  check (inventory_costing in ('fifo', 'average'));

alter table accounts drop constraint accounts_system_role_check;
alter table accounts add constraint accounts_system_role_check check (system_role in (
  'accounts_receivable', 'accounts_payable', 'undeposited_funds', 'opening_balance_equity',
  'retained_earnings', 'sales_tax_payable', 'uncategorized_income', 'uncategorized_expense',
  'uncategorized_asset', 'payroll_liabilities', 'payroll_expenses', 'cost_of_goods_sold',
  'inventory_asset'));

alter table items drop constraint items_item_type_check;
alter table items add constraint items_item_type_check
  check (item_type in ('service', 'non_inventory', 'other_charge', 'inventory', 'assembly'));
alter table items
  add column asset_account_id uuid,
  add column reorder_point numeric(19,4) check (reorder_point >= 0),
  add foreign key (company_id, asset_account_id) references accounts (company_id, id),
  -- Inventory and assemblies track value in an asset account and relieve it to cost of goods
  -- sold; other items have neither.
  add constraint items_inventory_accounts check (
    (item_type in ('inventory', 'assembly')
       and asset_account_id is not null and expense_account_id is not null)
    or (item_type not in ('inventory', 'assembly') and asset_account_id is null)),
  add constraint items_reorder_point_inventory check (
    reorder_point is null or item_type in ('inventory', 'assembly'));

create table assembly_components (
  company_id    uuid not null,
  assembly_id   uuid not null,
  component_id  uuid not null,
  quantity      numeric(19,4) not null check (quantity > 0),
  position      smallint not null check (position between 1 and 200),
  primary key (assembly_id, component_id),
  foreign key (company_id, assembly_id) references items (company_id, id) on delete cascade,
  foreign key (company_id, component_id) references items (company_id, id),
  check (assembly_id <> component_id)
);

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment', 'paycheck', 'payroll_liability_payment',
  'inventory_adjustment', 'inventory_build'));

alter table journal_lines add column role text check (role in ('inventory'));

-- An inventory adjustment or build moves quantities; its value can be zero (stock added at no
-- cost, or components that cost nothing), and then it has no journal lines at all, like a
-- credit-only payment (0005). Every other transaction still needs at least two lines, and every
-- transaction must balance.
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
    if line_count = 0 and hdr.txn_type in ('inventory_adjustment', 'inventory_build') then
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

create table inventory_moves (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  item_id         uuid not null,
  transaction_id  uuid not null,
  -- Order within the transaction (and the source document line, when there is one).
  seq             smallint not null check (seq between 1 and 1000),
  line_no         smallint check (line_no between 1 and 1000),
  move_date       date not null,
  kind            text not null check (kind in (
                    'purchase', 'purchase_return', 'sale', 'sale_return', 'adjustment',
                    'build_consume', 'build_produce')),
  -- Positive in, negative out.
  quantity        numeric(19,4) not null check (quantity <> 0),
  -- Inflows with a known cost (a purchase's amount, an increase at a given unit cost).
  fixed_cost      numeric(19,4) check (fixed_cost >= 0),
  -- The value moved, signed like the quantity; set by costing.
  cost            numeric(19,4) not null default 0,
  -- Where the value posts, fixed when the move is made so recosting an old transaction keeps its
  -- accounts: the item's inventory asset account, and the other side (cost of goods sold, or an
  -- adjustment's account; none for purchases and builds).
  asset_account_id    uuid not null,
  counter_account_id  uuid,
  class_id        uuid,
  created_at      timestamptz not null default now(),
  unique (transaction_id, seq),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, asset_account_id) references accounts (company_id, id),
  foreign key (company_id, counter_account_id) references accounts (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  check (fixed_cost is null or quantity > 0),
  check ((quantity > 0 and cost >= 0) or (quantity < 0 and cost <= 0))
);
create index inventory_moves_item_idx on inventory_moves (company_id, item_id, move_date);

-- Adjustment lines (quantity changes) and builds: document detail, replaced on save.
create table inventory_adjustment_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  transaction_id  uuid not null,
  line_no         smallint not null check (line_no between 1 and 1000),
  item_id         uuid not null,
  quantity_change numeric(19,4) not null check (quantity_change <> 0),
  -- Increases: the unit cost of the added quantity (null: the item's current cost).
  unit_cost       numeric(19,4) check (unit_cost >= 0),
  -- The account the value is adjusted against (shrinkage, samples, opening balance equity…).
  account_id      uuid not null,
  description     text check (length(description) <= 4000),
  class_id        uuid,
  unique (transaction_id, line_no),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, item_id) references items (company_id, id),
  foreign key (company_id, account_id) references accounts (company_id, id),
  foreign key (company_id, class_id) references classes (company_id, id),
  check (unit_cost is null or quantity_change > 0)
);

create table inventory_builds (
  transaction_id  uuid primary key,
  company_id      uuid not null,
  assembly_id     uuid not null,
  quantity        numeric(19,4) not null check (quantity > 0),
  foreign key (company_id, transaction_id) references transactions (company_id, id),
  foreign key (company_id, assembly_id) references items (company_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['assembly_components', 'inventory_moves', 'inventory_adjustment_lines',
                           'inventory_builds'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all using (company_id = app_current_company_id())
      with check (company_id = app_current_company_id())', t || '_tenant', t);
    execute format('grant select, insert, update, delete on %I to acct_app', t);
  end loop;
end $$;
