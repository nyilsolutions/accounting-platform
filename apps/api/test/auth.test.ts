import { generateTotp } from '@acct/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { agent, nextCode, signUp, startApp, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startApp({ LOGIN_MAX_FAILED_ATTEMPTS: '3' });
});
afterAll(async () => {
  await ctx?.close();
});

describe('registration and MFA enrollment', () => {
  it('requires MFA enrollment before any company data is accessible', async () => {
    const a = agent(ctx.app);
    const reg = await a
      .post('/auth/register')
      .send({
        email: 'Owner@Example.com',
        fullName: 'Olivia Owner',
        password: 'a-long-enough-password',
      })
      .expect(201);
    expect(reg.body).toMatchObject({
      user: { email: 'owner@example.com' },
      mfaEnrolled: false,
      mfaVerified: false,
    });

    const cookie = reg.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const blocked = await a.get('/companies').expect(401);
    expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const setup = await a.post('/auth/mfa/setup').expect(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    await a.post('/auth/mfa/enable').send({ code: '000000' }).expect(401);
    const enable = await a
      .post('/auth/mfa/enable')
      .send({ code: generateTotp(setup.body.secret) })
      .expect(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);

    await a.get('/companies').expect(200, []);
    const me = await a.get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ mfaEnrolled: true, mfaVerified: true });
  });

  it('rejects duplicate emails and weak passwords', async () => {
    await agent(ctx.app)
      .post('/auth/register')
      .send({ email: 'owner@example.com', fullName: 'X', password: 'a-long-enough-password' })
      .expect(409);
    const weak = await agent(ctx.app)
      .post('/auth/register')
      .send({ email: 'weak@example.com', fullName: 'X', password: 'short' })
      .expect(400);
    expect(weak.body.errors[0].path).toBe('password');
  });
});

describe('sign-in', () => {
  it('requires a second factor and rejects TOTP replay', async () => {
    const u = await signUp(ctx.app, 'signin@example.com');
    const me = await u.agent.get('/auth/me').expect(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const out = await u.agent.post('/auth/logout').expect(204);
    expect(out.headers['clear-site-data']).toBe('"cache", "cookies"');
    await u.agent.get('/auth/me').expect(401);

    const a = agent(ctx.app);
    const login = await a
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(200);
    expect(login.body).toMatchObject({ mfaEnrolled: true, mfaVerified: false });
    expect((await a.get('/companies').expect(401)).body.code).toBe('MFA_REQUIRED');

    // The code used during enrollment (current step) cannot be replayed.
    await a
      .post('/auth/mfa/verify')
      .send({ code: generateTotp(u.secret) })
      .expect(401);
    await a
      .post('/auth/mfa/verify')
      .send({ code: nextCode(u.secret) })
      .expect(204);
    await a.get('/companies').expect(200);
  });

  it('accepts each recovery code once', async () => {
    const u = await signUp(ctx.app, 'recovery@example.com');
    const a1 = agent(ctx.app);
    await a1.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await a1.post('/auth/mfa/verify').send({ code: u.recoveryCodes[0]!.toLowerCase() }).expect(204);

    const a2 = agent(ctx.app);
    await a2.post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await a2.post('/auth/mfa/verify').send({ code: u.recoveryCodes[0] }).expect(401);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    const a = await agent(ctx.app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'x' })
      .expect(401);
    const b = await agent(ctx.app)
      .post('/auth/login')
      .send({ email: 'owner@example.com', password: 'wrong' })
      .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('locks the account after repeated failures', async () => {
    const u = await signUp(ctx.app, 'lockout@example.com');
    for (let i = 0; i < 3; i++) {
      await agent(ctx.app)
        .post('/auth/login')
        .send({ email: u.email, password: 'wrong-password' })
        .expect(401);
    }
    await agent(ctx.app)
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(429);
  });

  it('rotates the session token when MFA completes (no session fixation)', async () => {
    const u = await signUp(ctx.app, 'rotate@example.com');
    const a = agent(ctx.app);
    const login = await a
      .post('/auth/login')
      .send({ email: u.email, password: u.password })
      .expect(200);
    const preMfaCookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    await a
      .post('/auth/mfa/verify')
      .send({ code: nextCode(u.secret) })
      .expect(204);
    // The pre-MFA token no longer grants access.
    await request(ctx.app.getHttpServer()).get('/auth/me').set('Cookie', preMfaCookie).expect(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the CSRF header or from a foreign origin', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.co', password: 'x' })
      .expect(403);
    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .set('x-csrf-protection', '1')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@b.co', password: 'x' })
      .expect(403);
  });
});

describe('health', () => {
  it('reports database connectivity', async () => {
    await request(ctx.app.getHttpServer()).get('/health').expect(200, { status: 'ok', db: 'ok' });
  });
});
