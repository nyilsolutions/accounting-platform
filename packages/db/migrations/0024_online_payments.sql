-- Phase 10e: customers pay invoices online through Stripe Connect (ADR 0022).
--
--   * payment_accounts: a company's connected processor account (Stripe Standard), whether it can
--     take payments, which methods it offers, and the accounts its activity is recorded to.
--   * pay_links: the links emailed to customers to pay an invoice (only a hash of the token).
--   * online_payments: each checkout started from a pay link and what became of it.
--   * processor_payouts: the processor's transfers to the bank, each recorded as one deposit.
--   * payment_events: processor webhook events already handled (they can arrive more than once).
--
-- Deposits may now carry negative lines (processor fees, refunds, chargebacks) as long as the
-- deposit's total stays positive; lines taken from Undeposited Funds stay positive.

alter table deposit_lines drop constraint deposit_lines_amount_check;
alter table deposit_lines add constraint deposit_lines_amount_check
  check (amount <> 0 and (source_txn_id is null or amount > 0));

create table payment_accounts (
  company_id             uuid primary key references companies (id) on delete cascade,
  provider               text not null check (provider in ('stripe', 'mock')),
  account_id             text not null check (length(account_id) between 1 and 255),
  status                 text not null default 'pending'
                           check (status in ('pending', 'active', 'restricted', 'disconnected')),
  charges_enabled        boolean not null default false,
  payouts_enabled        boolean not null default false,
  -- What the processor still needs from the business, in its words (shown on the settings page).
  requirements           text check (length(requirements) <= 2000),
  accept_card            boolean not null default true,
  accept_ach             boolean not null default true,
  -- Where payouts are deposited, and the accounts fees, refunds and chargebacks are recorded to.
  deposit_account_id     uuid not null,
  fee_account_id         uuid not null,
  refund_account_id      uuid not null,
  chargeback_account_id  uuid not null,
  connected_by           uuid references users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (company_id, deposit_account_id) references accounts (company_id, id),
  foreign key (company_id, fee_account_id) references accounts (company_id, id),
  foreign key (company_id, refund_account_id) references accounts (company_id, id),
  foreign key (company_id, chargeback_account_id) references accounts (company_id, id)
);
-- One company per processor account: its webhooks must name exactly one set of books.
create unique index payment_accounts_account_key on payment_accounts (provider, account_id)
  where status <> 'disconnected';
create trigger payment_accounts_touch before update on payment_accounts
  for each row execute function app_touch_updated_at();

create table pay_links (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  invoice_id  uuid not null,
  token_hash  text not null unique check (length(token_hash) = 64),
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  foreign key (company_id, invoice_id) references transactions (company_id, id)
);
create index pay_links_invoice_idx on pay_links (company_id, invoice_id);

create table online_payments (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  invoice_id         uuid not null,
  pay_link_id        uuid references pay_links (id),
  provider           text not null check (provider in ('stripe', 'mock')),
  account_id         text not null check (length(account_id) <= 255),
  session_id         text not null check (length(session_id) <= 255),
  payment_intent_id  text check (length(payment_intent_id) <= 255),
  charge_id          text check (length(charge_id) <= 255),
  method             text check (method in ('card', 'us_bank_account')),
  amount             numeric(19,4) not null check (amount > 0),
  status             text not null default 'started'
                       check (status in ('started', 'processing', 'succeeded', 'failed', 'canceled')),
  refunded           numeric(19,4) not null default 0 check (refunded >= 0),
  dispute_status     text check (dispute_status in ('open', 'won', 'lost')),
  failure_message    text check (length(failure_message) <= 1000),
  -- The Receive Payment recorded when the money succeeded.
  payment_txn_id     uuid,
  succeeded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (company_id, invoice_id) references transactions (company_id, id),
  foreign key (company_id, payment_txn_id) references transactions (company_id, id),
  check (status <> 'succeeded' or payment_txn_id is not null)
);
create unique index online_payments_session_key on online_payments (provider, session_id);
create unique index online_payments_intent_key on online_payments (provider, payment_intent_id)
  where payment_intent_id is not null;
create index online_payments_invoice_idx on online_payments (company_id, invoice_id);
create trigger online_payments_touch before update on online_payments
  for each row execute function app_touch_updated_at();

create table processor_payouts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  provider        text not null check (provider in ('stripe', 'mock')),
  payout_id       text not null check (length(payout_id) <= 255),
  amount          numeric(19,4) not null,
  arrival_date    date not null check (arrival_date between '1900-01-01' and '2199-12-31'),
  -- recorded: a deposit was made; review: something in it couldn't be matched (see message);
  -- failed: the bank returned it.
  status          text not null check (status in ('recorded', 'review', 'failed')),
  message         text check (length(message) <= 2000),
  -- What the payout contained: [{ kind, amount, fee, paymentIntentId, description }].
  items           jsonb not null default '[]',
  deposit_txn_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (company_id, deposit_txn_id) references transactions (company_id, id)
);
create unique index processor_payouts_payout_key on processor_payouts (provider, payout_id);
create index processor_payouts_company_idx on processor_payouts (company_id, arrival_date desc);
create trigger processor_payouts_touch before update on processor_payouts
  for each row execute function app_touch_updated_at();

create table payment_events (
  provider     text not null check (provider in ('stripe', 'mock')),
  event_id     text not null check (length(event_id) <= 255),
  company_id   uuid not null references companies (id) on delete cascade,
  type         text not null check (length(type) <= 100),
  received_at  timestamptz not null default now(),
  primary key (provider, event_id)
);

do $$
declare t text;
begin
  foreach t in array array['payment_accounts', 'pay_links', 'online_payments', 'processor_payouts',
                           'payment_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;
grant select, insert, update on payment_accounts, pay_links, online_payments, processor_payouts
  to acct_app;
grant select, insert on payment_events to acct_app;

-- Processor webhooks and customers' pay links arrive without a tenant context. These return the
-- company (and, for a link, the invoice) and nothing else, so the API can then work inside
-- withTenant().
create function app_payment_account_company(p_provider text, p_account_id text) returns uuid
  language sql stable security definer set search_path = public as $$
    select company_id from payment_accounts
     where provider = p_provider and account_id = p_account_id and status <> 'disconnected'
     limit 1
  $$;
revoke all on function app_payment_account_company(text, text) from public;
grant execute on function app_payment_account_company(text, text) to acct_app;

create function app_pay_link(p_token_hash text)
  returns table (link_id uuid, company_id uuid, invoice_id uuid)
  language sql stable security definer set search_path = public as $$
    select id, company_id, invoice_id from pay_links
     where token_hash = p_token_hash and revoked_at is null
  $$;
revoke all on function app_pay_link(text) from public;
grant execute on function app_pay_link(text) to acct_app;
