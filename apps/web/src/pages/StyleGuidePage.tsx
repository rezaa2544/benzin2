import { useState } from 'react';
import {
  AppShell,
  Avatar,
  BottomNav,
  BottomSheet,
  Button,
  Card,
  ChatBubble,
  ConfirmSheet,
  Countdown,
  CountdownRing,
  EmptyState,
  FormField,
  NumberStepper,
  OrderCard,
  OtpInput,
  PriceTag,
  QuantityChip,
  RadioCard,
  RangeSlider,
  SegmentedControl,
  StatusBadge,
  TextField,
  TierBadge,
  ToastStack,
  useToasts,
  type NavKey,
} from '../components/index.js';
import { t } from '../lib/i18n.js';
import { ListError, Skeleton } from './parts.js';
import { NAV_ITEMS } from '../components/BottomNav.js';
import type { ThemeMode } from '../lib/theme.js';

const COLOR_TOKENS: ReadonlyArray<{ name: string; className: string; note?: string }> = [
  { name: 'bg', className: 'bg-bg', note: 'پس‌زمینه' },
  { name: 'surface', className: 'bg-surface', note: 'کارت' },
  { name: 'surface-2', className: 'bg-surface2', note: 'سطح دوم' },
  { name: 'ink', className: 'bg-ink', note: 'متن' },
  { name: 'muted', className: 'bg-muted', note: 'متن کم‌رنگ' },
  { name: 'line', className: 'bg-line', note: 'خط' },
  { name: 'brand', className: 'bg-brand', note: 'برند' },
  { name: 'brand-soft', className: 'bg-brandSoft', note: 'برند کم‌رنگ' },
  { name: 'accent', className: 'bg-accent', note: 'لهجه' },
  { name: 'accent-soft', className: 'bg-accentSoft', note: 'لهجه کم‌رنگ' },
  { name: 'success', className: 'bg-success' },
  { name: 'warning', className: 'bg-warning' },
  { name: 'danger', className: 'bg-danger' },
  { name: 'info', className: 'bg-info' },
  { name: 'gold', className: 'bg-gold' },
  { name: 'silver', className: 'bg-silver' },
  { name: 'bronze', className: 'bg-bronze' },
];

const TYPE_SCALE: ReadonlyArray<{ className: string; token: string }> = [
  { className: 'text-3xl font-bold', token: 'text-3xl' },
  { className: 'text-2xl font-bold', token: 'text-2xl' },
  { className: 'text-xl font-bold', token: 'text-xl' },
  { className: 'text-lg', token: 'text-lg' },
  { className: 'text-base', token: 'text-base' },
  { className: 'text-sm', token: 'text-sm' },
  { className: 'text-xs', token: 'text-xs' },
];

const SPACES = ['1', '2', '3', '4', '5', '6', '7'] as const;
const RADII = [
  { name: 'xs', className: 'rounded-xs' },
  { name: 'sm', className: 'rounded-sm' },
  { name: 'card', className: 'rounded-card' },
  { name: 'sheet', className: 'rounded-sheet' },
  { name: 'pill', className: 'rounded-pill' },
] as const;

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mb-3 text-sm text-muted">{lead}</p>
      {children}
    </section>
  );
}

export interface StyleGuidePageProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
}

/**
 * The style guide (task E9-02). It exercises every base component with real Persian copy and
 * real domain values, so approving this screen approves the primitives all later screens use.
 */
