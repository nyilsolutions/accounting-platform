import { createDb, sql, type Db } from '@acct/db';
import {
  addDays,
  todayIso,
  type AccountDto,
  type AchBatchDto,
  type EmployeeDto,
  type PaycheckDto,
  type PayrollLiabilitiesDto,
  type PayrollLiabilityPaymentDto,
  type PayrollPartnersDto,
  type PayRunDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EftpsProviderError, EFTPS_BATCH_PROVIDER } from '../src/payroll/partners/eftps-batch';
import { DepositPartnerError, DEPOSIT_PARTNER } from '../src/payroll/partners/deposit-partner';
import { PartnersPollerService } from '../src/payroll/partners/partners-poller.service';
import type { StandInDepositPartner } from '../src/payroll/partners/stand-in-deposit-partner';
import type { StandInEftpsBatch } from '../src/payroll/partners/stand-in-eftps';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let ana: EmployeeDto;
let schedule: { id: string };
let run: PayRunDto;
let eftps: StandInEftpsBatch;
let partner: StandInDepositPartner;

const c = (p: string) => `/companies/${companyId}${p}`;
const p = (path: string) => c(`/payroll${path}`);
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};
const ACCOUNT = '000987654321';
const DEBIT_ACCOUNT = '000555123456';
const tomorrow = () => addDays(todayIso(), 1);
const settings = {
  bankAccountId: '',
  achOdfiRouting: '021000021',
  achOdfiName: 'First Example Bank',
  achCompanyName: 'Corner Bakery',
};
const liability = async () => {
  const l = (await owner.agent.get(p('/liabilities')).expect(status(200)))
    .body as PayrollLiabilitiesDto;
  return l.liabilities.find((x) => x.agency === 'federal_941' && x.periodStart === '2026-01-01')!;
};
const payEftps = async (amount: string, paymentDate = tomorrow(), code = 201) => {
  const l = await liability();
  return owner.agent
    .post(p('/liabilities/payments'))
    .send({
      agency: 'federal_941',
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      paymentDate,
      amount,
      method: 'eftps',
    })
    .expect(status(code));
};

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  eftps = ctx.app.get(EFTPS_BATCH_PROVIDER);
  partner = ctx.app.get(DEPOSIT_PARTNER);
  owner = await signUp(ctx.app, 'partners-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Corner Bakery LLC', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(c('/accounts')).expect(status(200))).body;
  settings.bankAccountId = acct('Checking');
  await owner.agent.post(p('/setup')).send({}).expect(status(201));
  await owner.agent.put(p('/settings')).send(settings).expect(status(200));
  schedule = (
    await owner.agent
      .post(p('/schedules'))
      .send({
        name: 'Biweekly',
        frequency: 'biweekly',
        firstPeriodEnd: '2026-01-09',
        payDateOffset: 6,
      })
      .expect(status(201))
  ).body;
  const reg = (
    await owner.agent
      .post(p('/states'))
      .send({ state: 'TX', unemploymentAccountNumber: 'TX-1' })
      .expect(status(201))
  ).body;
  await owner.agent
    .put(p(`/states/${reg.id}/unemployment-rates`))
    .send({ year: 2026, rate: '2.7' })
    .expect(status(200));
  ana = (
    await owner.agent
      .post(p('/employees'))
      .send({
        firstName: 'Ana',
        lastName: 'Ruiz',
        ssn: '123-45-6789',
        workState: 'TX',
        hireDate: '2026-01-05',
        payType: 'hourly',
        payRate: '20',
        defaultHours: '80',
        payScheduleId: schedule.id,
        payMethod: 'direct_deposit',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(p(`/employees/${ana.id}/w4`))
    .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
    .expect(status(201));
  await owner.agent
    .put(p(`/employees/${ana.id}/bank-accounts`))
    .send({
      accounts: [
        {
          routingNumber: '021000021',
          accountNumber: ACCOUNT,
          accountType: 'checking',
          amountType: 'remainder',
        },
      ],
    })
    .expect(status(200));
  run = (
    await owner.agent
      .post(p('/pay-runs'))
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
      .expect(status(201))
  ).body;
  await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(200));
  run = (
    await owner.agent
      .post(p(`/pay-runs/${run.id}/post`))
      .send({})
      .expect(status(200))
  ).body;
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('EFTPS as batch provider (stand-in)', () => {
  it('pays in EFTPS by hand until the company is enrolled', async () => {
    const partners = (await owner.agent.get(p('/partners')).expect(status(200)))
      .body as PayrollPartnersDto;
    expect(partners).toEqual({
      eftpsProvider: { name: 'stand-in', standIn: true },
      enrollment: null,
      depositPartner: { name: 'stand-in', standIn: true },
      depositRail: 'nacha_file',
    });
    const manual = (await payEftps('1.00')).body as PayrollLiabilityPaymentDto;
    expect(manual.instructions?.[0]).toContain('In EFTPS, sign in');
    expect(manual).toMatchObject({ provider: null, eftpsStatus: null, status: 'posted' });
    await owner.agent
      .post(p(`/liabilities/payments/${manual.id}/void`))
      .send({})
      .expect(status(200));
  });

  it('enrolls the company, keeping the account number out of the audit log', async () => {
    const enroll = {
      routingNumber: '021000021',
      accountNumber: DEBIT_ACCOUNT,
      accountType: 'checking',
      authorizedName: 'Olive Owner',
      authorizedTitle: 'Owner',
      authorize: true,
    };
    let e = (await owner.agent.post(p('/eftps/enrollment')).send(enroll).expect(status(201))).body;
    expect(e).toMatchObject({ status: 'pending', accountMasked: '****3456', provider: 'stand-in' });
    expect(
      (await owner.agent.post(p('/eftps/enrollment')).send(enroll).expect(status(409))).body
        .message,
    ).toBe('An enrollment is already waiting for EFTPS.');
    // EFTPS turns it down; the payroll admins hear about it; enrolling again works.
    e = (
      await owner.agent
        .post(p('/eftps/enrollment/stand-in'))
        .send({ action: 'reject', message: 'The name does not match the EIN.' })
        .expect(status(200))
    ).body;
    expect(e).toMatchObject({ status: 'rejected', message: 'The name does not match the EIN.' });
    expect(ctx.mailer.sent.at(-1)!.subject).toBe('EFTPS enrollment not accepted');
    await owner.agent.post(p('/eftps/enrollment')).send(enroll).expect(status(201));
    e = (
      await owner.agent
        .post(p('/eftps/enrollment/stand-in'))
        .send({ action: 'enroll' })
        .expect(status(200))
    ).body;
    expect(e.status).toBe('enrolled');
    expect(ctx.mailer.sent.at(-1)!.subject).toBe('Enrolled in EFTPS');
    const stored = await sql<{
      account_enc: string;
    }>`select account_enc from eftps_enrollments`.execute(admin);
    expect(JSON.stringify(stored.rows)).not.toContain(DEBIT_ACCOUNT);
    const audit = await sql<{ after: unknown }>`
      select after from audit_log where action like 'eftps.%'`.execute(admin);
    expect(JSON.stringify(audit.rows)).not.toContain(DEBIT_ACCOUNT);
    expect(JSON.stringify(audit.rows)).not.toContain('123456789');
  });

  it('schedules a payment, books it, and records it settling', async () => {
    const owed = await liability();
    const half = (Number(owed.balance.replace('.', '')) / 2 / 100).toFixed(2);
    const paid = (await payEftps(half)).body as PayrollLiabilityPaymentDto;
    expect(paid).toMatchObject({
      status: 'posted',
      provider: 'stand-in',
      eftpsStatus: 'scheduled',
      paymentDate: tomorrow(),
    });
    expect(paid.reference).toMatch(/^27\d{13}$/);
    expect(paid.instructions).toBeUndefined();
    expect((await liability()).paid).toBe(half);
    // It can't be voided in the books while EFTPS has it; it is cancelled there instead.
    expect(
      (
        await owner.agent
          .post(p(`/liabilities/payments/${paid.id}/void`))
          .send({})
          .expect(status(409))
      ).body.message,
    ).toContain('Cancel it there');
    const settled = (
      await owner.agent
        .post(p(`/liabilities/payments/${paid.id}/stand-in`))
        .send({ action: 'settle' })
        .expect(status(200))
    ).body as PayrollLiabilityPaymentDto;
    expect(settled).toMatchObject({ eftpsStatus: 'settled', status: 'posted' });
  });

  it('voids a payment that comes back unpaid, so the tax is owed again', async () => {
    const before = await liability();
    const paid = (await payEftps('10.00')).body as PayrollLiabilityPaymentDto;
    const returned = (
      await owner.agent
        .post(p(`/liabilities/payments/${paid.id}/stand-in`))
        .send({ action: 'return', message: 'R01: Insufficient funds' })
        .expect(status(200))
    ).body as PayrollLiabilityPaymentDto;
    expect(returned).toMatchObject({
      eftpsStatus: 'returned',
      status: 'void',
      providerMessage: 'R01: Insufficient funds',
    });
    expect((await liability()).balance).toBe(before.balance);
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail.subject).toBe('A federal tax payment came back unpaid');
    expect(mail.text).toContain('shows as owed again');
  });

  it('cancels a scheduled payment, and records one EFTPS refused', async () => {
    const paid = (await payEftps('5.00')).body as PayrollLiabilityPaymentDto;
    const cancelled = (
      await owner.agent
        .post(p(`/liabilities/payments/${paid.id}/cancel-eftps`))
        .send({})
        .expect(status(200))
    ).body as PayrollLiabilityPaymentDto;
    expect(cancelled).toMatchObject({ eftpsStatus: 'cancelled', status: 'void' });
    // The stand-in only takes settlement dates after today.
    const refused = (await payEftps('5.00', todayIso())).body as PayrollLiabilityPaymentDto;
    expect(refused).toMatchObject({
      eftpsStatus: 'failed',
      status: 'void',
      providerMessage: 'The settlement date must be after today.',
    });
    eftps.failNext(new EftpsProviderError('EFTPS is closed for maintenance.'));
    expect(((await payEftps('5.00')).body as PayrollLiabilityPaymentDto).eftpsStatus).toBe(
      'failed',
    );
  });

  it('keeps a payment whose sending is unknown until someone says it never went', async () => {
    eftps.failNext(new Error('socket hang up'));
    const unknown = (await payEftps('5.00')).body as PayrollLiabilityPaymentDto;
    expect(unknown).toMatchObject({ eftpsStatus: 'sending', status: 'posted', reference: null });
    await owner.agent
      .post(p(`/liabilities/payments/${unknown.id}/not-sent`))
      .send({})
      .expect(status(409));
    await sql`update payroll_liability_payments set status_at = now() - interval '11 minutes'
               where id = ${unknown.id}`.execute(admin);
    const notSent = (
      await owner.agent
        .post(p(`/liabilities/payments/${unknown.id}/not-sent`))
        .send({})
        .expect(status(200))
    ).body as PayrollLiabilityPaymentDto;
    expect(notSent).toMatchObject({ eftpsStatus: 'failed', status: 'void' });
  });

  it('picks up answers by polling', async () => {
    const paid = (await payEftps('2.00')).body as PayrollLiabilityPaymentDto;
    const poller = ctx.app.get(PartnersPollerService);
    expect(await poller.pollAll()).toBe(0);
    eftps.decidePayment(paid.reference!, 'settled');
    expect(await poller.pollAll()).toBe(1);
    const list = (await owner.agent.get(p('/liabilities/payments')).expect(status(200)))
      .body as PayrollLiabilityPaymentDto[];
    expect(list.find((x) => x.id === paid.id)!.eftpsStatus).toBe('settled');
  });
});

describe('direct deposit through the payments partner (stand-in)', () => {
  let batch: AchBatchDto;

  it('switches the company to the partner, which replaces the NACHA file', async () => {
    await owner.agent
      .put(p('/settings'))
      .send({ ...settings, depositRail: 'partner' })
      .expect(status(200));
    expect(
      (
        await owner.agent
          .post(p(`/pay-runs/${run.id}/deposit-file`))
          .send({ effectiveDate: tomorrow() })
          .expect(status(409))
      ).body.message,
    ).toContain('Send direct deposits');
  });

  it('sends a pay run once, entry by entry', async () => {
    partner.failNext(new DepositPartnerError('The partner is not accepting batches.'));
    const failed = (
      await owner.agent
        .post(p(`/pay-runs/${run.id}/direct-deposits`))
        .send({ effectiveDate: tomorrow() })
        .expect(status(201))
    ).body as AchBatchDto;
    expect(failed).toMatchObject({
      status: 'failed',
      providerMessage: 'The partner is not accepting batches.',
    });
    batch = (
      await owner.agent
        .post(p(`/pay-runs/${run.id}/direct-deposits`))
        .send({ effectiveDate: tomorrow() })
        .expect(status(201))
    ).body;
    expect(batch).toMatchObject({
      rail: 'partner',
      provider: 'stand-in',
      status: 'submitted',
      kind: 'payroll',
      payRunId: run.id,
      fileSha256: null,
      entryCount: 1,
    });
    expect(batch.entries).toEqual([
      expect.objectContaining({
        employeeName: 'Ana Ruiz',
        accountMasked: '****4321',
        prenote: false,
        status: 'submitted',
      }),
    ]);
    expect(
      (
        await owner.agent
          .post(p(`/pay-runs/${run.id}/direct-deposits`))
          .send({ effectiveDate: tomorrow() })
          .expect(status(409))
      ).body.message,
    ).toBe("This pay run's direct deposits were already sent.");
    const audit = await sql<{ after: unknown }>`
      select after from audit_log where action like 'payroll.deposit_batch%'`.execute(admin);
    expect(JSON.stringify(audit.rows)).not.toContain(ACCOUNT);
  });

  it('flags a returned deposit: the paycheck, the account, and an email', async () => {
    const returned = (
      await owner.agent
        .post(p(`/ach-batches/${batch.id}/stand-in`))
        .send({
          action: 'return',
          entryId: batch.entries[0]!.id,
          code: 'R03',
          reason: 'No account',
        })
        .expect(status(200))
    ).body as AchBatchDto;
    expect(returned.entries[0]).toMatchObject({
      status: 'returned',
      returnCode: 'R03',
      returnReason: 'No account',
    });
    const paycheckId = batch.entries[0]!.paycheckId!;
    const pc = (await owner.agent.get(p(`/paychecks/${paycheckId}`)).expect(status(200)))
      .body as PaycheckDto;
    expect(pc.depositReturns).toEqual([
      { accountMasked: '****4321', amount: batch.totalCredit, code: 'R03', reason: 'No account' },
    ]);
    const emp = (await owner.agent.get(p(`/employees/${ana.id}`)).expect(status(200)))
      .body as EmployeeDto;
    expect(emp.bankAccounts[0]).toMatchObject({ returnReason: 'R03: No account' });
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail.subject).toBe('A direct deposit came back');
    expect(mail.text).toContain('Ana Ruiz');
    expect(mail.text).toContain('Void the paycheck and pay it again by check.');
    // The next paycheck can't go to that account until it is fixed.
    const next = (
      await owner.agent
        .post(p('/pay-runs'))
        .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-02-06' })
        .expect(status(201))
    ).body as PayRunDto;
    const problems = next.paychecks.flatMap((x) => x.problems);
    expect(problems.join(' ')).toContain(
      'A direct deposit to ****4321 (R03: No account) came back',
    );
    await owner.agent
      .post(p(`/employees/${ana.id}/bank-accounts/${emp.bankAccounts[0]!.id}/clear-return`))
      .expect(status(200));
    const again = (
      await owner.agent
        .post(p(`/pay-runs/${next.id}/recalculate`))
        .send({})
        .expect(status(200))
    ).body as PayRunDto;
    expect(again.paychecks.flatMap((x) => x.problems)).toEqual([]);
    // The partner settles the rest of the batch; the returned entry stays returned.
    const settled = (
      await owner.agent
        .post(p(`/ach-batches/${batch.id}/stand-in`))
        .send({ action: 'settle' })
        .expect(status(200))
    ).body as AchBatchDto;
    expect(settled).toMatchObject({ status: 'settled' });
    expect(settled.entries[0]!.status).toBe('returned');
  });

  it('sends prenotes through the partner', async () => {
    await owner.agent
      .put(p(`/employees/${ana.id}/bank-accounts`))
      .send({
        accounts: [
          {
            routingNumber: '021000021',
            accountNumber: '000111222333',
            accountType: 'savings',
            amountType: 'remainder',
            prenote: true,
          },
        ],
      })
      .expect(status(200));
    await owner.agent
      .post(p('/direct-deposit/prenotes'))
      .send({ effectiveDate: tomorrow() })
      .expect(status(409));
    const pre = (
      await owner.agent
        .post(p('/direct-deposit/prenotes/send'))
        .send({ effectiveDate: tomorrow() })
        .expect(status(201))
    ).body as AchBatchDto;
    expect(pre).toMatchObject({ kind: 'prenote', status: 'submitted', totalCredit: '0.00' });
    expect(pre.entries[0]).toMatchObject({
      prenote: true,
      accountMasked: '****2333',
      paycheckId: null,
    });
    const emp = (await owner.agent.get(p(`/employees/${ana.id}`)).expect(status(200)))
      .body as EmployeeDto;
    expect(emp.bankAccounts[0]).toMatchObject({ prenoteStatus: 'sent', returnedAt: null });
  });
});
