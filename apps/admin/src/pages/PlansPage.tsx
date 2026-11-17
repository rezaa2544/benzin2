import { useState } from 'react';
import type { ApiClient } from '../lib/api.js';
import { fmtNumber } from '../lib/format.js';
import { useResource } from '../lib/useResource.js';
import type { PlanRow } from '../lib/types.js';
import { Badge, DataTable, Field, Modal, Notice } from '../components/ui.js';
import fa from '../i18n/fa.json';

/**
 * G-15 — the plan catalogue lives in the database and is edited here.
 *
 * Two rules the screen makes visible: the free plan can never be retired (a new user must be able
 * to trade), and changing a price only affects future purchases — an active subscription keeps the
 * price it was charged, which is stored on its payment row.
 */
export function PlansPage({ api }: { api: ApiClient }): JSX.Element {
  const plans = useResource<{ items: PlanRow[] }>(
    () => api.get<{ items: PlanRow[] }>('/v1/admin/plans'),
    [],
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: '',
    nameFa: '',
    priceToman: '0',
    durationDays: '30',
    maxActiveOrders: '0',
    /** Empty means unlimited, which is how the paid plans are sold (G-26). */
    monthlyReservations: '',
    phoneVisible: false,
    singleUse: false,
    isActive: true,
  });

  const openCreate = (): void => {
    setEditing(null);
    setForm({
      code: '',
      nameFa: '',
      priceToman: '0',
      durationDays: '30',
      maxActiveOrders: '0',
      monthlyReservations: '',
      phoneVisible: false,
      singleUse: false,
      isActive: true,
    });
    setError(null);
    setOpen(true);
  };

  const openEdit = (plan: PlanRow): void => {
    setEditing(plan);
    setForm({
      code: plan.code,
      nameFa: plan.nameFa,
      priceToman: String(plan.priceToman),
      durationDays: String(plan.durationDays),
      maxActiveOrders: String(plan.maxActiveOrders),
      monthlyReservations:
        plan.monthlyReservations === null ? '' : String(plan.monthlyReservations),
      phoneVisible: plan.phoneVisible,
      singleUse: plan.singleUse,
      isActive: plan.isActive,
    });
    setError(null);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    const payload = {
      nameFa: form.nameFa.trim(),
      priceToman: Number(form.priceToman || 0),
      durationDays: Number(form.durationDays || 0),
      maxActiveOrders: Number(form.maxActiveOrders || 0),
      // G-26: an empty box means «نامحدود», not zero — the difference between a paid plan and one
      // that sells nothing.
      monthlyReservations:
        form.monthlyReservations.trim() === '' ? null : Number(form.monthlyReservations),
      phoneVisible: form.phoneVisible,
      singleUse: form.singleUse,
      isActive: form.isActive,
    };
    try {
      if (editing) {
        await api.patch(`/v1/admin/plans/${editing.id}`, payload);
        setMessage(fa.plans.updated);
      } else {
        await api.post('/v1/admin/plans', { ...payload, code: form.code.trim() });
        setMessage(fa.plans.created);
      }
      setOpen(false);
      plans.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  const retire = async (plan: PlanRow): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      await api.del(`/v1/admin/plans/${plan.id}`);
      setMessage(fa.plans.retired);
      plans.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{fa.plans.title}</h1>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={openCreate}>
          {fa.plans.add}
        </button>
      </div>

      <Notice>{fa.plans.hint}</Notice>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="card">
        {plans.loading && !plans.data ? (
          <Notice>{fa.app.loading}</Notice>
        ) : (
          <DataTable
            rows={plans.data?.items ?? []}
            empty={fa.app.empty}
            columns={[
              {
                key: 'name',
                header: fa.plans.name,
                render: (row) => `${row.nameFa} (${row.code})`,
              },
              {
                key: 'price',
                header: fa.plans.price,
                render: (row) => (row.priceToman === 0 ? fa.plans.free : fmtNumber(row.priceToman)),
              },
              {
                key: 'days',
                header: fa.plans.days,
                // G-26b: zero is a real setting («بدون انقضا»), not a missing value.
                render: (row) =>
                  row.durationDays > 0 ? fmtNumber(row.durationDays) : fa.plans.noExpiry,
              },
              {
                key: 'quota',
                header: fa.plans.quota,
                render: (row) => fmtNumber(row.maxActiveOrders),
              },
              {
                key: 'active',
                header: fa.plans.active,
                render: (row) => <Badge value={row.isActive ? 'ACTIVE' : 'CANCELLED'} />,
              },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn px-2 py-0.5 text-[11px]"
                      onClick={() => openEdit(row)}
                    >
                      {fa.app.edit}
                    </button>
                    {row.isActive && row.priceToman > 0 ? (
                      <button
                        type="button"
                        className="btn btn-danger px-2 py-0.5 text-[11px]"
                        onClick={() => void retire(row)}
                      >
                        {fa.plans.retire}
                      </button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>

      <Modal
        title={editing ? fa.plans.edit : fa.plans.add}
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={form.nameFa.trim().length < 2 || (!editing && form.code.trim().length < 2)}
            onClick={() => void save()}
          >
            {fa.app.save}
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={fa.plans.code} hint={fa.plans.codeHint}>
            <input
              className="input"
              dir="ltr"
              disabled={Boolean(editing)}
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
            />
          </Field>
          <Field label={fa.plans.name}>
            <input
              className="input"
              value={form.nameFa}
              onChange={(event) => setForm({ ...form, nameFa: event.target.value })}
            />
          </Field>
          <Field label={fa.plans.price} hint={fa.plans.priceHint}>
            <input
              className="input tnum"
              dir="ltr"
              inputMode="numeric"
              value={form.priceToman}
              onChange={(event) =>
                setForm({ ...form, priceToman: event.target.value.replace(/[^0-9]/g, '') })
              }
            />
          </Field>
          <Field label={fa.plans.days} hint={fa.plans.daysHint}>
            <input
              className="input tnum"
              dir="ltr"
              inputMode="numeric"
              value={form.durationDays}
              onChange={(event) =>
                setForm({ ...form, durationDays: event.target.value.replace(/[^0-9]/g, '') })
              }
            />
          </Field>
          <Field label={fa.plans.quota}>
            <input
              className="input tnum"
              dir="ltr"
              inputMode="numeric"
              value={form.maxActiveOrders}
              onChange={(event) =>
                setForm({ ...form, maxActiveOrders: event.target.value.replace(/[^0-9]/g, '') })
              }
            />
          </Field>
          <Field label={fa.plans.monthlyReservations} hint={fa.plans.monthlyReservationsHint}>
            <input
              className="input tnum"
              dir="ltr"
              inputMode="numeric"
              placeholder="∞"
              value={form.monthlyReservations}
              onChange={(event) =>
                setForm({
                  ...form,
                  monthlyReservations: event.target.value.replace(/[^0-9]/g, ''),
                })
              }
            />
          </Field>
          <Field label={fa.plans.phoneVisible}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.phoneVisible}
                onChange={(event) => setForm({ ...form, phoneVisible: event.target.checked })}
              />
              {fa.plans.phoneVisible}
            </label>
          </Field>
          <Field label={fa.plans.singleUse}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.singleUse}
                onChange={(event) => setForm({ ...form, singleUse: event.target.checked })}
              />
              {fa.plans.singleUse}
            </label>
          </Field>
          <Field label={fa.plans.active}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
              />
              {fa.plans.active}
            </label>
          </Field>
        </div>
      </Modal>
    </section>
  );
}
