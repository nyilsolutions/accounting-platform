import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { base32Decode, generateTotp } from '@acct/crypto';
import { createTestDatabase, type TestDatabase } from '@acct/db';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config';
import { CaptureMailer, MAILER } from '../src/mail/mailer';

export interface TestContext {
  app: INestApplication;
  db: TestDatabase;
  mailer: CaptureMailer;
  close(): Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const db = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db.appUrl,
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    COOKIE_SECURE: 'false',
    MAIL_TRANSPORT: 'capture',
    RATE_LIMIT_AUTH_PER_MINUTE: '1000',
    WEB_ORIGIN: 'http://localhost:3000',
    REPORT_SCHEDULER: 'off',
    EFILE_ACK_POLLER: 'off',
    ...overrides,
  });
  process.env.RATE_LIMIT_AUTH_PER_MINUTE = config.RATE_LIMIT_AUTH_PER_MINUTE.toString();
  const app = await createApp(config);
  await app.init();
  return {
    app,
    db,
    mailer: app.get<CaptureMailer>(MAILER),
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export type Agent = TestAgent;

/** A cookie-keeping client that sends the CSRF header on every request, like the web app. */
export function agent(app: INestApplication): Agent {
  return request.agent(app.getHttpServer()).set('x-csrf-protection', '1');
}

export interface SignedInUser {
  agent: Agent;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
  userId: string;
}

/** Registers a user and completes MFA enrollment. */
export async function signUp(
  app: INestApplication,
  email: string,
  fullName = email.split('@')[0]!,
): Promise<SignedInUser> {
  const a = agent(app);
  const password = 'correct-horse-battery-staple';
  const reg = await a.post('/auth/register').send({ email, fullName, password }).expect(201);
  const setup = await a.post('/auth/mfa/setup').expect(200);
  const secret = setup.body.secret as string;
  const enable = await a
    .post('/auth/mfa/enable')
    .send({ code: generateTotp(secret) })
    .expect(200);
  return {
    agent: a,
    email,
    password,
    secret,
    recoveryCodes: enable.body.recoveryCodes,
    userId: reg.body.user.id,
  };
}

/** A TOTP code for the next time step (a code for the current step may already have been used). */
export function nextCode(secret: string, stepsAhead = 1): string {
  base32Decode(secret);
  return generateTotp(secret, Date.now() + stepsAhead * 30_000);
}

export function inviteTokenFrom(mailer: CaptureMailer, email: string): string {
  const msg = [...mailer.sent].reverse().find((m) => m.to === email);
  const match = msg?.text.match(/\/invite\/([\w-]+)/);
  if (!match) throw new Error(`No invitation email for ${email}`);
  return match[1]!;
}
