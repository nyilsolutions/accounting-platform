-- Phase 10c: multi-currency (ADR 0020).
--
--   * The home currency is USD. Multi-currency is turned on per company and can't be turned off.
--   * company_currencies: the foreign currencies a company uses. exchange_rates: how many US
--     dollars one unit of a currency is worth on a date, entered by hand or from the European
--     Central Bank's daily feed.
--   * Customers and vendors may have a foreign currency (null: US dollars). Their documents and
--     payments are in that currency: transactions.currency and exchange_rate (null: US dollars),
--     with the document amount (total) in the currency and home_total its US dollar value.
--   * Journal lines are always in US dollars. Each foreign currency has its own Accounts
--     Receivable and Accounts Payable account (accounts.currency); lines on them also carry the
--     amount in the currency (foreign_debit, foreign_credit).
--   * payment_applications.home_amount: the US dollar value of an application of a foreign
--     payment, at the document's rate. The difference from the payment's own rate is the
--     realized exchange gain or loss.
--   * Unrealized gains and losses are posted on demand ('currency_revaluation' transactions,
--     reversed the next day) to the Exchange Gain or Loss account.

alter table companies add column multicurrency boolean not null default false;

create or replace function app_companies_multicurrency_on() returns trigger
  language plpgsql
  as $$
  begin
    if old.multicurrency and not new.multicurrency then
      raise exception 'Multi-currency can''t be turned off once it is on'
        using errcode = 'check_violation';
    end if;
    return new;
  end $$;
create trigger companies_multicurrency_on before update of multicurrency on companies
  for each row execute function app_companies_multicurrency_on();

create table company_currencies (
  company_id  uuid not null references companies (id) on delete cascade,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$' and currency <> 'USD'),
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  primary key (company_id, currency)
);

create table exchange_rates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  currency    char(3) not null,
  rate_date   date not null check (rate_date between '1900-01-01' and '2199-12-31'),
  -- US dollars per one unit of the currency.
  rate        numeric(19,10) not null check (rate > 0),
  source      text not null check (source in ('manual', 'ecb')),
  created_by  uuid references users (id),
  updated_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, currency, rate_date),
  foreign key (company_id, currency) references company_currencies (company_id, currency)
);
create trigger exchange_rates_touch before update on exchange_rates
  for each row execute function app_touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['company_currencies', 'exchange_rates']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;
grant select, insert, update, delete on company_currencies, exchange_rates to acct_app;

-- Accounts Receivable and Accounts Payable in a foreign currency (one of each per currency).
alter table accounts
  add column currency char(3),
  add foreign key (company_id, currency) references company_currencies (company_id, currency),
  add constraint accounts_currency_control check (
    currency is null or (account_type in ('accounts_receivable', 'accounts_payable')
                         and system_role is null));
create unique index accounts_currency_key on accounts (company_id, account_type, currency)
  where currency is not null;

create or replace function app_accounts_currency_fixed() returns trigger
  language plpgsql
  as $$
  begin
    if old.currency is distinct from new.currency
        or (old.currency is not null and old.account_type <> new.account_type) then
      raise exception 'An account''s currency can''t change'
        using errcode = 'check_violation';
    end if;
    return new;
  end $$;
create trigger accounts_currency_fixed before update of currency, account_type on accounts
  for each row execute function app_accounts_currency_fixed();

alter table accounts drop constraint accounts_system_role_check;
alter table accounts add constraint accounts_system_role_check check (system_role in (
  'accounts_receivable', 'accounts_payable', 'undeposited_funds', 'opening_balance_equity',
  'retained_earnings', 'sales_tax_payable', 'uncategorized_income', 'uncategorized_expense',
  'uncategorized_asset', 'payroll_liabilities', 'payroll_expenses', 'cost_of_goods_sold',
  'inventory_asset', 'exchange_gain_loss'));

alter table customers
  add column currency char(3),
  add foreign key (company_id, currency) references company_currencies (company_id, currency);
alter table vendors
  add column currency char(3),
  add foreign key (company_id, currency) references company_currencies (company_id, currency);

alter table estimates
  add column currency char(3),
  add foreign key (company_id, currency) references company_currencies (company_id, currency);
alter table purchase_orders
  add column currency char(3),
  add foreign key (company_id, currency) references company_currencies (company_id, currency);

alter table transactions
  add column currency char(3),
  add column exchange_rate numeric(19,10) check (exchange_rate > 0),
  add column home_total numeric(19,4),
  add foreign key (company_id, currency) references company_currencies (company_id, currency),
  add constraint transactions_currency_rate check ((currency is null) = (exchange_rate is null)),
  add constraint transactions_home_total check (home_total is null or currency is not null);

alter table transactions drop constraint transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check check (txn_type in (
  'journal_entry', 'invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment', 'deposit',
  'bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit', 'transfer',
  'sales_tax_payment', 'sales_tax_adjustment', 'paycheck', 'payroll_liability_payment',
  'inventory_adjustment', 'inventory_build', 'inventory_opening', 'currency_revaluation'));

-- Lines on a foreign-currency account carry the amount in that currency too. A revaluation line
-- changes only the US dollar value (foreign amounts zero).
alter table journal_lines
  add column foreign_debit numeric(19,4) check (foreign_debit >= 0),
  add column foreign_credit numeric(19,4) check (foreign_credit >= 0),
  add constraint journal_lines_foreign_pair
    check ((foreign_debit is null) = (foreign_credit is null));

alter table payment_applications
  add column home_amount numeric(19,4) check (home_amount >= 0);
