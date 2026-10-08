import { generateTotp } from '@acct/crypto';
import { createDb, sql, type Db } from '@acct/db';
import { PASSWORD_BREACHED, STEP_UP_REQUIRED, type SessionDto } from '@acct/shared';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CredentialCleanupService } from '../src/auth/credential-cleanup.service';
import { loadConfig } from '../src/config';
import { JobQueue } from '../src/jobs/job-queue.service';
import { agent, signUp, startApp, type Agent, type TestContext } from './helpers';

/** Authentication hardening from the ASVS Level 2 review (ADR 0029). */
let ctx: TestContext;
let admin: Db;
const PEPPER = Buffer.alloc(32, 4).toString('base64');

beforeAll(async () => {
  ctx = await startApp({ STEP_UP_MINUTES: '5', PASSWORD_PEPPER: PEPPER });
  admin = createDb(ctx.db.adminUrl, 1);
});
afterAll(async () => {
  await admin?.destroy();
  await ctx?.close();
});

const userId = async (email: string) =>
  (
    await admin
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
  ).id;
/** Lets the same TOTP step be used again (the tests run faster than 30-second steps). */
const forgetLastStep = async (email: string) =>
  admin.updateTable('users').set({ mfa_last_used_step: null }).where('email', '=', email).execute();
/** Makes the user's sessions' last MFA older than the step-up window. */
const ageMfa = async (email: string) =>
  sql`update sessions set mfa_verified_at = now() - interval '10 minutes'
      where user_id = ${await userId(email)}`.execute(admin);
/** Mail sent to someone, once queued jobs have run: security notices go through the queue. */
const mailsTo = async (to: string) => {
  await ctx.app.get(JobQueue).drain();
  return ctx.mailer.sent.filter((m) => m.to === to);
};
const code = (secret: string) => generateTotp(secret, Date.now());

async function signIn(
  email: string,
  password: string,
  secret: string,
  userAgent = 'test-browser',
): Promise<Agent> {
  const a = agent(ctx.app).set('user-agent', userAgent);
  await a.post('/auth/login').send({ email, password }).expect(200);
  await forgetLastStep(email);
  await a
    .post('/auth/mfa/verify')
    .send({ code: code(secret) })
    .expect(204);
  return a;
}

describe('lockout', () => {
  it('counts MFA failures separately: a correct password no longer clears them', async () => {
    const u = await signUp(ctx.app, 'lock-mfa@example.com');
    let locked = false;
    for (let round = 0; round < 3 && !locked; round++) {
      const a = agent(ctx.app);
      const login = await a.post('/auth/login').send({ email: u.email, password: u.password });
      if (login.status === 429) {
        locked = true;
        break;
      }
      expect(login.status).toBe(200);
      for (let i = 0; i < 4; i++) {
        const r = await a.post('/auth/mfa/verify').send({ code: '000001' });
        if (r.status === 429) {
          locked = true;
          break;
        }
        expect(r.status).toBe(401);
      }
    }
    // Ten wrong codes over three sign-ins lock the account.
    expect(locked).toBe(true);
    const row = await admin
      .selectFrom('users')
      .select(['locked_until', 'mfa_failed_count'])
      .where('email', '=', u.email)
      .executeTakeFirstOrThrow();
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect((await mailsTo(u.email)).some((m) => m.subject.startsWith('Sign-in locked'))).toBe(true);
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(429);
  });

  it('counts parallel wrong passwords one by one', async () => {
    const u = await signUp(ctx.app, 'lock-parallel@example.com');
    await Promise.all(
      Array.from({ length: 10 }, () =>
        agent(ctx.app).post('/auth/login').send({ email: u.email, password: 'wrong-password-123' }),
      ),
    );
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(429);
  });
});