export function StyleGuidePage({ theme, onToggleTheme }: StyleGuidePageProps): JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [activeNav, setActiveNav] = useState<NavKey>('market');
  // G-21: every base component gets a working sample, not a picture of one.
  const [stepper, setStepper] = useState(40);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [radius, setRadius] = useState(10);
  const [plan, setPlan] = useState('single');
  const [field, setSetField] = useState('');
  const [kitSheet, setKitSheet] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  return (
    <AppShell
      title={t('app.styleGuide')}
      active={activeNav}
      theme={theme}
      onToggleTheme={onToggleTheme}
      onNavigate={(key) => {
        setActiveNav(key);
        push(`${t('nav.market')} · ${key}`, 'info');
      }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t('app.styleGuide')}</h1>
        <p className="mt-1 text-sm text-muted">{t('app.styleGuideLead')}</p>
        <p className="mt-2 rounded-sm bg-accentSoft px-3 py-2 text-xs text-accent">
          {t('app.previewNotice')}
        </p>
      </div>

      <Section title={t('styleGuide.colors')} lead={t('styleGuide.colorsLead')}>
        <div className="grid grid-cols-3 gap-2">
          {COLOR_TOKENS.map((token) => (
            <div key={token.name} className="card overflow-hidden p-0">
              <div className={`h-12 w-full border-b border-line ${token.className}`} />
              <div className="p-2">
                <div dir="ltr" className="font-mono text-xs text-ink">
                  --{token.name}
                </div>
                {token.note ? <div className="text-xs text-muted">{token.note}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('styleGuide.type')} lead={t('styleGuide.typeLead')}>
        <div className="card flex flex-col gap-2">
          {TYPE_SCALE.map((item) => (
            <div key={item.token} className="flex items-baseline justify-between gap-3">
              <span className={item.className}>{t('styleGuide.sampleBody')}</span>
              <span dir="ltr" className="font-mono text-xs text-muted">
                {item.token}
              </span>
            </div>
          ))}
          <div className="divider" />
          <div className="flex items-center justify-between gap-3">
            <span className="money text-xl">{t('styleGuide.sampleAmount')}</span>
            <span className="text-xs text-muted">{t('styleGuide.numbers')}</span>
          </div>
        </div>
      </Section>

      <Section title={t('styleGuide.spacing')} lead={t('styleGuide.spacingLead')}>
        <div className="card">
          <div className="mb-3 flex items-end gap-2">
            {SPACES.map((step) => (
              <div key={step} className="flex flex-col items-center gap-1">
                <div
                  className="w-6 rounded-xs bg-brandSoft"
                  style={{ height: `var(--space-${step})` }}
                />
                <span dir="ltr" className="font-mono text-xs text-muted">
                  {step}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {RADII.map((radius) => (
              <div
                key={radius.name}
                className={`grid h-14 w-14 place-items-center border border-line bg-surface2 text-xs text-muted ${radius.className}`}
              >
                {radius.name}
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-card bg-surface2 p-4 shadow-card">
            <span className="text-xs text-muted">shadow-card</span>
          </div>
        </div>
      </Section>

      <Section title={t('styleGuide.components')} lead={t('styleGuide.componentsLead')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary">
              {t('common.confirm')}
            </button>
            <button type="button" className="btn">
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger">
              {t('confirm.confirm')}
            </button>
            <button type="button" className="btn" disabled>
              {t('common.loading')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <TierBadge score={88} />
            <TierBadge score={64} />
            <TierBadge score={31} />
          </div>

          <div className="card flex items-center justify-between gap-3">
            <PriceTag rateToman={9800} litres={25} />
            <PriceTag rateToman={12400} size="sm" />
          </div>

          <div className="card flex flex-wrap items-center justify-around gap-4">
            <CountdownRing remainingMs={9 * 60 * 1000} totalMs={10 * 60 * 1000} />
            <CountdownRing remainingMs={5 * 60 * 1000} totalMs={10 * 60 * 1000} />
            <CountdownRing remainingMs={70 * 1000} totalMs={10 * 60 * 1000} />
            <CountdownRing remainingMs={0} totalMs={10 * 60 * 1000} />
          </div>

          <OrderCard
            side="SELL"
            status="OPEN"
            litres={30}
            rateToman={9800}
            zoneName="بانه"
            ownerName="سارا محمدی"
            score={82}
            expiresAt={new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()}
            onOpen={() => push(t('toast.saved'), 'success')}
          />
          <OrderCard
            side="BUY"
            status="AWAITING_OWNER_DECISION"
            litres={15}
            rateToman={11200}
            zoneName="بانه"
            ownerName="کیوان رستمی"
            score={46}
            onOpen={() => push(t('toast.copied'), 'info')}
          />

          <div className="card">
            <FormField label={t('form.phone')} hint={t('form.phoneHint')} required>
              {(field) => <input {...field} className="input" placeholder="۰۹۱۲۳۴۵۶۷۸۹" />}
            </FormField>
            <FormField label={t('form.litres')} error={t('form.errorRange')} required>
              {(field) => <input {...field} className="input tnum" defaultValue="۳۰۰" />}
            </FormField>
          </div>

          <div className="card">
            <span className="label">{t('otp.label')}</span>
            <OtpInput value={otp} onChange={setOtp} />
          </div>

          <div className="card flex flex-col gap-3 bg-surface2">
            <ChatBubble
              text="سلام، ساعت ۵ در جایگاه می‌رسم."
              createdAt={new Date().toISOString()}
              mine
            />
            <ChatBubble text="عالیه، کارت را می‌آورم." createdAt={new Date().toISOString()} />
            <ChatBubble
              kind="CONTACT"
              text="۰۹۱۲۳۴۵۶۷۸۹"
              phone="۰۹۱۲۳۴۵۶۷۸۹"
              createdAt={new Date().toISOString()}
              mine
            />
            <ChatBubble kind="SYSTEM" text="رزرو تأیید شد" createdAt={new Date().toISOString()} />
          </div>

          <EmptyState
            title={t('empty.ordersTitle')}
            body={t('empty.ordersBody')}
            action={
              <button type="button" className="btn btn-primary" onClick={() => setSheetOpen(true)}>
                {t('empty.action')}
              </button>
            }
          />

          <div className="card">
            <span className="label">{t('nav.theme')}</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => push(t('toast.saved'), 'success')}
              >
                {t('toast.saved')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => push(t('toast.failed'), 'error')}
              >
                {t('toast.failed')}
              </button>
              <button type="button" className="btn" onClick={() => setSheetOpen(true)}>
                ConfirmSheet
              </button>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('styleGuide.kit')} lead={t('styleGuide.kitLead')}>
        <div className="flex flex-col gap-4">
          <Card title="Button">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary">اصلی</Button>
              <Button variant="secondary">ثانویه</Button>
              <Button variant="ghost">بی‌قاب</Button>
              <Button variant="danger">خطر</Button>
              <Button variant="primary" loading>
                در حال ارسال
              </Button>
              <Button disabled>غیرفعال</Button>
            </div>
          </Card>

          <Card title="QuantityChip · StatusBadge · Countdown">
            <div className="flex flex-wrap items-center gap-2">
              <QuantityChip litres={40} />
              <QuantityChip litres={12} tone="brand" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusBadge status="OPEN" />
              <StatusBadge status="AWAITING_OWNER_DECISION" />
              <StatusBadge status="COMPLETED" />
              <StatusBadge status="CANCELLED" />
              <StatusBadge status="SOMETHING_NEW" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Countdown dueAt={Date.now() + 12 * 60 * 1000} now={Date.now()} />
              <Countdown dueAt={Date.now() + 3 * 60 * 1000} now={Date.now()} />
              <Countdown dueAt={Date.now() - 1000} now={Date.now()} />
            </div>
          </Card>

          <Card title="TextField">
            <TextField
              label={t('form.phone')}
              hint={t('form.phoneHint')}
              value={field}
              onChange={setSetField}
              dir="ltr"
              inputMode="tel"
              required
            />
            <TextField
              label={t('form.litres')}
              value="۳۰۰"
              onChange={() => {}}
              error={t('form.errorRange')}
            />
          </Card>

          <Card title="NumberStepper · RangeSlider">
            <NumberStepper
              label={t('form.litres')}
              value={stepper}
              onChange={setStepper}
              step={5}
              min={0}
              max={200}
              suffix={t('common.litre')}
            />
            <div className="mt-4">
              <RangeSlider
                label={t('market.radius')}
                value={radius}
                onChange={setRadius}
                min={1}
                max={50}
                format={(value) => `${value}`}
              />
            </div>
          </Card>

          <Card title="SegmentedControl">
            <SegmentedControl
              label={t('market.side')}
              value={side}
              onChange={setSide}
              options={[
                { value: 'BUY', label: t('market.buy') },
                { value: 'SELL', label: t('market.sell') },
              ]}
            />
          </Card>

          <Card title="RadioCard">
            <RadioCard
              name="plan-sample"
              checked={plan === 'single'}
              onSelect={() => setPlan('single')}
              title="یک رزرو"
              subtitle="۱۵٬۰۰۰ تومان · ۹۰ روز"
              price={15000}
            />
            <RadioCard
              name="plan-sample"
              checked={plan === 'monthly'}
              onSelect={() => setPlan('monthly')}
              title="ماهانه"
              subtitle="نامحدود در ماه"
              price={49000}
            />
            <RadioCard
              name="plan-sample"
              checked={false}
              onSelect={() => {}}
              title="پلن غیرفعال"
              disabled
            />
          </Card>

          <Card title="Avatar · BottomSheet">
            <div className="flex items-center gap-3">
              <Avatar name="مریم احمدی" />
              <Avatar name="کیوان رستمی" size={56} />
              <Button onClick={() => setKitSheet(true)}>نمونهٔ شیت</Button>
            </div>
          </Card>
        </div>
      </Section>

      <Section title={t('styleGuide.states')} lead={t('styleGuide.statesLead')}>
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-1 text-xs text-muted">{t('state.loading')}</p>
            <Skeleton rows={2} />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">{t('common.empty')}</p>
            <EmptyState title={t('empty.ordersTitle')} body={t('empty.ordersBody')} />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">{t('errors.UNKNOWN')}</p>
            <ListError
              message={t('errors.UNKNOWN')}
              onRetry={() => push(t('state.retry'), 'info')}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">{t('offline.banner')}</p>
            <div role="status" className="rounded-sm border border-warning/30 bg-warning/10 p-3">
              <p className="text-xs font-medium text-warning">{t('offline.banner')}</p>
              <p className="mt-1 text-xs text-muted">{t('state.offlineHint')}</p>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('styleGuide.previewLink')} lead={t('styleGuide.previewLinkLead')}>
        <Card>
          <p className="text-sm">
            {t('styleGuide.previewLinkBody')}{' '}
            <a className="text-info underline" href="/style-guide" data-testid="style-guide-link">
              /style-guide
            </a>
          </p>
        </Card>
      </Section>

      <Section title="BottomNav" lead={NAV_ITEMS.map((item) => t(item.labelKey)).join(' · ')}>
        <div className="card p-0">
          <div className="pointer-events-none relative h-20">
            <BottomNav active={activeNav} />
          </div>
        </div>
      </Section>

      <BottomSheet
        open={kitSheet}
        title="BottomSheet"
        onClose={() => setKitSheet(false)}
        footer={
          <>
            <Button variant="primary" fullWidth onClick={() => setKitSheet(false)}>
              {t('common.confirm')}
            </Button>
            <Button fullWidth onClick={() => setKitSheet(false)}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">{t('styleGuide.kitLead')}</p>
      </BottomSheet>

      <ConfirmSheet
        open={sheetOpen}
        title={t('confirm.title')}
        body={t('confirm.body')}
        confirmLabel={t('confirm.confirm')}
        tone="danger"
        onConfirm={() => {
          setSheetOpen(false);
          push(t('toast.saved'), 'success');
        }}
        onClose={() => setSheetOpen(false)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </AppShell>
  );
}
