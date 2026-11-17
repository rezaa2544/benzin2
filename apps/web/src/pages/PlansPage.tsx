import { useCallback, useState } from 'react';
import { formatJalaliDate, formatToman, toPersianDigits } from '@benzin/shared';
import type { ApiClient } from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import type {
  EntitlementView,
  MetaConfig,
  PaymentStartView,
  PlanView,
  SubscriptionView,
} from '../lib/types.js';
import { useResource } from '../lib/useResource.js';
import { t, tf } from '../lib/i18n.js';
import { Notice, PageTitle, Skeleton } from './parts.js';

export interface PlansPageProps {
  api: ApiClient;
  /** G-11: `cardMode` decides whether the buyer is asked for a tracking number. */
  config?: MetaConfig | null;
  /** G-12: what the gateway callback put in the return URL (`paid` / `failed` / `pending`). */
  paymentOutcome?: string | null;
}

const OUTCOME_KEYS: Record<string, string> = {
  paid: 'plans.gatewayPaid',
  failed: 'plans.gatewayFailed',
  pending: 'plans.gatewayPending',
  unknown: 'plans.gatewayUnknown',
};

const errorMap = {
  NETWORK: t('errors.NETWORK'),
  UNKNOWN: t('errors.UNKNOWN'),
  PLAN_NOT_FOUND: t('plans.noPlans'),
  SUBSCRIPTION_REQUIRED: t('errors.SUBSCRIPTION_REQUIRED'),
};

/** Subscription plans (E9-13). Card-to-card is the default method; the API returns the
 *  destination card and a Persian instruction the client shows verbatim. */
