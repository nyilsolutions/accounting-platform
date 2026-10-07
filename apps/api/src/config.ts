import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 7)
    .default(12),
  COOKIE_SECURE: bool.default(true),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  INVITATION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // Development transports only; production requires a real provider (added with Phase 2 email).
  MAIL_TRANSPORT: z.enum(['console', 'capture', 'file']).default('console'),
  MAIL_OUTBOX_DIR: z.string().default('.outbox'),
  APP_NAME: z.string().default('Accounting Platform'),
  /** Express "trust proxy" setting; the web app proxies /api to us from localhost. */
  TRUST_PROXY: z.string().default('loopback'),
  /** Bank feeds: 'plaid' (live), 'mock' (development and tests) or 'none' (file import only). */
  BANK_FEED_PROVIDER: z.enum(['plaid', 'mock', 'none']).default('mock'),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Public URL Plaid posts webhooks to (…/api/webhooks/plaid). Without it, sync is manual. */
  PLAID_WEBHOOK_URL: z.url().optional(),

  // Documents (Phase 5)
  /** 'local' (encrypted files on disk; development and tests) or 's3' (any S3-compatible store). */
  DOCUMENT_STORAGE: z.enum(['local', 's3']).default('local'),
  DOCUMENT_STORAGE_DIR: z.string().default('.documents'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  /** For MinIO, Cloudflare R2 and others; omit for AWS. */
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Server-side encryption: 'AES256' (S3-managed keys) or 'aws:kms' (with S3_KMS_KEY_ID). */
  S3_SSE: z.enum(['AES256', 'aws:kms']).default('AES256'),
  S3_KMS_KEY_ID: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  /** 'clamd' (ClamAV daemon), 'dev' (flags the EICAR test file only) or 'none'. */
  VIRUS_SCANNER: z.enum(['clamd', 'dev', 'none']).default('dev'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  /** Receipt reading: 'anthropic' (Claude), 'heuristic' (text-based PDFs only) or 'none'. */
  DOCUMENT_AI: z.enum(['anthropic', 'heuristic', 'none']).default('heuristic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  DOCUMENT_AI_MODEL: z.string().default('claude-opus-5-5'),
  /** Email-in: addresses are <token>@INBOUND_EMAIL_DOMAIN; the provider signs each message. */
  INBOUND_EMAIL_DOMAIN: z.string().optional(),
  INBOUND_EMAIL_SECRET: z.string().min(32).optional(),

  // QuickBooks migration (Phase 6)
  /** QuickBooks Online: 'sandbox' or 'production' (Intuit), 'mock' (a demo company; development and tests) or 'none'. */
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production', 'mock', 'none']).default('mock'),
  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  /** Must be registered on the Intuit app; defaults to WEB_ORIGIN/api/migration/qbo/callback. */
  QBO_REDIRECT_URI: z.url().optional(),
  QBO_MINOR_VERSION: z.coerce.number().int().min(1).default(75),
  /** Days a Desktop agent pairing key stays valid. */
  MIGRATION_AGENT_KEY_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // Multi-currency (Phase 10c)
  /** Exchange rates: 'ecb' (the European Central Bank's daily reference rates) or 'none'. */
  EXCHANGE_RATE_PROVIDER: z.enum(['ecb', 'none']).default('ecb'),
  ECB_RATES_URL: z.url().default('https://www.ecb.europa.eu/stats/eurofxref'),
  // Online payments (Phase 10e)
  /**
   * Customers pay invoices online: 'stripe' (Stripe Connect, Standard accounts), 'mock' (the
   * stand-in for development, tests and demos) or 'none'.
   */
  PAYMENTS_PROVIDER: z.enum(['stripe', 'mock', 'none']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Signing secret of the platform's Connect webhook endpoint (…/api/webhooks/payments/stripe). */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Pins Stripe's API version; unset uses the platform account's default. */
  STRIPE_API_VERSION: z.string().optional(),
  /**
   * Electronic filing (ADR 0024): 'stand-in' (plays the IRS; development, tests and demos) or
   * 'none'. The IRS MeF and IRIS transmitters are added once the platform's ETIN and TCC exist.
   */
  EFILE_TRANSMITTER: z.enum(['stand-in', 'none']).default('stand-in'),
  /**
   * EFTPS batch payments (ADR 0025): 'stand-in' (plays EFTPS; development, tests and demos) or
   * 'none' (companies pay in EFTPS by hand). The real provider comes with the Treasury enrollment.
   */
  EFTPS_BATCH_PROVIDER: z.enum(['stand-in', 'none']).default('stand-in'),
  /** Direct deposit through a payments partner (ADR 0025): 'stand-in' or 'none'. */
  DEPOSIT_PARTNER: z.enum(['stand-in', 'none']).default('stand-in'),
  /**
   * State and local payroll taxes outside the built-in engine's states (ADR 0026): 'none' (such
   * paychecks are refused with the reason) or 'test-fixture' (figures programmed by each test;
   * NODE_ENV=test only). A licensed engine is added here once one is contracted.
   */
  PAYROLL_TAX_ENGINE: z.enum(['none', 'test-fixture']).default('none'),
  /**
   * Logs (ADR 0027): 'json' (one object per line, the default in production) or 'pretty'
   * (development). Both are redacted.
   */
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  LOG_LEVEL: z.enum(['debug', 'log', 'warn', 'error']).default('log'),
  /**
   * Background jobs (ADR 0027): 'pg-boss' (a queue in Postgres; run `pnpm db:migrate` to install
   * it) or 'inline' (jobs run in this process as soon as they are sent; tests only).
   */
  JOB_QUEUE: z.enum(['pg-boss', 'inline']).default('pg-boss'),
  /**
   * Whether this process runs queued and scheduled jobs. 'on' suits one-process development;
   * in production the API runs with 'off' and the `worker` process runs them.
   */
  JOB_WORKER: z.enum(['on', 'off']).default('on'),
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.JOB_QUEUE === 'inline' && config.NODE_ENV !== 'test') {
    // Inline jobs are lost if the process stops: only for tests.
    throw new Error("JOB_QUEUE 'inline' is only for tests (NODE_ENV=test)");
  }
  if (config.PAYROLL_TAX_ENGINE === 'test-fixture' && config.NODE_ENV !== 'test') {
    // Its figures aren't tax law: they must never reach a real paycheck.
    throw new Error("PAYROLL_TAX_ENGINE 'test-fixture' is only for tests (NODE_ENV=test)");
  }
  if (config.NODE_ENV === 'production') {
    if (!config.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (['console', 'capture', 'file'].includes(config.MAIL_TRANSPORT)) {
      throw new Error('A real mail transport must be configured in production');
    }
    if (config.DOCUMENT_STORAGE !== 's3') {
      throw new Error("DOCUMENT_STORAGE must be 's3' in production");
    }
    if (config.VIRUS_SCANNER !== 'clamd') {
      throw new Error("VIRUS_SCANNER must be 'clamd' in production");
    }
    if (config.BANK_FEED_PROVIDER === 'mock') {
      throw new Error("BANK_FEED_PROVIDER must be 'plaid' or 'none' in production");
    }
    if (config.PAYMENTS_PROVIDER === 'mock') {
      throw new Error("PAYMENTS_PROVIDER must be 'stripe' or 'none' in production");
    }
    if (config.EFTPS_BATCH_PROVIDER === 'stand-in' || config.DEPOSIT_PARTNER === 'stand-in') {
      throw new Error(
        "EFTPS_BATCH_PROVIDER and DEPOSIT_PARTNER must be 'none' in production until real ones exist",
      );
    }
    if (config.EFILE_TRANSMITTER === 'stand-in') {
      throw new Error(
        "EFILE_TRANSMITTER must be 'none' in production until a real transmitter exists",
      );
    }
    if (config.QBO_ENVIRONMENT === 'mock') {
      throw new Error("QBO_ENVIRONMENT must be 'production', 'sandbox' or 'none' in production");
    }
  }
  if (
    config.PAYMENTS_PROVIDER === 'stripe' &&
    (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET)
  ) {
    throw new Error(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when PAYMENTS_PROVIDER=stripe',
    );
  }
  if (config.BANK_FEED_PROVIDER === 'plaid' && (!config.PLAID_CLIENT_ID || !config.PLAID_SECRET)) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET are required when BANK_FEED_PROVIDER=plaid');
  }
  if (
    config.DOCUMENT_STORAGE === 's3' &&
    (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for S3 storage',
    );
  }
  if (config.DOCUMENT_AI === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required when DOCUMENT_AI=anthropic');
  }
  if (
    (config.QBO_ENVIRONMENT === 'sandbox' || config.QBO_ENVIRONMENT === 'production') &&
    (!config.QBO_CLIENT_ID || !config.QBO_CLIENT_SECRET)
  ) {
    throw new Error('QBO_CLIENT_ID and QBO_CLIENT_SECRET are required for QuickBooks Online');
  }
  if (config.INBOUND_EMAIL_DOMAIN && !config.INBOUND_EMAIL_SECRET) {
    throw new Error('INBOUND_EMAIL_SECRET is required when INBOUND_EMAIL_DOMAIN is set');
  }
  return config;
}