describe('one-time codes', () => {
  it('refuses a code used before, records it and tells the user', async () => {
    const u = await signUp(ctx.app, 'replay@example.com');
    const used = code(u.secret);
    const a = agent(ctx.app);
    await a.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await forgetLastStep(u.email);
    await a.post('/auth/mfa/verify').send({ code: used }).expect(204);

    const b = agent(ctx.app);
    await b.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await b.post('/auth/mfa/verify').send({ code: used }).expect(401);
    const events = await admin
      .selectFrom('audit_log')
      .select('action')
      .where('actor_user_id', '=', await userId(u.email))
      .execute();
    expect(events.map((e) => e.action)).toContain('auth.totp_replayed');
    expect((await mailsTo(u.email)).some((m) => m.subject.startsWith('A used sign-in code'))).toBe(
      true,
    );
  });

  it('accepts a code once even when two requests race', async () => {
    const u = await signUp(ctx.app, 'race@example.com');
    const a = agent(ctx.app);
    const b = agent(ctx.app);
    await a.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await b.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await forgetLastStep(u.email);
    const c = code(u.secret);
    const results = await Promise.all([
      a.post('/auth/mfa/verify').send({ code: c }),
      b.post('/auth/mfa/verify').send({ code: c }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
  });

  it('makes 120-bit recovery codes; new ones replace the old after a fresh code', async () => {
    const u = await signUp(ctx.app, 'recovery@example.com');
    expect(u.recoveryCodes).toHaveLength(10);
    for (const c of u.recoveryCodes) expect(c).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);

    await ageMfa(u.email);
    const stale = await u.agent.post('/auth/mfa/recovery-codes').expect(403);
    expect(stale.body.code).toBe(STEP_UP_REQUIRED);
    await forgetLastStep(u.email);
    await u.agent
      .post('/auth/step-up')
      .send({ code: code(u.secret) })
      .expect(204);
    const fresh = await u.agent.post('/auth/mfa/recovery-codes').expect(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);

    const a = agent(ctx.app);
    await a.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await a.post('/auth/mfa/verify').send({ code: u.recoveryCodes[0] }).expect(401);
    await a.post('/auth/mfa/verify').send({ code: fresh.body.recoveryCodes[0] }).expect(204);
    const subjects = (await mailsTo(u.email)).map((m) => m.subject);
    expect(subjects.some((s) => s.startsWith('New recovery codes'))).toBe(true);
    expect(subjects.some((s) => s.startsWith('A recovery code was used'))).toBe(true);
  });
});

describe('step-up for sensitive actions', () => {
  it('asks for a fresh code to reveal an EIN, and only an authenticator code will do', async () => {
    const u = await signUp(ctx.app, 'stepup@example.com');
    const companyId = (
      await u.agent
        .post('/companies')
        .send({ legalName: 'Step Co.', ein: '12-3456789', taxForm: 'form_1120s' })
        .expect(201)
    ).body.id;
    await u.agent.post(`/companies/${companyId}/reveal-ein`).expect(200);

    await ageMfa(u.email);
    const r = await u.agent.post(`/companies/${companyId}/reveal-ein`).expect(403);
    expect(r.body).toMatchObject({ code: STEP_UP_REQUIRED });
    await u.agent.post('/auth/step-up').send({ code: u.recoveryCodes[0] }).expect(400);
    await u.agent.post('/auth/step-up').send({ code: '000000' }).expect(401);
    await forgetLastStep(u.email);
    await u.agent
      .post('/auth/step-up')
      .send({ code: code(u.secret) })
      .expect(204);
    const ein = await u.agent.post(`/companies/${companyId}/reveal-ein`).expect(200);
    expect(ein.body).toEqual({ ein: '12-3456789' });
    // Non-members still get 404, not a step-up prompt.
    const other = await signUp(ctx.app, 'stepup-other@example.com');
    await ageMfa(other.email);
    await other.agent.post(`/companies/${companyId}/reveal-ein`).expect(404);
  });
});

describe('passwords', () => {
  it('changes the password, signs out other sessions and tells the user', async () => {
    const u = await signUp(ctx.app, 'change@example.com');
    const other = await signIn(u.email, u.password, u.secret);
    const newPassword = 'a-brand-new-passphrase';

    await ageMfa(u.email);
    await u.agent
      .post('/auth/password')
      .send({ currentPassword: u.password, newPassword })
      .expect(403);
    await forgetLastStep(u.email);
    await u.agent
      .post('/auth/step-up')
      .send({ code: code(u.secret) })
      .expect(204);
    const wrong = await u.agent
      .post('/auth/password')
      .send({ currentPassword: 'not-my-password', newPassword })
      .expect(400);
    expect(wrong.body.errors[0].path).toBe('currentPassword');
    await u.agent
      .post('/auth/password')
      .send({ currentPassword: u.password, newPassword: u.password })
      .expect(400);
    await u.agent
      .post('/auth/password')
      .send({ currentPassword: u.password, newPassword })
      .expect(204);

    await other.get('/auth/me').expect(401);
    await u.agent.get('/auth/me').expect(200);
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(401);
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: newPassword })
      .expect(200);
    expect(
      (await mailsTo(u.email)).some((m) => m.subject.startsWith('Your password was changed')),
    ).toBe(true);
  });

  it('hashes with the pepper, and re-hashes older passwords at sign-in', async () => {
    const u = await signUp(ctx.app, 'pepper@example.com');
    const row = () =>
      admin
        .selectFrom('users')
        .select(['password_hash', 'password_peppered'])
        .where('email', '=', u.email)
        .executeTakeFirstOrThrow();
    expect((await row()).password_peppered).toBe(true);
    // A hash from before the pepper.
    const { hashPassword } = await import('@acct/crypto');
    await admin
      .updateTable('users')
      .set({ password_hash: await hashPassword(u.password), password_peppered: false })
      .where('email', '=', u.email)
      .execute();
    const before = (await row()).password_hash;
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(200);
    const after = await row();
    expect(after.password_peppered).toBe(true);
    expect(after.password_hash).not.toBe(before);
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(200);
  });
});

