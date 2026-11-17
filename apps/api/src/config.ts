import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  /** Optional. Without it the API boots with in-memory repositories (development only). */
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  OTP_PEPPER: z.string().min(8).default('dev-otp-pepper-change-me'),
  /** HS256 key for short-lived access tokens. Must be rotated per environment. */
  JWT_SECRET: z.string().min(16).default('dev-jwt-secret-change-me-please'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /**
   * How often the expiry sweeper runs (task G-02). Reservations hold a lot for 30 minutes, so a
   * 30-second cadence keeps the "expired but still reserved" window short without load.
   */
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  TOKEN_ISSUER: z.string().default('benzin'),
  SESSION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .default(60 * 24 * 30),
  /** Comma separated list of allowed browser origins for the SPA clients. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /**
   * SMS provider chain (decision D3): comma separated, first entry is primary, the rest are
   * failover. `console` writes to the log so development and CI need no account.
   */
  SMS_PROVIDERS: z
    .string()
    .default('console')
    .transform((value) =>
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  /** SMS.ir (primary in D3). */
  SMS_API_KEY: z.string().min(8).optional(),
  SMS_SENDER_LINE: z.string().min(3).optional(),
  SMS_IR_BASE_URL: z.string().url().default('https://api.sms.ir'),
  /**
   * Approved OTP template on SMS.ir (`POST /v1/send/verify`). When unset, codes leave as free text;
   * a template is cheaper and reaches numbers that blocked promotional SMS (A36 / task E1-09).
   */
  SMS_IR_TEMPLATE_ID: z.coerce.number().int().positive().optional(),
  SMS_IR_TEMPLATE_PARAMETER: z.string().min(1).default('code'),
  /** Kavenegar (failover in D3). */
  KAVENEGAR_API_KEY: z.string().min(8).optional(),
  KAVENEGAR_SENDER_LINE: z.string().min(3).optional(),
  KAVENEGAR_BASE_URL: z.string().url().default('https://api.kavenegar.com'),
  /** Kavenegar template name used by `verify/lookup`; unset means codes travel as free text. */
  KAVENEGAR_TEMPLATE: z.string().min(1).optional(),
  /** Free-text OTP body, used by providers without a template; `{code}` is mandatory. */
  SMS_OTP_MESSAGE: z.string().min(5).default('کد ورود شما به بنزین: {code}'),
  SMS_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  /** `sandbox` approves payments locally; `zarinpal` calls the real bank gateway. */
  PAYMENT_GATEWAY: z.enum(['sandbox', 'zarinpal']).default('sandbox'),
  ZARINPAL_MERCHANT_ID: z.string().min(8).optional(),
  ZARINPAL_BASE_URL: z.string().url().default('https://payment.zarinpal.com'),
  PAYMENT_CALLBACK_URL: z.string().url().default('https://app.benzin.ir/payments/callback'),
  /**
   * G-12 — where the *browser* is sent after the gateway callback. The callback itself is a GET
   * from Zarinpal's redirect, so it must be a public HTTPS address; the key never lives here.
   */
  PAYMENT_RETURN_URL: z.string().url().default('https://app.benzin.ir/plans'),
  /**
   * G-11 — shared secret for the deposit webhook (`x-benzin-signature: sha256=<hmac>`).
   * Empty in development: the route then refuses every call, which is the safe default — an
   * unauthenticated money endpoint must never be open by accident.
   */
  CARD_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Reported on the admin status screen (task E8-08). */
  APP_VERSION: z.string().default('0.1.0'),
  /**
   * Node identity for the live node monitor (task G-28). `helper` means "park my sweeps until the
   * primary stops reporting": this is how the owner's own machine stands by without interfering.
   */
  NODE_ROLE: z.enum(['primary', 'helper']).default('primary'),
  /** Stable id for the heartbeat row; defaults to `<role>-<hostname>` at boot. */
  NODE_ID: z.string().min(3).max(64).optional(),
  NODE_NAME: z.string().min(1).max(64).optional(),
  NODE_REGION: z.string().min(1).max(64).optional(),
  /** Shared secret for `POST /v1/nodes/heartbeat`; unset disables external agents. */
  NODE_TOKEN: z.string().min(8).optional(),
  NODE_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(300_000).default(10_000),
  /** No heartbeat from any primary for this long → a helper takes the sweeps over. */
  NODE_STALE_SECONDS: z.coerce.number().int().min(15).max(3600).default(90),
  NODE_FAILOVER_POLL_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return assertGatewaySafety(parsed.data);
}

/**
 * G-12 — production guard for the real gateway.
 *
 * Zarinpal only redirects to an HTTPS callback it can reach from the open internet, and a merchant
 * id in the repository would be a leaked credential. Both mistakes are silent until someone tries
 * to pay, so the server refuses to boot instead: a payment system that half-starts is worse than one
 * that stops and says why.
 */
export function assertGatewaySafety(config: Config): Config {
  if (config.PAYMENT_GATEWAY !== 'zarinpal') return config;
  if (!config.ZARINPAL_MERCHANT_ID) {
    throw new Error(
      'PAYMENT_GATEWAY=zarinpal needs ZARINPAL_MERCHANT_ID in the server environment (never in the repo)',
    );
  }
  for (const [name, url] of [
    ['PAYMENT_CALLBACK_URL', config.PAYMENT_CALLBACK_URL],
    ['PAYMENT_RETURN_URL', config.PAYMENT_RETURN_URL],
  ] as const) {
    if (!url.startsWith('https://')) {
      throw new Error(`${name} must be an https:// URL when the real gateway is enabled (got ${url})`);
    }
  }
  return config;
}
