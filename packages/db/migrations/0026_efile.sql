-- Phase 11a: electronic filing (ADR 0024). Returns are sent to a transmitter (IRS MeF for Forms
-- 941 and 940, IRS IRIS for Forms 1099) through the EfileTransmitter interface; until the
-- platform holds IRS credentials a stand-in plays the IRS. Each send is a submission that waits
-- for its acknowledgement: accepted (which records the filing) or rejected (fix and send again).
-- A submission is written as 'sending' and committed before the transmitter is called, so a
-- return that may have reached the IRS is never lost track of.

-- Forms 1099 get a filing record like the payroll forms (Phase 9).
alter table tax_filings drop constraint tax_filings_form_check;
alter table tax_filings add constraint tax_filings_form_check
  check (form in ('form_941', 'form_940', 'w2', 'state_quarterly', 'form_1099'));

create table efile_submissions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  -- mef: IRS Modernized e-File (Forms 941 and 940); iris: IRS IRIS (Forms 1099)
  channel            text not null check (channel in ('mef', 'iris')),
  form               text not null check (form in ('form_941', 'form_940', 'form_1099')),
  tax_year           smallint not null check (tax_year between 2000 and 2199),
  quarter            smallint check (quarter between 1 and 4),
  -- The transmitter that sent it ('stand-in' until the platform's own is approved) and where:
  -- 'test' (the IRS's Assurance Testing System) or 'production'.
  transmitter        text not null check (length(transmitter) between 1 and 40),
  environment        text not null check (environment in ('test', 'production')),
  -- sending: handed to the transmitter, no answer yet; transmitted: received, waiting for the
  -- acknowledgement; failed: never reached the IRS.
  status             text not null default 'sending'
                     check (status in ('sending', 'transmitted', 'accepted', 'rejected', 'failed')),
  -- The transmitter's id for it (the IRS submission id); null until it is received.
  submission_id      text check (length(submission_id) between 1 and 60),
  -- Who signs (Forms 941 and 940) or is the contact (Forms 1099): name, title, phone, email.
  signer             jsonb not null,
  -- The figures as sent: no SSNs, EINs or TINs (the transmitter builds those in at sending).
  snapshot           jsonb not null,
  -- The acknowledgement's errors: [{ code, message, field }].
  errors             jsonb not null default '[]',
  failure_message    text check (length(failure_message) <= 500),
  -- The submission this one corrects and sends again after a rejection.
  resends_id         uuid,
  -- The filing record an accepted submission created.
  filing_id          uuid,
  created_by         uuid references users (id),
  -- When it was handed to the transmitter.
  transmitted_at     timestamptz not null default now(),
  acknowledged_at    timestamptz,
  unique (company_id, id),
  foreign key (company_id, resends_id) references efile_submissions (company_id, id),
  foreign key (company_id, filing_id) references tax_filings (company_id, id),
  check ((form = 'form_941') = (quarter is not null)),
  check ((form = 'form_1099') = (channel = 'iris')),
  check ((status in ('sending', 'failed')) = (submission_id is null)),
  check ((status in ('accepted', 'rejected')) = (acknowledged_at is not null)),
  -- Accepted in production records the filing; the IRS's test system (ATS) files nothing.
  check (status <> 'accepted' or (filing_id is not null) = (environment = 'production')),
  check (status <> 'failed' or failure_message is not null)
);
-- One return in flight per form and period.
create unique index efile_submissions_one_open on efile_submissions
  (company_id, form, tax_year, coalesce(quarter, 0))
  where status in ('sending', 'transmitted');
create unique index efile_submissions_submission_id on efile_submissions
  (transmitter, environment, submission_id)
  where submission_id is not null;
create index efile_submissions_company on efile_submissions (company_id, tax_year, form);

alter table efile_submissions enable row level security;
create policy efile_submissions_tenant on efile_submissions for all
  using (company_id = app_current_company_id())
  with check (company_id = app_current_company_id());
-- Submissions are recorded and acknowledged, never deleted.
grant select, insert, update on efile_submissions to acct_app;

-- The acknowledgement poller runs outside any company: it finds what is waiting (ids only),
-- then works inside each company with withTenant().
create function app_efile_waiting(p_transmitter text, p_environment text)
  returns table (company_id uuid, id uuid, submission_id text)
  language sql stable security definer set search_path = public as $$
    select company_id, id, submission_id from efile_submissions
     where status = 'transmitted' and transmitter = p_transmitter
       and environment = p_environment
     order by transmitted_at
     limit 500
  $$;
revoke all on function app_efile_waiting(text, text) from public;
grant execute on function app_efile_waiting(text, text) to acct_app;
