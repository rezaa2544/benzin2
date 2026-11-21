import { z } from 'zod';

/**
 * Runtime settings (§7 of the brief). Every key has a documented default so the platform
 * is fully operable out of the box; the admin panel edits these rows at runtime.
 * Values marked ASSUMPTION were not fixed by the brief and are recorded in docs/ASSUMPTIONS.md.
 */
export const SETTING_DEFINITIONS = {
  // G-04: a reservation lives 30 minutes by default and can be extended once, by 10 minutes.
  'reservation.ttl_minutes': { schema: z.number().int().min(1).max(120), default: 30 },
  'reservation.extend_minutes': { schema: z.number().int().min(1).max(60), default: 10 },
  'reservation.max_extensions': { schema: z.number().int().min(0).max(5), default: 1 },
  'reservation.max_active_per_user': { schema: z.number().int().min(1).max(10), default: 1 },
  'reservation.contact_window_minutes': { schema: z.number().int().min(1).max(240), default: 45 },
  'owner.decision_ttl_minutes': { schema: z.number().int().min(1).max(120), default: 5 },
  'order.max_open_per_user': { schema: z.number().int().min(1).max(10), default: 2 },
  'order.min_litres': { schema: z.number().min(0.1).max(1000), default: 5 },
  'order.max_litres': { schema: z.number().min(1).max(1000), default: 60 },
  'order.default_expiry_hours': { schema: z.number().int().min(1).max(168), default: 24 },
  'order.rate_ceiling_tolerance_percent': { schema: z.number().min(0).max(100), default: 20 },
  'trade.auto_complete_hours': { schema: z.number().int().min(1).max(72), default: 2 },
  'chat.max_message_length': { schema: z.number().int().min(20).max(2000), default: 500 },
  'notification.sms_enabled': { schema: z.boolean(), default: true },
  'chat.quick_replies': {
    schema: z.array(z.string().min(1).max(120)).min(1).max(12),
    default: ['سلام، در مسیرم', '۵ دقیقه دیگر می‌رسم', 'پمپ شلوغ است', 'کارت را آماده کنید'],
  },
  'otp.length': { schema: z.literal(5), default: 5 },
  'otp.ttl_seconds': { schema: z.number().int().min(30).max(600), default: 120 },
  'otp.max_attempts': { schema: z.number().int().min(1).max(10), default: 5 },
  'otp.resend_cooldown_seconds': { schema: z.number().int().min(15).max(600), default: 60 },
  'auth.refresh_token_days': { schema: z.number().int().min(1).max(365), default: 30 },
  'pricing.low_price_warning_percent': { schema: z.number().min(0).max(90), default: 30 },
  'dispute.auto_review_hours': { schema: z.number().int().min(1).max(168), default: 24 },
  'geo.default_radius_km': { schema: z.number().min(1).max(200), default: 15 },
  'subscription.required_for_orders': { schema: z.boolean(), default: false },
  /**
   * G-14: the text a one-time code travels in when a provider has no approved template. The
   * `{code}` placeholder is required and enforced where the message is built — a template without
   * it would send a code-less SMS that looks delivered.
   */
  'notification.sms_otp_message': {
    schema: z
      .string()
      .trim()
      .min(5)
      .max(160)
      .refine((value) => value.includes('{code}'), {
        message: 'OTP_TEMPLATE_MISSING_CODE',
      }),
    default: 'کد ورود شما به بنزین: {code}',
  },
  'payment.card_to_card_ttl_minutes': { schema: z.number().int().min(15).max(1440), default: 120 },
  'payment.gateway_ttl_minutes': { schema: z.number().int().min(5).max(180), default: 30 },
  'payment.unique_suffix_max': { schema: z.number().int().min(1).max(999), default: 999 },
  /**
   * G-11 — how a card-to-card transfer gets confirmed.
   * `auto`: the deposit webhook matches the unique amount and activates the plan immediately.
   * `review`: the buyer types the tracking number and an operator approves it in the panel.
   */
  'payment.card_mode': { schema: z.enum(['auto', 'review']), default: 'auto' },
  /** G-11 — the destination account, editable from the panel instead of hard-coded. */
  // The default matches the seeded destination card, so a fresh install shows the same account
  // whether the buyer looks at the old `payment_cards` row or at these settings (G-11).
  'payment.card_number': { schema: z.string().regex(/^\d{16}$/), default: '6037991234567890' },
  'payment.card_holder': { schema: z.string().min(3).max(60), default: 'شرکت بنزین' },
  /**
   * G-12 — how hard the worker tries to verify a gateway payment before a human looks at it.
   * The callback lives in the buyer's browser, so a closed tab must not cost them the plan.
   */
  'payment.verify_max_attempts': { schema: z.number().int().min(1).max(10), default: 3 },
  'payment.verify_retry_minutes': { schema: z.number().int().min(1).max(120), default: 10 },
  'trust.suspend_below_score': { schema: z.number().int().min(0).max(99), default: 20 },
  'trust.suspend_hours': { schema: z.number().int().min(1).max(720), default: 24 },
  'trust.window_days': { schema: z.number().int().min(1).max(365), default: 180 },
  'stats.window_days': { schema: z.number().int().min(1).max(365), default: 30 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export type Settings = { [K in SettingKey]: SettingValue<K> };

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  SETTING_KEYS.map((key) => [key, SETTING_DEFINITIONS[key].default]),
) as unknown as Settings;

/** Validates and coerces a single value; throws a ZodError when the value is out of contract. */
export function parseSetting<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  return SETTING_DEFINITIONS[key].schema.parse(raw) as SettingValue<K>;
}

