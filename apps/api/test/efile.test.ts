import { createDb, sql, type Db } from '@acct/db';
import type {
  AccountDto,
  EfileReturnStatusDto,
  EfileSubmissionDto,
  FederalQuarterDto,
  TaxFilingDto,
  Vendor1099SummaryDto,
} from '@acct/shared';
import { todayIso } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EfileService } from '../src/efile/efile.service';
import { EFILE_TRANSMITTER, EfileTransmitError } from '../src/efile/transmitters/efile-transmitter';
import type { StandInTransmitter } from '../src/efile/transmitters/stand-in.transmitter';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let standIn: StandInTransmitter;

const c = (p: string) => `/companies/${companyId}${p}`;
const e = (p: string) => c(`/payroll/efile${p}`);
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};
const signer = { name: 'Olive Owner', title: 'Owner', phone: '(512) 555-0100' };
const send941 = (quarter: number, code = 201) =>
  owner.agent
    .post(e('/submissions'))
    .send({ form: 'form_941', taxYear: 2026, quarter, signer, attest: true })
    .expect(status(code));
const return941 = async (quarter: number) =>
  (
    await owner.agent
      .get(e(`/return?form=form_941&year=2026&quarter=${quarter}`))
      .expect(status(200))
  ).body as EfileReturnStatusDto;

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  standIn = ctx.app.get(EFILE_TRANSMITTER);
  owner = await signUp(ctx.app, 'efile-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Corner Bakery LLC', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(c('/accounts')).expect(status(200))).body;

  // Payroll: one Texas employee, one pay run in Q1 2026.
  const p = (path: string) => c(`/payroll${path}`);
  await owner.agent.post(p('/setup')).send({}).expect(status(201));
  await owner.agent
    .put(p('/settings'))
    .send({
      bankAccountId: acct('Checking'),
      achOdfiRouting: '021000021',
      achOdfiName: 'First Example Bank',
      achCompanyName: 'Corner Bakery',
    })
    .expect(status(200));
  const schedule = (
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
  const ana = (
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
        payMethod: 'check',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(p(`/employees/${ana.id}/w4`))
    .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
    .expect(status(201));
  const run = (
    await owner.agent
      .post(p('/pay-runs'))
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
      .expect(status(201))
  ).body;
  await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(200));
  await owner.agent
    .post(p(`/pay-runs/${run.id}/post`))
    .send({})
    .expect(status(200));
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('e-filing Form 941 and 940 (stand-in)', () => {
  it('lists what must be fixed before a return can be sent', async () => {
    const s = await return941(1);
    expect(s.transmitter).toEqual({ name: 'stand-in', environment: 'production', standIn: true });
    expect(s.filed).toBe(false);
    expect(s.problems).toEqual(["Add the company's full address in Company settings."]);
    expect(s.suggestedSigner).toMatchObject({
      name: 'Olive Owner',
      email: 'efile-owner@example.com',
    });
    const q4 = await return941(4);
    expect(q4.problems).toContain("Q4 2026 isn't over yet.");
    const futa = (await owner.agent.get(e('/return?form=form_940&year=2026')).expect(status(200)))
      .body as EfileReturnStatusDto;
    expect(futa.problems).toContain("2026 isn't over yet.");
    const refused = await send941(1, 409);
    expect(refused.body.message).toContain('Fix these before sending Form 941 for Q1 2026');
    // The signer must confirm, and a quarter is needed.
    await owner.agent
      .post(e('/submissions'))
      .send({ form: 'form_941', taxYear: 2026, quarter: 1, signer, attest: false })
      .expect(status(400));
    // Forms 1099 aren't sent from payroll.
    await owner.agent
      .post(e('/submissions'))
      .send({ form: 'form_1099', taxYear: 2025, signer, attest: true })
      .expect(status(400));
  });

  it('sends a return, shows the rejection, sends it again and records the accepted filing', async () => {
    await owner.agent
      .patch(c(''))
      .send({ addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' })
      .expect(status(200));
    const first = (await send941(1)).body as EfileSubmissionDto;
    expect(first).toMatchObject({
      form: 'form_941',
      label: 'Form 941 for Q1 2026',
      channel: 'mef',
      status: 'transmitted',
      transmitter: 'stand-in',
      signer: { name: 'Olive Owner', title: 'Owner', phone: '(512) 555-0100' },
      createdByName: 'Olive Owner',
      resendsId: null,
    });
    expect(first.submissionId).toMatch(/^SI[0-9A-Z]{14}$/);
    expect(standIn.holding().get(first.submissionId!)).toBe('form_941 2026 Q1');
    // One in flight at a time; it can't be marked filed by hand meanwhile.
    expect((await send941(1, 409)).body.message).toContain('already sent');
    const marked = await owner.agent
      .post(c('/payroll/forms/filings'))
      .send({
        form: 'form_941',
        taxYear: 2026,
        quarter: 1,
        filedOn: todayIso(),
        method: 'electronic',
      })
      .expect(status(409));
    expect(marked.body.message).toContain("waiting for the IRS's answer");

    // The IRS (the stand-in) rejects it.
    const rejected = (
      await owner.agent
        .post(e(`/submissions/${first.id}/stand-in`))
        .send({
          action: 'reject',
          errors: [{ code: 'SI-0001', message: 'The name control does not match the EIN.' }],
        })
        .expect(status(200))
    ).body as EfileSubmissionDto;
    expect(rejected).toMatchObject({
      status: 'rejected',
      errors: [
        { code: 'SI-0001', message: 'The name control does not match the EIN.', field: null },
      ],
      filingId: null,
    });
    expect(rejected.acknowledgedAt).not.toBeNull();
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail.to).toBe('efile-owner@example.com');
    expect(mail.subject).toBe('Form 941 for Q1 2026: rejected by the IRS');
    expect(mail.text).toContain('SI-0001: The name control does not match the EIN.');
    expect((await return941(1)).problems).toEqual([]);

    // Sent again, it is linked to the rejected one; accepted, it records the filing.
    const again = (await send941(1)).body as EfileSubmissionDto;
    expect(again.resendsId).toBe(first.id);
    const accepted = (
      await owner.agent
        .post(e(`/submissions/${again.id}/stand-in`))
        .send({ action: 'accept' })
        .expect(status(200))
    ).body as EfileSubmissionDto;
    expect(accepted.status).toBe('accepted');
    expect(accepted.filingId).not.toBeNull();
    expect(ctx.mailer.sent.at(-1)!.subject).toBe('Form 941 for Q1 2026: accepted by the IRS');
    const form = (
      await owner.agent
        .get(c('/payroll/forms/federal-quarterly?year=2026&quarter=1'))
        .expect(status(200))
    ).body as FederalQuarterDto;
    expect(form.filing).toMatchObject({
      id: accepted.filingId,
      method: 'electronic',
      confirmation: again.submissionId,
      filedOn: todayIso(),
      status: 'filed',
      efiled: true,
    });
    expect(form.changedSinceFiled).toEqual([]);
    const s = await return941(1);
    expect(s.filed).toBe(true);
    expect(s.submissions.map((x) => x.status)).toEqual(['accepted', 'rejected']);
    expect((await send941(1, 409)).body.message).toBe('Form 941 for Q1 2026 is already filed.');
    // The IRS accepted it: its filing record can't be voided.
    const voided = await owner.agent
      .post(c(`/payroll/forms/filings/${accepted.filingId}/void`))
      .expect(status(409));
    expect(voided.body.message).toContain('The IRS accepted this return electronically');
    // The payroll list shows the submissions.
    const list = (await owner.agent.get(e('/submissions?year=2026')).expect(status(200)))
      .body as EfileSubmissionDto[];
    expect(list.map((x) => x.id)).toEqual([again.id, first.id]);
  });

  it('keeps the EIN and SSNs out of what it stores and audits', async () => {
    const rows = await sql<{ snapshot: unknown; signer: unknown }>`
      select snapshot, signer from efile_submissions`.execute(admin);
    const audits = await sql<{ after: unknown }>`
      select after from audit_log where action like 'efile.%'`.execute(admin);
    const text = JSON.stringify([rows.rows, audits.rows]);
    for (const secret of ['123456789', '123-45-6789', '12-3456789'])
      expect(text).not.toContain(secret);
    expect(audits.rows.length).toBeGreaterThanOrEqual(6);
  });

  it("records a return that never reached the IRS, and one whose sending isn't known", async () => {
    standIn.failNext(new EfileTransmitError('The transmitter refused the connection.'));
    const failed = (await send941(2)).body as EfileSubmissionDto;
    expect(failed).toMatchObject({
      status: 'failed',
      submissionId: null,
      failureMessage: 'The transmitter refused the connection.',
    });
    standIn.failNext(new Error('socket hang up'));
    const unknown = (await send941(2)).body as EfileSubmissionDto;
    expect(unknown.status).toBe('sending');
    // It may have reached the IRS: it blocks sending again until someone says it didn't.
    expect((await send941(2, 409)).body.message).toContain('already sent');
    await owner.agent.post(e(`/submissions/${unknown.id}/not-sent`)).expect(status(409));
    await sql`update efile_submissions set transmitted_at = now() - interval '11 minutes'
               where id = ${unknown.id}`.execute(admin);
    const notSent = (
      await owner.agent.post(e(`/submissions/${unknown.id}/not-sent`)).expect(status(200))
    ).body as EfileSubmissionDto;
    expect(notSent).toMatchObject({ status: 'failed' });
    expect((await send941(2)).body.status).toBe('transmitted');
  });

  it('collects acknowledgements by polling', async () => {
    const sent = (await send941(3)).body as EfileSubmissionDto;
    const service = ctx.app.get(EfileService);
    expect(await service.pollAll()).toBe(0);
    standIn.decide(sent.submissionId!, { status: 'accepted', errors: [] });
    expect(await service.pollAll()).toBe(1);
    const s = await return941(3);
    expect(s.filed).toBe(true);
    expect(s.submissions[0]!.status).toBe('accepted');
    // "Check now" asks for this company's returns (Q2 is still waiting).
    const checked = (await owner.agent.post(e('/check')).expect(status(200)))
      .body as EfileSubmissionDto[];
    expect(checked.filter((x) => x.status === 'transmitted').map((x) => x.label)).toEqual([
      'Form 941 for Q2 2026',
    ]);
  });
});

describe('Forms 1099 (IRIS)', () => {
  let joe: string;
  let ivy: string;
  const send1099 = (code = 201) =>
    owner.agent
      .post(c('/1099/efile/submissions'))
      .send({ form: 'form_1099', taxYear: 2025, signer, attest: true })
      .expect(status(code));

  beforeAll(async () => {
    const vendor = (body: Record<string, unknown>) =>
      owner.agent
        .post(c('/vendors'))
        .send({ is1099: true, ...body })
        .expect(status(201));
    joe = (
      await vendor({
        displayName: 'Joe Plumbing',
        tinType: 'ssn',
        tin: '123-45-6789',
        addressLine1: '5 Pipe St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      })
    ).body.id;
    ivy = (await vendor({ displayName: 'Ivy Design' })).body.id;
    await owner.agent
      .put(c('/1099/mappings'))
      .send({ mappings: [{ accountId: acct('Contract Labor'), box: 'nec_1' }] })
      .expect(status(200));
    for (const [vendorId, amount] of [
      [joe, '1000'],
      [ivy, '700'],
    ])
      await owner.agent
        .post(c('/purchases/checks'))
        .send({
          vendorId,
          txnDate: '2025-06-01',
          paymentAccountId: acct('Checking'),
          lines: [{ accountId: acct('Contract Labor'), amount }],
        })
        .expect(status(201));
  });

  it("needs each recipient's TIN and address, then files through IRIS", async () => {
    const before = (await owner.agent.get(c('/1099/efile?year=2025')).expect(status(200)))
      .body as EfileReturnStatusDto;
    expect(before.problems).toEqual([
      'Ivy Design has no taxpayer identification number.',
      'Ivy Design has no complete address.',
    ]);
    await send1099(409);
    await owner.agent
      .patch(c(`/vendors/${ivy}`))
      .send({
        displayName: 'Ivy Design',
        is1099: true,
        tinType: 'ein',
        tin: '98-7654321',
        addressLine1: '9 Oak Ave',
        city: 'Dallas',
        state: 'TX',
        postalCode: '75201',
      })
      .expect(status(200));
    const sent = (await send1099()).body as EfileSubmissionDto;
    expect(sent).toMatchObject({
      channel: 'iris',
      label: 'Forms 1099 for 2025',
      status: 'transmitted',
    });
    // Payroll's routes don't reach Forms 1099.
    await owner.agent
      .post(e(`/submissions/${sent.id}/stand-in`))
      .send({ action: 'accept' })
      .expect(status(404));
    await owner.agent
      .post(c(`/1099/efile/submissions/${sent.id}/stand-in`))
      .send({ action: 'accept' })
      .expect(status(200));
    const summary = (await owner.agent.get(c('/1099/summary?year=2025')).expect(status(200)))
      .body as Vendor1099SummaryDto;
    expect(summary.filing).toMatchObject({
      form: 'form_1099',
      method: 'electronic',
      label: 'Forms 1099 for 2025',
    });
    expect(summary.changedSinceFiled).toEqual([]);
    // A later payment shows as a change needing a correction.
    await owner.agent
      .post(c('/purchases/checks'))
      .send({
        vendorId: joe,
        txnDate: '2025-12-30',
        paymentAccountId: acct('Checking'),
        lines: [{ accountId: acct('Contract Labor'), amount: '50' }],
      })
      .expect(status(201));
    const later = (await owner.agent.get(c('/1099/summary?year=2025')).expect(status(200)))
      .body as Vendor1099SummaryDto;
    expect(later.changedSinceFiled).toEqual([
      'vendors › Joe Plumbing › boxes › nec_1: filed 1000.00, now 1050.00',
      'vendors › Joe Plumbing › total: filed 1000.00, now 1050.00',
    ]);
    // 1099 filings stay out of payroll's list and routes.
    const payroll = (await owner.agent.get(c('/payroll/forms/filings')).expect(status(200)))
      .body as TaxFilingDto[];
    expect(payroll.map((f) => f.form)).toEqual(['form_941', 'form_941']);
    await owner.agent
      .post(c(`/payroll/forms/filings/${summary.filing!.id}/void`))
      .expect(status(404));
    await owner.agent
      .post(c('/payroll/forms/filings'))
      .send({ form: 'form_1099', taxYear: 2024, filedOn: '2025-01-31', method: 'paper' })
      .expect(status(409));
    // Marked filed by hand from the 1099 page (an earlier year, on paper), and voided there.
    const paper = (
      await owner.agent
        .post(c('/1099/filings'))
        .send({ form: 'form_1099', taxYear: 2024, filedOn: '2025-01-31', method: 'paper' })
        .expect(status(201))
    ).body as TaxFilingDto;
    await owner.agent.post(c(`/1099/filings/${paper.id}/void`)).expect(status(200));
  });
});

describe('without a transmitter', () => {
  it('says electronic filing is not set up', async () => {
    const other = await startApp({ EFILE_TRANSMITTER: 'none' });
    try {
      const o = await signUp(other.app, 'none-owner@example.com', 'Nia Owner');
      const id = (
        await o.agent
          .post('/companies')
          .send({ legalName: 'No Efile Co', taxForm: 'form_1120s' })
          .expect(status(201))
      ).body.id;
      const s = (await o.agent.get(`/companies/${id}/1099/efile?year=2025`).expect(status(200)))
        .body as EfileReturnStatusDto;
      expect(s).toMatchObject({ transmitter: null, problems: [] });
      const r = await o.agent
        .post(`/companies/${id}/1099/efile/submissions`)
        .send({ form: 'form_1099', taxYear: 2025, signer, attest: true })
        .expect(status(409));
      expect(r.body.message).toBe("Electronic filing isn't set up on this platform yet.");
    } finally {
      await other.close();
    }
  });
});
