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
  if (config.NODE_ENV === 'production') {
    if (!config.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (['console', 'capture', 'file'].includes(config.MAIL_TRANSPORT)) {
      throw new Error('A real mail transport must be configured in production');
    }
    if (config.BANK_FEED_PROVIDER === 'mock') {
      throw new Error("BANK_FEED_PROVIDER must be 'plaid' or 'none' in production");
    }
  }
  if (config.BANK_FEED_PROVIDER === 'plaid' && (!config.PLAID_CLIENT_ID || !config.PLAID_SECRET)) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET are required when BANK_FEED_PROVIDER=plaid');
  }
  return config;
}