/** Applies a partial map of overrides on top of a base settings object. */
export function withOverrides(
  base: Settings,
  overrides: Partial<Record<SettingKey, unknown>>,
): Settings {
  const next: Settings = { ...base };
  for (const [key, raw] of Object.entries(overrides)) {
    if (!(key in SETTING_DEFINITIONS)) throw new RangeError(`Unknown setting: ${key}`);
    (next as Record<string, unknown>)[key] = parseSetting(key as SettingKey, raw);
  }
  return next;
}

/**
 * Presentation metadata for the admin panel (task E8-05). Grouping and Persian labels
 * live next to the definitions so a new setting cannot ship without copy; the numeric
 * bounds are read from the zod schema itself, never duplicated.
 */
export const SETTING_GROUPS = [
  'ORDER',
  'RESERVATION',
  'TRADE',
  'CHAT',
  'AUTH',
  'PRICING',
  'PAYMENT',
  'TRUST',
  'GEO',
  'OPS',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_META: Record<SettingKey, { labelFa: string; group: SettingGroup }> = {
  'reservation.ttl_minutes': { labelFa: 'مهلت رزرو (دقیقه)', group: 'RESERVATION' },
  'reservation.extend_minutes': { labelFa: 'مدت هر تمدید رزرو (دقیقه)', group: 'RESERVATION' },
  'reservation.max_extensions': { labelFa: 'حداکثر تعداد تمدید رزرو', group: 'RESERVATION' },
  'reservation.max_active_per_user': {
    labelFa: 'حداکثر رزرو هم‌زمان هر کاربر',
    group: 'RESERVATION',
  },
  'reservation.contact_window_minutes': {
    labelFa: 'پنجره‌ی نمایش تماس (دقیقه)',
    group: 'RESERVATION',
  },
  'owner.decision_ttl_minutes': { labelFa: 'مهلت تصمیم صاحب سفارش (دقیقه)', group: 'RESERVATION' },
  'order.max_open_per_user': { labelFa: 'حداکثر سفارش باز هر کاربر', group: 'ORDER' },
  'order.min_litres': { labelFa: 'حداقل حجم سفارش (لیتر)', group: 'ORDER' },
  'order.max_litres': { labelFa: 'حداکثر حجم سفارش (لیتر)', group: 'ORDER' },
  'order.default_expiry_hours': { labelFa: 'انقضای پیش‌فرض سفارش (ساعت)', group: 'ORDER' },
  'order.rate_ceiling_tolerance_percent': { labelFa: 'رواداری سقف نرخ (درصد)', group: 'PRICING' },
  'trade.auto_complete_hours': { labelFa: 'تکمیل خودکار معامله (ساعت)', group: 'TRADE' },
  'chat.max_message_length': { labelFa: 'حداکثر طول پیام', group: 'CHAT' },
  'notification.sms_enabled': { labelFa: 'ارسال پیامک فعال باشد', group: 'CHAT' },
  'notification.sms_otp_message': {
    labelFa: 'متن پیامک کد ورود',
    group: 'CHAT',
  },
  'chat.quick_replies': { labelFa: 'پاسخ‌های آماده', group: 'CHAT' },
  'otp.length': { labelFa: 'طول کد یک‌بارمصرف', group: 'AUTH' },
  'otp.ttl_seconds': { labelFa: 'اعتبار کد (ثانیه)', group: 'AUTH' },
  'otp.max_attempts': { labelFa: 'حداکثر تلاش کد', group: 'AUTH' },
  'otp.resend_cooldown_seconds': { labelFa: 'فاصله‌ی ارسال مجدد (ثانیه)', group: 'AUTH' },
  'auth.refresh_token_days': { labelFa: 'عمر نشست (روز)', group: 'AUTH' },
  'pricing.low_price_warning_percent': { labelFa: 'هشدار قیمت پایین (درصد)', group: 'PRICING' },
  'dispute.auto_review_hours': { labelFa: 'بازبینی خودکار اختلاف (ساعت)', group: 'OPS' },
  'geo.default_radius_km': { labelFa: 'شعاع پیش‌فرض جستجو (کیلومتر)', group: 'GEO' },
  'subscription.required_for_orders': {
    labelFa: 'اشتراک برای ثبت سفارش الزامی باشد',
    group: 'PAYMENT',
  },
  'payment.card_to_card_ttl_minutes': {
    labelFa: 'مهلت پرداخت کارت‌به‌کارت (دقیقه)',
    group: 'PAYMENT',
  },
  'payment.gateway_ttl_minutes': { labelFa: 'مهلت پرداخت درگاه (دقیقه)', group: 'PAYMENT' },
  'payment.unique_suffix_max': { labelFa: 'حداکثر پسوند مبلغ یکتا', group: 'PAYMENT' },
  'payment.card_mode': {
    labelFa: 'حالت تأیید کارت‌به‌کارت (auto = خودکار، review = بازبینی اپراتور)',
    group: 'PAYMENT',
  },
  'payment.card_number': { labelFa: 'شمارهٔ کارت مقصد (۱۶ رقم)', group: 'PAYMENT' },
  'payment.card_holder': { labelFa: 'صاحب کارت مقصد', group: 'PAYMENT' },
  'payment.verify_max_attempts': {
    labelFa: 'حداکثر تلاش بررسی درگاه (سپس بازبینی اپراتور)',
    group: 'PAYMENT',
  },
  'payment.verify_retry_minutes': {
    labelFa: 'فاصلهٔ تلاش‌های بررسی درگاه (دقیقه)',
    group: 'PAYMENT',
  },
  'trust.suspend_below_score': { labelFa: 'تعلیق زیر امتیاز', group: 'TRUST' },
  'trust.suspend_hours': { labelFa: 'مدت تعلیق (ساعت)', group: 'TRUST' },
  'trust.window_days': { labelFa: 'پنجره‌ی محاسبه‌ی اعتبار (روز)', group: 'TRUST' },
  'stats.window_days': { labelFa: 'پنجره‌ی آمار بازار (روز)', group: 'OPS' },
};

/** Shape of a setting editor rendered by the panel. */
export type SettingKind = 'number' | 'boolean' | 'list' | 'text' | 'select';

interface ZodDefLite {
  typeName?: string;
  checks?: { kind?: string; value?: unknown }[];
}

/** Zod 3 keeps `min`/`max` inside `_def.checks`; read them without hard-coding ranges. */
export function settingBounds(key: SettingKey): { min: number | null; max: number | null } {
  const schema = SETTING_DEFINITIONS[key].schema as unknown as { _def?: ZodDefLite };
  let min: number | null = null;
  let max: number | null = null;
  for (const check of schema._def?.checks ?? []) {
    if (typeof check.value !== 'number') continue;
    if (check.kind === 'min') min = check.value;
    if (check.kind === 'max') max = check.value;
  }
  return { min, max };
}

export function settingKind(key: SettingKey): SettingKind {
  const schema = SETTING_DEFINITIONS[key].schema as unknown as { _def?: ZodDefLite };
  const typeName = schema._def?.typeName;
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodArray') return 'list';
  if (typeName === 'ZodEnum') return 'select';
  // G-11 added plain text settings (the destination card) next to the numeric ones.
  if (typeName === 'ZodString') return 'text';
  return 'number';
}

/** Allowed values for a `select` setting, in the order the panel should list them. */
export function settingOptions(key: SettingKey): string[] {
  const schema = SETTING_DEFINITIONS[key].schema as unknown as {
    _def?: { typeName?: string; values?: string[] };
  };
  return schema._def?.typeName === 'ZodEnum' ? [...(schema._def.values ?? [])] : [];
}
