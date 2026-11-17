import { useState } from 'react';
import type { ApiClient } from '../lib/api.js';
import { fmtDateTime, fmtNumber } from '../lib/format.js';
import { useResource } from '../lib/useResource.js';
import type { InfraOverview, InfraResourceRow, InfraStatus } from '../lib/types.js';
import { checkTone, summarize, worstStatus } from '../lib/infra.js';
import { DataTable, Field, Modal, Notice, StatCard } from '../components/ui.js';
import fa from '../i18n/fa.json';

/**
 * G-13 — the infrastructure screen.
 *
 * Two questions during an incident, one page: *what is broken right now* (a colour per subsystem,
 * with the time it was last checked) and *what are we made of* (the inventory of databases, queues,
 * SMS accounts and gateways, with addresses and credentials).
 *
 * The credentials rule is enforced by the API, not by this form: a secret goes up, and never comes
 * back down — the table only ever learns «کلید ذخیره شده».
 */

const STATUS_LABEL: Record<InfraStatus, string> = {
  OK: fa.status.ok,
  WARN: fa.status.warn,
  DOWN: fa.status.down,
};

const KIND_LABEL: Record<string, string> = fa.status.kinds;

const emptyForm = {
  name: '',
  kind: 'DATABASE',
  address: '',
  secret: '',
  isActive: true,
};