export function PlansPage({ api, config, paymentOutcome }: PlansPageProps): JSX.Element {
  const [pending, setPending] = useState<PaymentStartView | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // G-11 review mode: the transfer is confirmed by a person, so the buyer sends the bank's
  // tracking number. In auto mode the unique amount does the same job and this box never shows.
  const [tracking, setTracking] = useState('');
  const [proofState, setProofState] = useState<'idle' | 'sending' | 'queued'>('idle');
  const reviewMode = config?.cardMode === 'review';

  const load = useCallback(async () => {
    const [plans, subscription, entitlement] = await Promise.all([
      api.get<{ items: PlanView[] }>('/v1/plans'),
      api.get<{ subscription: SubscriptionView | null }>('/v1/me/subscription'),
      // G-26: the plan that governs this buyer and what is left of it — shown before the cards,
      // because «چند رزرو دارم؟» is the question that brings people to this page.
      api.get<EntitlementView>('/v1/me/entitlements'),
    ]);
    return { plans: plans.items, subscription: subscription.subscription, entitlement };
  }, [api]);

  const { data, loading, error: loadError } = useResource(load, [api]);

  const buy = async (plan: PlanView): Promise<void> => {
    setBusyCode(plan.code);
    setError(null);
    try {
      const started = await api.post<PaymentStartView>('/v1/subscriptions', {
        planCode: plan.code,
        method: 'CARD_TO_CARD',
      });
      setPending(started);
      setTracking('');
      setProofState('idle');
    } catch (cause) {
      setError(errorMessage(cause, errorMap));
    } finally {
      setBusyCode(null);
    }
  };

  /** G-11: sends the bank tracking number; the invoice then waits in the operator queue. */
  const submitProof = async (paymentId: string): Promise<void> => {
    if (tracking.trim().length < 4) {
      setError(t('plans.proofInvalid'));
      return;
    }
    setProofState('sending');
    setError(null);
    try {
      await api.post(`/v1/payments/${paymentId}/card-proof`, {
        trackingNumber: tracking.trim(),
      });
      setProofState('queued');
    } catch (cause) {
      setProofState('idle');
      setError(errorMessage(cause, errorMap));
    }
  };

  return (
    <div>
      <PageTitle title={t('plans.title')} lead={t('plans.lead')} />

      {/* G-12: the buyer came back from the bank — say what happened before anything else. */}
      {paymentOutcome && OUTCOME_KEYS[paymentOutcome] ? (
        <Notice tone={paymentOutcome === 'paid' ? 'success' : paymentOutcome === 'failed' ? 'error' : 'warning'}>
          {t(OUTCOME_KEYS[paymentOutcome]!)}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loadError ? <Notice tone="error">{errorMessage(loadError, errorMap)}</Notice> : null}

      {loading ? (
        <Skeleton rows={2} />
      ) : (
        <>
          {data?.entitlement ? (
            <div
              className="card mb-3 border-brand/40 bg-brandSoft"
              data-testid="entitlement-card"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">{data.entitlement.planNameFa}</p>
                <span className="chip">
                  {data.entitlement.phoneVisible ? t('plans.planPhone') : t('plans.planNoPhone')}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted tnum" data-testid="entitlement-remaining">
                {data.entitlement.remaining === null
                  ? tf('plans.unlimitedRemaining', {
                      used: toPersianDigits(data.entitlement.usedThisMonth),
                    })
                  : tf('plans.remainingOf', {
                      remaining: toPersianDigits(data.entitlement.remaining),
                      limit: toPersianDigits(data.entitlement.monthlyLimit ?? 0),
                    })}
              </p>
            </div>
          ) : null}

          {data?.subscription ? (
            <div className="card mb-3 border-brand/40 bg-brandSoft">
              <p className="text-sm font-bold">{data.subscription.planNameFa}</p>
              <p className="text-xs text-muted tnum">
                {tf('plans.daysRemaining', {
                  days: toPersianDigits(data.subscription.daysRemaining),
                })}{' '}
                · {t('plans.expiresAt')} {formatJalaliDate(data.subscription.endsAt)}
              </p>
            </div>
          ) : null}

          {pending ? (
            <div className="card mb-3">
              <h2 className="mb-1 text-sm font-bold">{t('plans.payTitle')}</h2>
              <p className="mb-2 text-xs text-muted">{pending.instructionFa}</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted">{t('common.toman')}</dt>
                <dd className="text-end tnum font-bold">{formatToman(pending.amountToman)}</dd>
                {pending.uniqueAmountToman ? (
                  <>
                    {/* G-11: the amount with the random suffix is the matcher key, so it is shown
                        as its own row — the buyer must transfer exactly this number. */}
                    <dt className="text-muted">{t('plans.uniqueAmount')}</dt>
                    <dd className="text-end tnum font-bold" data-testid="unique-amount">
                      {formatToman(pending.uniqueAmountToman)}
                    </dd>
                  </>
                ) : null}
                {pending.destination ? (
                  <>
                    <dt className="text-muted">{t('plans.cardNumber')}</dt>
                    <dd className="text-end tnum" dir="ltr">
                      {pending.destination.cardNumber}
                    </dd>
                    <dt className="text-muted">{t('plans.holder')}</dt>
                    <dd className="text-end">{pending.destination.holderName}</dd>
                  </>
                ) : null}
              </dl>
              {!pending.redirectUrl && reviewMode ? (
                <div className="mt-3 border-t border-line pt-3">
                  <h3 className="text-sm font-bold">{t('plans.proofTitle')}</h3>
                  <p className="mb-2 text-xs text-muted">{t('plans.proofLead')}</p>
                  {proofState === 'queued' ? (
                    <Notice tone="success">{t('plans.proofQueued')}</Notice>
                  ) : (
                    <>
                      <label className="mb-1 block text-xs text-muted" htmlFor="tracking">
                        {t('plans.proofLabel')}
                      </label>
                      <input
                        id="tracking"
                        className="input tnum mb-2"
                        dir="ltr"
                        inputMode="numeric"
                        value={tracking}
                        onChange={(event) => setTracking(event.target.value)}
                        data-testid="card-tracking"
                      />
                      <button
                        type="button"
                        className="btn btn-primary w-full"
                        disabled={proofState === 'sending' || tracking.trim().length < 4}
                        onClick={() => void submitProof(pending.id)}
                      >
                        {t('plans.proofSubmit')}
                      </button>
                    </>
                  )}
                </div>
              ) : null}

              {pending.redirectUrl ? (
                <a className="btn btn-primary mt-3 w-full" href={pending.redirectUrl}>
                  {t('plans.openGateway')}
                </a>
              ) : (
                <Notice tone="warning">{t('plans.pending')}</Notice>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            {(data?.plans.length ?? 0) === 0 ? (
              <Notice tone="info">{t('plans.noPlans')}</Notice>
            ) : (
              data?.plans.map((plan) => (
                <div key={plan.id} className="card">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-base font-bold">{plan.nameFa}</h3>
                    <span className="text-sm font-bold tnum">{plan.priceLabelFa}</span>
                  </div>
                  <p className="mb-1 text-xs text-muted tnum">
                    {tf('plans.duration', { days: toPersianDigits(plan.durationDays) })} ·{' '}
                    {tf('plans.orders', { count: toPersianDigits(plan.maxActiveOrders) })}
                  </p>
                  {/* G-26: the card says what the money actually buys. */}
                  <ul className="mb-3 space-y-1 text-xs">
                    <li className="flex items-center gap-1">
                      <span aria-hidden className="text-brand">
                        ✓
                      </span>
                      {plan.monthlyReservations === null
                        ? t('plans.unlimited')
                        : `${toPersianDigits(plan.monthlyReservations)} ${t('plans.planReservations')}`}
                    </li>
                    <li className="flex items-center gap-1">
                      <span aria-hidden className={plan.phoneVisible ? 'text-brand' : 'text-muted'}>
                        {plan.phoneVisible ? '✓' : '×'}
                      </span>
                      {plan.phoneVisible ? t('plans.planPhone') : t('plans.planNoPhone')}
                    </li>
                    {plan.singleUse ? (
                      <li className="flex items-center gap-1 text-muted">
                        <span aria-hidden>•</span>
                        {t('plans.planSingle')}
                      </li>
                    ) : null}
                  </ul>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={busyCode !== null}
                    onClick={() => void buy(plan)}
                  >
                    {busyCode === plan.code ? t('plans.buying') : t('plans.buy')}
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
