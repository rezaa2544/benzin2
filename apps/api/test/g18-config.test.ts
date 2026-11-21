import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * G-18 — what a blank line in `infra/.env.prod` must *not* do.
 *
 * The first real `docker compose up` of the production stack crash-looped the API with
 * `ZARINPAL_MERCHANT_ID: String must contain at least 8 character(s)`, because `.env.prod` shipped
 * `ZARINPAL_MERCHANT_ID=` and compose passes the empty string. A key that is intentionally blank
 * has to behave exactly like a key that is absent; only a key the *code* requires may stop boot.
 */
const KEYS = ['ZARINPAL_MERCHANT_ID', 'PAYMENT_GATEWAY', 'DATABASE_URL', 'REDIS_URL'] as const;

const restore: Record<string, string | undefined> = {};
for (const key of KEYS) restore[key] = process.env[key];

const set = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const key of KEYS) set(key, restore[key]);
});

describe('empty environment values (G-18)', () => {
  it('treats a blank optional key as absent instead of failing validation', () => {
    set('ZARINPAL_MERCHANT_ID', '');
    set('DATABASE_URL', undefined);
    set('REDIS_URL', undefined);
    set('PAYMENT_GATEWAY', 'sandbox');

    const config = loadConfig();
    expect(config.ZARINPAL_MERCHANT_ID).toBeUndefined();
    expect(config.PAYMENT_GATEWAY).toBe('sandbox');
  });

  it('still boots when the gateway needs no merchant id', () => {
    // The default gateway is card-to-card review, so a blank merchant id is a valid production
    // state until the owner has the real key.
    set('ZARINPAL_MERCHANT_ID', '');
    set('PAYMENT_GATEWAY', 'sandbox');
    expect(() => loadConfig()).not.toThrow();
  });

  it('refuses to start the zarinpal gateway without the id — and says which key', () => {
    set('ZARINPAL_MERCHANT_ID', '');
    set('PAYMENT_GATEWAY', 'zarinpal');
    expect(() => loadConfig()).toThrowError(/ZARINPAL_MERCHANT_ID/);
  });

  it('accepts a real merchant id', () => {
    set('ZARINPAL_MERCHANT_ID', '12345678-abcd');
    set('PAYMENT_GATEWAY', 'zarinpal');
    expect(loadConfig().ZARINPAL_MERCHANT_ID).toBe('12345678-abcd');
  });
});
