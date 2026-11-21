# ۰۲ — مدل داده، رزرو اتمی و زمان‌بند

این سند قرارداد پیاده‌سازی است؛ هر کوئری حساس عیناً از این‌جا گرفته می‌شود.

## ۱. جدول‌ها

```sql
-- کاربران
users(id uuid pk, phone text unique not null, name text, role text not null default 'USER',
      zone_id uuid null references zones(id), phone_hidden boolean not null default false,
      created_at timestamptz default now(), suspended_until timestamptz, suspension_reason text,
      response_rate numeric(4,3) default 1.0, completed_count int default 0)

-- مناطق
zones(id uuid pk, name text, center geography(Point,4326), radius_m int,
      enabled boolean default true, created_at timestamptz)

-- آگهی‌ها (لات سهمیه)
orders(id uuid pk,
       seller_id uuid not null references users(id),
       quantity_liters int not null check (quantity_liters between 1 and 400),
       price_per_liter bigint not null check (price_per_liter > 0),   -- تومان
       official_cost bigint not null,                                  -- جمع بهای رسمی لات
       breakdown jsonb not null,          -- [{"tier":"1500","liters":12}, {"tier":"3000","liters":28}]
       location geography(Point,4326) not null,
       zone_id uuid not null references zones(id),
       status text not null default 'OPEN',       -- OPEN|RESERVED|MATCHED|COMPLETED|CANCELLED|EXPIRED
       expires_at timestamptz not null,
       reserved_by uuid references users(id),
       reserved_at timestamptz,
       reservation_expires_at timestamptz,
       extension_used boolean not null default false,
       version int not null default 0,            -- برای optimistic locking
       delivery_code text,                        -- ۴ رقمی، هنگام MATCHED
       created_at timestamptz default now(), updated_at timestamptz default now())

-- اشتراک‌ها، پرداخت‌ها، چت، اعلان‌ها، امتیازها: مطابق schema نسخهٔ ۱، با کلیدهای خارجی درست
```

### ایندکس‌های لازم

```sql
create index orders_market_idx on orders (zone_id, status, price_per_liter)
  where status = 'OPEN';                                   -- فهرست بازار
create index orders_geo_idx  on orders using gist (location);
create index orders_expiry_idx on orders (reservation_expires_at)
  where status = 'RESERVED';                               -- کارگر آزادسازی
create index orders_ttl_idx on orders (expires_at) where status = 'OPEN';
```

## ۲. رزرو اتمی (مهم‌ترین کوئری محصول)

دو خریدار هم‌زمان روی یک آگهی «تأیید» می‌زنند. **باید** یکی برنده شود و دیگری پیام «همین حالا
رزرو شد» بگیرد — بدون قفل درون‌حافظه، چون با چند نمونهٔ API کار نمی‌کند.

```sql
-- ۱) گرفتن رزرو در یک دستور. اگر status دیگر OPEN نباشد، صفر ردیف برمی‌گردد.
update orders
   set status = 'RESERVED',
       reserved_by = $buyer,
       reserved_at = now(),
       reservation_expires_at = now() + ($hold_minutes || ' minutes')::interval,
       extension_used = false,
       version = version + 1,
       updated_at = now()
 where id = $order
   and status = 'OPEN'
   and expires_at > now()                  -- آگهی منقضی رزرو نمی‌شود
returning id, seller_id, price_per_liter, quantity_liters;
```

- `rowCount = 0` ⇐ رزرو نشد. پیام به کاربر: «این آگهی همین لحظه رزرو شد» + بازخوانی فهرست.
- `rowCount = 1` ⇐ برنده. در همان تراکنش: کسر اعتبار/چک اشتراک، ساخت رکورد چت، ثبت `audit_log`،
  اعلان به فروشنده.

هیچ‌گاه از الگوی «بخوان، بررسی کن، بنویس» برای این گذار استفاده نشود. اگر لازم شد ردیف را قفل
کنیم، `select ... for update` **داخل همان تراکنش** مجاز است، اما راه اصلی همان `update ... where
status = 'OPEN'` است که خودش قفل ردیف را می‌گیرد.

### تمدید یک‌باره

```sql
update orders
   set reservation_expires_at = reservation_expires_at + interval '10 minutes',
       extension_used = true, version = version + 1
 where id = $order and reserved_by = $buyer
   and status = 'RESERVED' and extension_used = false and reservation_expires_at > now();
```

### لغو توسط خریدار

```sql
update orders set status = 'OPEN', reserved_by = null, reserved_at = null,
       reservation_expires_at = null, version = version + 1
 where id = $order and reserved_by = $buyer and status = 'RESERVED';
```

## ۳. کارگر زمان‌بند (نه چک در اپ!)

یک حلقهٔ مستقل هر ۳۰ ثانیه. روی چند نمونه هم بی‌خطر است چون از `SKIP LOCKED` استفاده می‌کند.

