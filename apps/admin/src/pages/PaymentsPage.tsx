import { useState } from 'react';
import { PAYMENT_STATUSES, type PaymentStatus } from '@benzin/shared';
import type { ApiClient } from '../lib/api.js';
import { fmtDate, fmtDateTime, fmtNumber, fmtToman, statusFa } from '../lib/format.js';
import { useResource } from '../lib/useResource.js';
import type { CardDepositRow, PaymentCardRow, PaymentRow, RevenueReport } from '../lib/types.js';
import { Badge, DataTable, Field, Modal, Notice } from '../components/ui.js';
import fa from '../i18n/fa.json';

/** E8-04 + E7-07: manual settlement of card-to-card transfers and destination cards. */
/**
 * G-12 — the income card.
 *
 * It answers the one question an operator actually asks after a launch («چقدر پول آمد؟») with the
 * money that *settled*, split by method and by Tehran day, plus the retry button for gateway
 * verifications the bank never confirmed. Numbers arrive pre-formatted so the panel cannot drift
 * from the API on digits or separators.
 */
function RevenueCard({ api, onRetried }: { api: ApiClient; onRetried: () => void }): JSX.Element {
  const report = useResource<RevenueReport>(
    () => api.get<RevenueReport>('/v1/admin/revenue', { days: 30 }),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const data = report.data;

  const retry = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ retriedVerifications: number; verifiedPayments: number }>(
        '/v1/admin/reconciliation',
        {},
      );
      setMessage(
        `${fa.payments.revenueRetried} (${fmtNumber(result.retriedVerifications)} بررسی، ${fmtNumber(result.verifiedPayments)} تأیید)`,
      );
      report.reload();
      onRetried();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : fa.app.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">{fa.payments.revenueTitle}</h2>
          <p className="text-xs text-muted">{fa.payments.revenueLead}</p>
        </div>
        <button
          type="button"
          className="btn px-2 py-1 text-xs"
          disabled={busy}
          onClick={() => void retry()}
        >
          {fa.payments.revenueRetry}
        </button>
      </div>

      {message ? <Notice tone="info">{message}</Notice> : null}
      {report.error ? <Notice tone="error">{report.error.message}</Notice> : null}
      {report.loading && !data ? <Notice>{fa.app.loading}</Notice> : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-line p-2">
              <p className="text-xs text-muted">{fa.payments.revenueTotal}</p>
              <p className="text-sm font-bold tnum" data-testid="revenue-total">
                {data.totalTomanLabelFa}
              </p>
            </div>
            <div className="rounded-lg border border-line p-2">
              <p className="text-xs text-muted">{fa.payments.revenuePaid}</p>
              <p className="text-sm font-bold tnum">{fmtNumber(data.paidCount)}</p>
            </div>
            <div className="rounded-lg border border-line p-2">
              <p className="text-xs text-muted">{fa.payments.revenuePending}</p>
              <p className="text-sm font-bold tnum">{fmtNumber(data.pendingCount)}</p>
            </div>
            <div className="rounded-lg border border-line p-2">
              <p className="text-xs text-muted">{fa.payments.revenueFailed}</p>
              <p className="text-sm font-bold tnum">{fmtNumber(data.failedCount)}</p>
            </div>
          </div>

          {data.byProvider.length > 0 ? (
            <div className="flex flex-wrap gap-2 text-xs" data-testid="revenue-providers">
              {data.byProvider.map((row) => (
                <span key={row.provider} className="chip">
                  {row.labelFa}: {row.paidTomanLabelFa} ({fmtNumber(row.paidCount)})
                </span>
              ))}
            </div>
          ) : null}

          {data.byDay.length === 0 ? (
            <Notice>{fa.payments.revenueEmpty}</Notice>
          ) : (
            <DataTable
              rows={[...data.byDay].reverse()}
              empty={fa.payments.revenueEmpty}
              columns={[
                {
                  key: 'day',
                  header: fa.payments.revenueDay,
                  // The report is bucketed by Tehran day; the panel shows it as a Jalali date.
                  render: (row) => <span className="tnum">{fmtDate(`${row.day}T00:00:00Z`)}</span>,
                },
                {
                  key: 'count',
                  header: fa.payments.revenuePaid,
                  render: (row) => <span className="tnum">{fmtNumber(row.paidCount)}</span>,
                },
                {
                  key: 'sum',
                  header: fa.payments.revenueTotal,
                  render: (row) => <span className="tnum">{row.paidTomanLabelFa}</span>,
                },
              ]}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function DepositQueue({
  api,
  onAttached,
}: {
  api: ApiClient;
  onAttached: () => void;
}): JSX.Element {
  const queue = useResource<{ items: CardDepositRow[]; total: number }>(
    () =>
      api.get<{ items: CardDepositRow[]; total: number }>('/v1/admin/card-deposits', {
        status: 'UNMATCHED',
        limit: 20,
      }),
    [],
  );
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attach = async (depositId: string): Promise<void> => {
    const paymentId = (targets[depositId] ?? '').trim();
    if (paymentId.length === 0) return;
    setBusy(depositId);
    setMessage(null);
    setError(null);
    try {
      await api.post(`/v1/admin/card-deposits/${depositId}/attach`, { paymentId });
      setMessage(fa.payments.depositAttached);
      queue.reload();
      onAttached();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    } finally {
      setBusy(null);
    }
  };

  const items = queue.data?.items ?? [];

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">{fa.payments.depositsTitle}</h2>
        <span className="chip">{fmtNumber(queue.data?.total ?? 0)}</span>
      </div>
      <p className="text-xs text-muted">{fa.payments.depositsLead}</p>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {queue.error ? <Notice tone="error">{queue.error.message}</Notice> : null}
      {queue.loading && !queue.data ? <Notice>{fa.app.loading}</Notice> : null}
      {!queue.loading && items.length === 0 ? <Notice>{fa.payments.depositNone}</Notice> : null}
      {items.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2"
          data-testid="card-deposit"
        >
          <div className="min-w-40 text-xs">
            <p className="font-bold tnum">{fmtToman(row.amountToman)}</p>
            <p className="text-muted">
              {fa.payments.depositReference}: <span className="tnum">{row.reference}</span>
            </p>
            <p className="text-muted">
              {fa.payments.depositSender}: {row.senderName ?? '—'} · {fmtDateTime(row.receivedAt)}
            </p>
          </div>
          <div className="flex flex-1 items-end gap-2">
            <Field label={fa.payments.depositAttach}>
              <input
                className="input tnum"
                dir="ltr"
                placeholder="payment id"
                value={targets[row.id] ?? ''}
                onChange={(event) => setTargets({ ...targets, [row.id]: event.target.value })}
              />
            </Field>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === row.id}
              onClick={() => void attach(row.id)}
            >
              {fa.payments.depositAttach}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PaymentsPage({ api }: { api: ApiClient }): JSX.Element {
  const [status, setStatus] = useState<PaymentStatus | ''>('PENDING');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState('');
  const [newCard, setNewCard] = useState(false);
  const [card, setCard] = useState({ cardNumber: '', holderName: '', bankName: '' });

  const payments = useResource<{ items: PaymentRow[] }>(
    () =>
      api.get<{ items: PaymentRow[] }>('/v1/admin/payments', {
        status: status || undefined,
        limit: 50,
      }),
    [status],
  );
  const cards = useResource<{ items: PaymentCardRow[] }>(
    () => api.get<{ items: PaymentCardRow[] }>('/v1/admin/payment-cards'),
    [],
  );

  const act = async (run: () => Promise<unknown>, success: string): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      await run();
      setMessage(success);
      payments.reload();
      cards.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold">{fa.payments.title}</h1>
        <div className="flex items-center gap-2">
          <select
            className="input w-40"
            value={status}
            onChange={(event) => setStatus(event.target.value as PaymentStatus | '')}
          >
            <option value="">{fa.app.all}</option>
            {PAYMENT_STATUSES.map((item) => (
              <option key={item} value={item}>
                {statusFa(item)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void act(() => api.post('/v1/admin/reconciliation', {}), 'هم‌فرم‌سازی اجرا شد.')
            }
          >
            {fa.payments.reconcile}
          </button>
        </div>
      </div>

      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <RevenueCard
        api={api}
        onRetried={() => {
          payments.reload();
        }}
      />

      <DepositQueue api={api} onAttached={() => payments.reload()} />

      <div className="card">
        {payments.loading && !payments.data ? (
          <Notice>{fa.app.loading}</Notice>
        ) : (
          <DataTable
            rows={payments.data?.items ?? []}
            empty={fa.app.empty}
            columns={[
              {
                key: 'amount',
                header: fa.payments.amount,
                render: (row) => fmtToman(row.amountToman),
              },
              {
                key: 'unique',
                header: fa.payments.unique,
                render: (row) =>
                  row.uniqueAmountToman === null ? '—' : fmtToman(row.uniqueAmountToman),
              },
              {
                key: 'provider',
                header: fa.payments.provider,
                render: (row) => statusFa(row.provider),
              },
              {
                key: 'status',
                header: fa.orders.status,
                render: (row) => <Badge value={row.status} />,
              },
              {
                key: 'reference',
                header: fa.payments.reference,
                render: (row) => <span className="tnum">{row.reference ?? '—'}</span>,
              },
              {
                key: 'created',
                header: fa.audit.createdAt,
                render: (row) => fmtDateTime(row.createdAt),
              },
              {
                key: 'actions',
                header: '',
                render: (row) =>
                  // G-11: a review-mode proof waits in NEEDS_REVIEW — same approve/reject actions.
                  row.status === 'PENDING' || row.status === 'NEEDS_REVIEW' ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn btn-primary px-2 py-1 text-xs"
                        onClick={() =>
                          void act(
                            () => api.post(`/v1/admin/payments/${row.id}/confirm`, {}),
                            'پرداخت تأیید شد.',
                          )
                        }
                      >
                        {fa.payments.approve}
                      </button>
                      <button
                        type="button"
                        className="btn px-2 py-1 text-xs"
                        onClick={() => {
                          setRejecting(row);
                          setReason('');
                        }}
                      >
                        {fa.payments.reject}
                      </button>
                    </div>
                  ) : null,
              },
            ]}
          />
        )}
      </div>

      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">{fa.payments.cards}</h2>
          <button type="button" className="btn px-2 py-1 text-xs" onClick={() => setNewCard(true)}>
            {fa.payments.addCard}
          </button>
        </div>
        <DataTable
          rows={cards.data?.items ?? []}
          empty={fa.app.empty}
          columns={[
            {
              key: 'number',
              header: fa.payments.card,
              render: (row) => <span className="tnum">{row.maskedNumber}</span>,
            },
            { key: 'holder', header: fa.payments.holder, render: (row) => row.holderName },
            { key: 'bank', header: fa.payments.bank, render: (row) => row.bankName ?? '—' },
            {
              key: 'active',
              header: fa.users.status,
              render: (row) => <Badge value={row.isActive ? 'ACTIVE' : 'CANCELLED'} />,
            },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                row.isActive ? (
                  <button
                    type="button"
                    className="btn px-2 py-1 text-xs"
                    onClick={() =>
                      void act(
                        () => api.post(`/v1/admin/payment-cards/${row.id}/deactivate`, {}),
                        'کارت غیرفعال شد.',
                      )
                    }
                  >
                    {fa.payments.deactivate}
                  </button>
                ) : null,
            },
          ]}
        />
      </div>

      <Modal
        title={fa.payments.reject}
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        footer={
          <button
            type="button"
            className="btn btn-danger"
            disabled={reason.trim().length < 3}
            onClick={() => {
              const target = rejecting;
              setRejecting(null);
              if (target) {
                void act(
                  () => api.post(`/v1/admin/payments/${target.id}/reject`, { reason }),
                  'پرداخت رد شد.',
                );
              }
            }}
          >
            {fa.app.confirm}
          </button>
        }
      >
        <Field label={fa.payments.rejectReason}>
          <input
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </Modal>

      <Modal
        title={fa.payments.addCard}
        open={newCard}
        onClose={() => setNewCard(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={card.cardNumber.length < 16 || card.holderName.trim().length < 2}
            onClick={() => {
              setNewCard(false);
              void act(() => api.post('/v1/admin/payment-cards', card), 'کارت اضافه شد.');
              setCard({ cardNumber: '', holderName: '', bankName: '' });
            }}
          >
            {fa.app.save}
          </button>
        }
      >
        <Field label={fa.payments.card} hint="۱۶ رقم، بدون فاصله">
          <input
            className="input tnum"
            dir="ltr"
            value={card.cardNumber}
            onChange={(event) => setCard({ ...card, cardNumber: event.target.value })}
          />
        </Field>
        <Field label={fa.payments.holder}>
          <input
            className="input"
            value={card.holderName}
            onChange={(event) => setCard({ ...card, holderName: event.target.value })}
          />
        </Field>
        <Field label={fa.payments.bank}>
          <input
            className="input"
            value={card.bankName}
            onChange={(event) => setCard({ ...card, bankName: event.target.value })}
          />
        </Field>
      </Modal>
    </section>
  );
}