describe('sessions', () => {
  it('lists, ends one, and signs out the others', async () => {
    const u = await signUp(ctx.app, 'sessions@example.com');
    const b = await signIn(u.email, u.password, u.secret, 'second-browser');
    const c = await signIn(u.email, u.password, u.secret, 'third-browser');
    const list: SessionDto[] = (await u.agent.get('/auth/sessions').expect(200)).body;
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.map((s) => s.userAgent)).toEqual(
      expect.arrayContaining(['second-browser', 'third-browser']),
    );
    // A new browser is reported to the user.
    expect((await mailsTo(u.email)).some((m) => m.subject.startsWith('New sign-in'))).toBe(true);

    const second = list.find((s) => s.userAgent === 'second-browser')!;
    await u.agent.delete(`/auth/sessions/${second.id}`).expect(204);
    await b.get('/auth/me').expect(401);
    await c.get('/auth/me').expect(200);
    // Someone else's session can't be ended.
    const stranger = await signUp(ctx.app, 'sessions-stranger@example.com');
    const mine = list.find((s) => s.current)!;
    await stranger.agent.delete(`/auth/sessions/${mine.id}`).expect(404);

    const out = await u.agent.post('/auth/sessions/sign-out-others').expect(200);
    expect(out.body).toEqual({ signedOut: 1 });
    await c.get('/auth/me').expect(401);
    await u.agent.get('/auth/me').expect(200);
  });
});

describe('security events', () => {
  it('logs refused access, unknown sign-ins and rejected input, without values', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(function (
      this: Logger,
      m: unknown,
    ) {
      if ((this as unknown as { context?: string }).context === 'Security')
        warnings.push(String(m));
    });
    try {
      await agent(ctx.app)
        .post('/auth/login')
        .send({ email: 'nobody-here@example.com', password: 'secret-guess-123' })
        .expect(401);
      const owner = await signUp(ctx.app, 'events-owner@example.com');
      const company = (
        await owner.agent.post('/companies').send({ name: 'Events Co', legalName: 'Events Co' })
      ).body as { id: string };
      const stranger = await signUp(ctx.app, 'events-stranger@example.com');
      await stranger.agent.get(`/companies/${company.id}/accounts`).expect(404);
      await owner.agent
        .post(`/companies/${company.id}/bank-rules`)
        .send({ name: 42, conditions: 'secret-value' })
        .expect(400);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.some((w) => w.startsWith('auth.login_unknown_account'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('access.not_member'))).toBe(true);
    expect(warnings.some((w) => /^input\.rejected paths=.*name/.test(w))).toBe(true);
    const all = warnings.join('\n');
    for (const secret of ['nobody-here@example.com', 'secret-guess-123', 'secret-value'])
      expect(all).not.toContain(secret);
  });
});

describe('credential cleanup', () => {
  it('deletes sessions 30 days after they ended and keeps live ones', async () => {
    const u = await signUp(ctx.app, 'cleanup@example.com');
    const ids = await admin
      .selectFrom('sessions as s')
      .innerJoin('users as x', 'x.id', 's.user_id')
      .select('s.id')
      .where('x.email', '=', 'cleanup@example.com')
      .execute();
    expect(ids).toHaveLength(1);
    // An old session of the same person, ended 31 days ago.
    await sql`insert into sessions (user_id, token_hash, expires_at, created_at, last_seen_at)
              values (${u.userId}, 'old-session-hash', now() - interval '31 days',
                      now() - interval '40 days', now() - interval '40 days')`.execute(admin);
    const counts = await ctx.app.get(CredentialCleanupService).run();
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    const left = await admin
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', u.userId)
      .execute();
    expect(left).toEqual(ids);
    await u.agent.get('/auth/me').expect(200);
  });
});