```ts
// apps/api/src/worker.ts  →  ENTRYPOINT جدا، همان ایمیج
async function sweep() {
  // ۱) آزادسازی رزروهای منقضی
  const released = await db.execute(sql`
    update orders
       set status = 'OPEN', reserved_by = null, reserved_at = null,
           reservation_expires_at = null, version = version + 1
     where id in (
       select id from orders
        where status = 'RESERVED' and reservation_expires_at < now()
        for update skip locked
        limit 100)
    returning id, seller_id`);

  // ۲) انقضای آگهی‌های باز
  const expired = await db.execute(sql`
    update orders set status = 'EXPIRED', version = version + 1
     where id in (
       select id from orders
        where status = 'OPEN' and expires_at < now()
        for update skip locked limit 100)
    returning id, seller_id`);

  // ۳) پایان اشتراک‌ها، ۴) رفع تعلیق‌های سررسیده، ۵) پاک‌سازی OTP‌های کهنه
  // ... هر یک با همین الگو
}
setInterval(() => sweep().catch(logError), 30_000);
```

قواعد:

- **idempotent**: اجرای دوباره اثر اضافه ندارد.
- **batched**: حداکثر ۱۰۰ ردیف در هر دور تا جدول بزرگ قفل نشود.
- **observable**: هر دور در `audit_log` با تعداد ردیف‌ها ثبت شود؛ در پنل «آخرین اجرای زمان‌بند»
  نمایش داده شود. اگر بیش از ۵ دقیقه اجرا نشده باشد، `/health` نارنجی می‌شود.
- اعلان‌ها بعد از commit فرستاده شوند، نه داخل تراکنش.

> نسخهٔ ۱ این را ندارد: انقضا فقط هنگام خواندن چک می‌شود. نتیجه: آگهی منقضی در فهرست می‌ماند و
> رزروها هرگز آزاد نمی‌شوند.

## ۴. پیکربندی در دیتابیس

```sql
settings(key text primary key, value jsonb not null, updated_at timestamptz, updated_by uuid)
```

کلیدهای الزامی (مقادیر پیش‌فرض):

| کلید                               | پیش‌فرض                           |
| ---------------------------------- | --------------------------------- |
| `order.expiry_days`                | `2`                               |
| `order.reservation_minutes`        | `30`                              |
| `order.extension_minutes`          | `10`                              |
| `order.max_open_per_seller`        | `3`                               |
| `payment.gateway_enabled`          | `true`                            |
| `payment.card_to_card_enabled`     | `true`                            |
| `payment.card_to_card_mode`        | `"auto"                           | "review" | "manual"` |
| `plan.free_reservations_per_month` | `3`                               |
| `sms.provider_chain`               | `["smsir","kavenegar","console"]` |
| `market.average_window_hours`      | `72`                              |

هیچ‌کدام از این‌ها در کد ثابت نباشد؛ همه از پنل مالک قابل ویرایش با ثبت در `audit_log`.

## ۵. قیمت میانگین بازار

```sql
-- میانهٔ قیمت هر لیتر در معاملات بسته‌شدهٔ ۷۲ ساعت گذشته، به تفکیک منطقه
select percentile_cont(0.5) within group (order by price_per_liter) as median_ppm,
       count(*)                                            as trades
  from orders
 where status = 'COMPLETED' and zone_id = $zone
   and updated_at > now() - ($window || ' hours')::interval;
```

- اگر `trades < 5` باشد، عدد نمایش داده نمی‌شود و «دادهٔ کافی نیست» می‌آید (عدد ساختگی از ۱ معامله
  گمراه‌کننده است).
- میانه استفاده می‌شود نه میانگین؛ یک معاملهٔ ۲۰ میلیونی نباید کل بازار را جابه‌جا کند.
- نتیجه در پنل هم نمایش داده می‌شود تا مالک سلامت بازار را ببیند.

## ۶. دسترسی و حریم خصوصی داده

| داده               | چه کسی می‌بیند                                            |
| ------------------ | --------------------------------------------------------- |
| مختصات دقیق آگهی   | فروشنده، سرور؛ خریدار فقط فاصله/دایرهٔ تقریبی              |
| شمارهٔ فروشنده      | خریدارِ دارای رزرو و اشتراک (مگر `phone_hidden`)           |
| شمارهٔ خریدار       | فروشنده، فقط بعد از RESERVED                              |
| محتوای چت          | دو طرف + پنل فقط با دسترسی `SUPPORT` و ثبت در `audit_log` |
| گزارش کارت‌به‌کارت | `FINANCE` و `OWNER`                                       |

## ۷. مهاجرت از وضعیت فعلی

نسخهٔ ۱ چهار مهاجرت دارد (`infra/migrations/0000…0003`)؛ همان‌ها پایه‌اند. تغییرات لازم:

1. `orders.version`, `delivery_code`, `extension_used` (اگر نیست) → `0004`.
2. جدول `settings` → `0005`.
3. جدول `reminder_jobs` و `audit_log` (اگر نیست) → `0006`.
4. قید یکتایی برای جلوگیری از رزرو هم‌زمان در سطح دیتابیس (کمربند ایمنی دوم):
   ```sql
   create unique index orders_one_active_reservation
     on orders (reserved_by) where status = 'RESERVED';
   ```
   یعنی یک خریدار هم‌زمان فقط یک رزرو فعال دارد.

همهٔ مهاجرت‌ها باید `up` و `down` داشته باشند و روی دیتابیس پر از داده اجرا شدنی باشند.
