-- Phase 10d: accountant tools (ADR 0021).
--
--   * audit_reviews: the client changes (audit log entries) an accountant has marked reviewed.
--   * close_step_marks: month-end checklist steps marked done by hand, with a note.
--   * period_closes: each time a month was closed (the closing date moved to its end), by whom,
--     with the checklist as it stood.

create table audit_reviews (
  company_id   uuid not null references companies (id) on delete cascade,
  audit_id     bigint not null references audit_log (id),
  reviewed_by  uuid references users (id),
  reviewed_at  timestamptz not null default now(),
  primary key (company_id, audit_id)
);

create table close_step_marks (
  company_id  uuid not null references companies (id) on delete cascade,
  period_end  date not null check (period_end between '1900-01-01' and '2199-12-31'),
  step        text not null check (step in (
                'bank_reconciled', 'undeposited_funds', 'uncategorized', 'client_changes',
                'revaluation', 'receivables_payables')),
  note        text check (length(note) <= 1000),
  marked_by   uuid references users (id),
  marked_at   timestamptz not null default now(),
  primary key (company_id, period_end, step)
);

create table period_closes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  period_end  date not null check (period_end between '1900-01-01' and '2199-12-31'),
  note        text check (length(note) <= 1000),
  -- The checklist when the month was closed: [{ step, status, detail, markedBy, note }].
  checklist   jsonb not null,
  closed_by   uuid references users (id),
  closed_at   timestamptz not null default now()
);
create index period_closes_company_idx on period_closes (company_id, period_end desc);

do $$
declare t text;
begin
  foreach t in array array['audit_reviews', 'close_step_marks', 'period_closes']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (company_id = app_current_company_id()) with check (company_id = app_current_company_id())',
      t || '_tenant', t);
  end loop;
end $$;
grant select, insert, delete on audit_reviews, close_step_marks to acct_app;
grant update on close_step_marks to acct_app;
-- Closes are history: added, never changed.
grant select, insert on period_closes to acct_app;