describe('configuration', () => {
  it('limits sessions and needs a pepper and breach checks in production', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db.internal/acct?sslmode=verify-full',
      WEB_ORIGIN: 'https://books.example.com',
      COOKIE_SECURE: 'true',
      FIELD_KEY_PROVIDER: 'aws-kms',
      FIELD_KMS_KEY_ID: 'arn:aws:kms:x',
      SIGNING_KEY: PEPPER,
    };
    expect(() => loadConfig({ ...prod, SESSION_IDLE_MINUTES: '60' })).toThrow('30 minutes idle');
    expect(() => loadConfig(prod)).toThrow('PASSWORD_PEPPER is required');
    expect(() => loadConfig({ ...prod, PASSWORD_PEPPER: PEPPER })).toThrow(
      "PASSWORD_BREACH_CHECK must be 'hibp'",
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'x',
        FIELD_ENCRYPTION_KEY: PEPPER,
        PASSWORD_PEPPER: 'c2hvcnQ=',
      }),
    ).toThrow('PASSWORD_PEPPER must be 32 bytes');
    expect(PASSWORD_BREACHED).toBe('PASSWORD_BREACHED');
  });

  it('requires TLS to every service and JSON logs in production', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db.internal/acct?sslmode=verify-full',
      WEB_ORIGIN: 'https://books.example.com',
      COOKIE_SECURE: 'true',
      FIELD_KEY_PROVIDER: 'aws-kms',
      FIELD_KMS_KEY_ID: 'arn:aws:kms:x',
      SIGNING_KEY: PEPPER,
      PASSWORD_PEPPER: PEPPER,
      PASSWORD_BREACH_CHECK: 'hibp',
      MAIL_TRANSPORT: 'ses',
      MAIL_FROM: 'Books <no-reply@mail.example.com>',
      DOCUMENT_STORAGE: 's3',
      S3_BUCKET: 'docs',
      S3_SSE: 'aws:kms',
      S3_KMS_KEY_ID: 'arn:aws:kms:s3',
      VIRUS_SCANNER: 'clamd',
      BANK_FEED_PROVIDER: 'none',
      PAYMENTS_PROVIDER: 'none',
      EFTPS_BATCH_PROVIDER: 'none',
      DEPOSIT_PARTNER: 'none',
      EFILE_TRANSMITTER: 'none',
      QBO_ENVIRONMENT: 'none',
    };
    // A complete production configuration (what the ECS task definitions set, ADR 0030)...
    expect(() => loadConfig(prod)).not.toThrow();
    // ...and each unsafe change to it is refused.
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: 'file' })).toThrow(
      "MAIL_TRANSPORT must be 'ses'",
    );
    expect(() => loadConfig({ ...prod, MAIL_FROM: undefined })).toThrow('MAIL_FROM is required');
    expect(() => loadConfig({ ...prod, S3_ACCESS_KEY_ID: 'AKID' })).toThrow('or neither');
    for (const sslmode of ['', '?sslmode=require', '?sslmode=disable'])
      expect(() =>
        loadConfig({ ...prod, DATABASE_URL: `postgres://db.internal/acct${sslmode}` }),
      ).toThrow('sslmode=verify-full');
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: 'http://books.example.com' })).toThrow(
      'WEB_ORIGIN must be https',
    );
    expect(() => loadConfig({ ...prod, S3_ENDPOINT: 'http://minio:9000' })).toThrow(
      'S3_ENDPOINT must be https',
    );
    expect(() => loadConfig({ ...prod, ECB_RATES_URL: 'http://rates.example' })).toThrow(
      'ECB_RATES_URL must be https',
    );
    expect(() => loadConfig({ ...prod, CLAMD_HOST: '10.0.0.5' })).toThrow('CLAMD_HOST');
    expect(() => loadConfig({ ...prod, S3_SSE: 'AES256' })).toThrow("S3_SSE must be 'aws:kms'");
    expect(() => loadConfig({ ...prod, LOG_FORMAT: 'pretty' })).toThrow(
      "LOG_FORMAT must be 'json'",
    );
  });
});