export function StatusPage({ api }: { api: ApiClient }): JSX.Element {
  const board = useResource<InfraOverview>(() => api.get<InfraOverview>('/v1/admin/infra'), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<InfraResourceRow | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setForm({ ...emptyForm });
    setError(null);
    setOpen(true);
  };

  const openEdit = (row: InfraResourceRow): void => {
    setEditing(row);
    // The secret box stays empty on purpose: an empty box means «unchanged».
    setForm({ name: row.name, kind: row.kind, address: row.address, secret: '', isActive: row.isActive });
    setError(null);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      kind: form.kind,
      address: form.address.trim(),
      isActive: form.isActive,
    };
    if (form.secret.trim() !== '') payload['secret'] = form.secret.trim();
    try {
      if (editing) {
        await api.patch(`/v1/admin/infra/${editing.id}`, payload);
        setMessage(fa.status.saved);
      } else {
        await api.post('/v1/admin/infra', payload);
        setMessage(fa.status.created);
      }
      setOpen(false);
      board.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  const remove = async (row: InfraResourceRow): Promise<void> => {
    if (!window.confirm(fa.status.removeConfirm)) return;
    setError(null);
    try {
      await api.del(`/v1/admin/infra/${row.id}`);
      setMessage(fa.status.removed);
      board.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  if (board.loading && !board.data) return <Notice>{fa.app.loading}</Notice>;
  if (board.error) return <Notice tone="error">{board.error.message}</Notice>;
  const data = board.data;
  if (!data) return <Notice>{fa.app.empty}</Notice>;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">{fa.status.title}</h1>
          <p className="text-xs text-muted">{fa.status.subtitle}</p>
          <p className="mt-1 text-[11px] tnum">
            {summarize(data.checks).OK} {fa.status.ok} · {summarize(data.checks).WARN}{' '}
            {fa.status.warn} · {summarize(data.checks).DOWN} {fa.status.down}
            {worstStatus(data.checks) === 'DOWN' ? (
              <span className="ms-2 font-bold text-danger">— نیاز به رسیدگی</span>
            ) : null}
          </p>
        </div>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={board.reload}>
          {fa.app.refresh}
        </button>
      </div>

      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data.mode === 'memory' ? (
        <Notice tone="error">
          در حالت حافظه موقت، داده‌ها با ری‌استارت پاک می‌شوند؛ فقط برای توسعه.
        </Notice>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data.checks.map((check) => (
          <div key={check.key} className="card">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-bold">{check.labelFa}</span>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${checkTone(check.status)}`}
              >
                {STATUS_LABEL[check.status]}
              </span>
            </div>
            <p className="text-xs text-muted">{check.detailFa}</p>
            <p className="mt-1 text-[11px] text-muted tnum">
              {fa.status.lastChecked}: {fmtDateTime(check.checkedAt)}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={fa.status.version}
          value={data.version}
          hint={data.nodeEnv}
        />
        <StatCard
          label={fa.status.migrations}
          // Just the number: the full file name («0013_infra_resources») turns into bidi soup in an
          // RTL box, and the owner only needs to know which migration is the newest.
          value={data.migrations.latest?.split('_')[0] ?? '—'}
          hint={data.migrations.detailFa}
        />
        <StatCard
          label={fa.status.disk}
          value={data.disk ? `${fmtNumber(data.disk.usedPercent)}٪` : '—'}
          hint={
            data.disk
              ? `${fa.status.diskFree}: ${fmtNumber(Math.round(data.disk.freeBytes / 1_073_741_824))} GB`
              : 'در دسترس نیست'
          }
        />
        <StatCard
          label={fa.status.counts}
          value={fmtNumber(data.counts.tradesToday)}
          hint={`${fa.status.ordersToday}: ${fmtNumber(data.counts.ordersToday)} · ${fa.status.usersCount}: ${fmtNumber(data.counts.users)}`}
        />
      </div>

      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold">{fa.status.resources}</h2>
            <p className="text-xs text-muted">{fa.status.resourcesHint}</p>
          </div>
          <button type="button" className="btn px-2 py-1 text-xs" onClick={openCreate}>
            {fa.status.addResource}
          </button>
        </div>
        <DataTable
          rows={data.resources}
          empty={fa.status.emptyResources}
          columns={[
            { key: 'name', header: fa.status.name, render: (row) => row.name },
            {
              key: 'kind',
              header: fa.status.kind,
              render: (row) => KIND_LABEL[row.kind] ?? row.kind,
            },
            {
              key: 'address',
              header: fa.status.address,
              render: (row) => (
                <span dir="ltr" className="font-mono text-[11px]">
                  {row.address}
                </span>
              ),
            },
            {
              key: 'secret',
              header: fa.status.secret,
              render: (row) => (
                <span className={row.secretSet ? 'text-success' : 'text-muted'}>
                  {row.secretSet ? fa.status.secretSet : fa.status.secretNotSet}
                </span>
              ),
            },
            {
              key: 'active',
              header: fa.status.active,
              render: (row) => (row.isActive ? fa.status.ok : fa.status.warn),
            },
            {
              key: 'updatedAt',
              header: fa.status.lastChecked,
              render: (row) => fmtDateTime(row.updatedAt),
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
                  <button
                    type="button"
                    className="btn btn-danger px-2 py-0.5 text-[11px]"
                    onClick={() => void remove(row)}
                  >
                    {fa.status.remove}
                  </button>
                </div>
              ),
            },
          ]}
        />
      </div>

      <Modal
        title={editing ? fa.status.editResource : fa.status.addResource}
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={form.name.trim().length < 2 || form.address.trim().length < 2}
            onClick={() => void save()}
          >
            {fa.app.save}
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={fa.status.name}>
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={fa.status.kind}>
            <select
              className="input"
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            >
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={fa.status.address} hint={fa.status.addressHint}>
            <input
              className="input"
              dir="ltr"
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
            />
          </Field>
          <Field label={fa.status.secret} hint={fa.status.secretHint}>
            <input
              className="input"
              dir="ltr"
              type="password"
              autoComplete="new-password"
              placeholder={editing?.secretSet ? '••••' : ''}
              value={form.secret}
              onChange={(event) => setForm({ ...form, secret: event.target.value })}
            />
          </Field>
          <Field label={fa.status.active}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
              />
              {fa.status.active}
            </label>
          </Field>
        </div>
      </Modal>
    </section>
  );
}
