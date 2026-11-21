import { useState } from 'react';
import type { ApiClient } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import type { ProviderRow, SmsAttemptRow, SmsPanel, SmsTestResult } from '../lib/types.js';
import { Badge, DataTable, Field, Modal, Notice } from '../components/ui.js';
import { attemptTone, orderChain } from '../lib/sms.js';
import fa from '../i18n/fa.json';

const emptyProvider: ProviderRow = {
  id: '',
  provider: '',
  kind: 'SMS',
  isActive: true,
  config: {},
};

const SOURCE_LABEL: Record<SmsPanel['source'], string> = {
  PANEL: fa.sms.sourcePanel,
  ENV: fa.sms.sourceEnv,
  CONSOLE: fa.sms.sourceConsole,
};

/**
 * E8-06 + G-14: SMS providers, their order and templates, and a test button that shows what the
 * service actually answered.
 *
 * The old screen could save a key and printed «ارسال شد» whatever happened; nobody could tell a
 * wrong line number from a dead account. So the page now leads with the chain the platform will
 * really walk, and every test prints the provider's own response verbatim.
 */
export function SmsPage({ api }: { api: ApiClient }): JSX.Element {
  const providers = useResource<{ items: ProviderRow[] }>(
    () => api.get<{ items: ProviderRow[] }>('/v1/admin/providers'),
    [],
  );
  const panel = useResource<SmsPanel>(() => api.get<SmsPanel>('/v1/admin/sms'), []);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [form, setForm] = useState({
    provider: '',
    apiKey: '',
    sender: '',
    priority: '',
    template: '',
    templateParameter: '',
    isActive: true,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [testProvider, setTestProvider] = useState('auto');
  const [testResult, setTestResult] = useState<SmsTestResult | null>(null);
  const [otpDraft, setOtpDraft] = useState<string | null>(null);

  const reload = (): void => {
    providers.reload();
    panel.reload();
  };

  const open = (row: ProviderRow): void => {
    setEditing(row);
    setForm({
      provider: row.provider,
      apiKey: '',
      sender: String(row.config.sender ?? ''),
      priority: row.config.priority === undefined ? '' : String(row.config.priority),
      template: String(row.config.template ?? ''),
      templateParameter: String(row.config.templateParameter ?? ''),
      isActive: row.isActive,
    });
  };

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      const priority = Number(form.priority);
      await api.put('/v1/admin/providers', {
        provider: form.provider,
        kind: 'SMS',
        isActive: form.isActive,
        config: {
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          ...(form.sender ? { sender: form.sender } : {}),
          ...(form.priority.trim() !== '' && Number.isFinite(priority) ? { priority } : {}),
          ...(form.template.trim() !== '' ? { template: form.template.trim() } : {}),
          ...(form.templateParameter.trim() !== ''
            ? { templateParameter: form.templateParameter.trim() }
            : {}),
        },
      });
      setEditing(null);
      reload();
      setMessage(fa.sms.saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  const test = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    setTestResult(null);
    try {
      const result = await api.post<SmsTestResult>('/v1/admin/sms/test', {
        phone: testPhone,
        ...(testProvider === 'auto' ? {} : { provider: testProvider }),
      });
      setTestResult(result);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  const saveOtpMessage = async (): Promise<void> => {
    if (otpDraft === null) return;
    setError(null);
    setMessage(null);
    try {
      await api.patch('/v1/admin/settings', { 'notification.sms_otp_message': otpDraft });
      setOtpDraft(null);
      reload();
      setMessage(fa.sms.saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fa.app.error);
    }
  };

  const smsProviders = (providers.data?.items ?? []).filter((row) => row.kind === 'SMS');
  const chain = orderChain(panel.data?.chain ?? []);
  const attempts = testResult?.attempts ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">{fa.sms.title}</h1>
          <p className="text-xs text-muted">{fa.sms.hint}</p>
        </div>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={() => open(emptyProvider)}>
          {fa.payments.addCard.replace('کارت', 'ارائه‌دهنده')}
        </button>
      </div>

      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="card space-y-3" data-testid="sms-chain">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">{fa.sms.chain}</h2>
          <span className="text-xs text-muted">
            {fa.sms.source}: <b>{SOURCE_LABEL[panel.data?.source ?? 'ENV']}</b>
          </span>
        </div>
        <p className="text-xs text-muted">{fa.sms.chainHint}</p>
        {chain.length === 0 ? (
          <Notice>{fa.app.loading}</Notice>
        ) : (
          <ol className="space-y-2">
            {chain.map((link, index) => (
              <li
                key={`${link.provider}-${index}`}
                className="flex flex-wrap items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm"
              >
                <span className="tnum w-6 text-xs text-muted">{index + 1}</span>
                <span dir="ltr" className="font-mono text-xs">
                  {link.provider}
                </span>
                <Badge value={link.isActive ? 'ACTIVE' : 'CANCELLED'} />
                <span className="text-xs text-muted">
                  {fa.sms.priority}: <b className="tnum">{link.priority}</b>
                </span>
                {link.sender ? (
                  <span className="text-xs text-muted tnum" dir="ltr">
                    {link.sender}
                  </span>
                ) : null}
                {link.template ? (
                  <span className="text-xs text-muted">
                    {fa.sms.template}: <b dir="ltr">{link.template}</b>
                  </span>
                ) : null}
                <span className="text-xs text-muted">
                  {link.keySet ? fa.sms.keySet : fa.sms.keyMissing}
                </span>
              </li>
            ))}
          </ol>
        )}
        {panel.data?.source === 'ENV' ? <Notice>{fa.sms.noProvider}</Notice> : null}
      </div>

      <div className="card space-y-3">
        {providers.loading && !providers.data ? (
          <Notice>{fa.app.loading}</Notice>
        ) : (
          <DataTable
            rows={smsProviders}
            empty={fa.app.empty}
            columns={[
              { key: 'provider', header: fa.sms.provider, render: (row) => row.provider },
              {
                key: 'priority',
                header: fa.sms.priority,
                render: (row) => <span className="tnum">{String(row.config.priority ?? '—')}</span>,
              },
              {
                key: 'sender',
                header: fa.sms.sender,
                render: (row) => <span className="tnum">{String(row.config.sender ?? '—')}</span>,
              },
              {
                key: 'template',
                header: fa.sms.template,
                render: (row) => (
                  <span dir="ltr" className="text-xs">
                    {String(row.config.template ?? '—')}
                  </span>
                ),
              },
              {
                key: 'active',
                header: fa.sms.active,
                render: (row) => <Badge value={row.isActive ? 'ACTIVE' : 'CANCELLED'} />,
              },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <button type="button" className="btn px-2 py-1 text-xs" onClick={() => open(row)}>
                    {fa.app.save}
                  </button>
                ),
              },
            ]}
          />
        )}
      </div>

      <div className="card space-y-3" data-testid="sms-test">
        <h2 className="text-sm font-bold">{fa.sms.test}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={fa.sms.testPhone}>
            <input
              className="input tnum w-48"
              dir="ltr"
              value={testPhone}
              onChange={(event) => setTestPhone(event.target.value)}
            />
          </Field>
          <Field label={fa.sms.testProvider}>
            <select
              className="input w-56"
              value={testProvider}
              onChange={(event) => setTestProvider(event.target.value)}
            >
              <option value="auto">{fa.sms.testAuto}</option>
              {chain
                .filter((link) => link.provider !== 'default')
                .map((link) => (
                  <option key={link.provider} value={link.provider}>
                    {link.provider}
                  </option>
                ))}
            </select>
          </Field>
          <button
            type="button"
            className="btn btn-primary px-3 py-2 text-xs"
            disabled={testPhone.length < 11}
            onClick={() => void test()}
          >
            {fa.sms.test}
          </button>
        </div>

        {testResult ? (
          <div className="space-y-2">
            <Notice tone={attemptTone({ ok: testResult.delivered })}>
              {testResult.delivered ? fa.sms.delivered : fa.sms.notDelivered} — {testResult.message}
            </Notice>
            <AttemptsTable rows={attempts} empty={fa.sms.noAttempts} />
          </div>
        ) : (
          <p className="text-xs text-muted">{fa.sms.noAttempts}</p>
        )}

        {panel.data && panel.data.lastAttempts.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-muted">{fa.sms.lastAttempts}</h3>
            <AttemptsTable rows={panel.data.lastAttempts} empty={fa.sms.noAttempts} />
          </div>
        ) : null}
      </div>

      <div className="card space-y-2">
        <Field label={fa.sms.otpMessage} hint={fa.sms.otpMessageHint}>
          <input
            className="input"
            value={otpDraft ?? panel.data?.otpMessage ?? ''}
            onChange={(event) => setOtpDraft(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn px-2 py-1 text-xs"
          disabled={otpDraft === null || !otpDraft.includes('{code}')}
          onClick={() => void saveOtpMessage()}
        >
          {fa.app.save}
        </button>
      </div>

      <Modal
        title={fa.sms.title}
        open={editing !== null}
        onClose={() => setEditing(null)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={form.provider.trim().length < 2}
            onClick={() => void save()}
          >
            {fa.app.save}
          </button>
        }
      >
        <Field label={fa.sms.provider} hint="مثلاً kavenegar یا smsir">
          <input
            className="input"
            dir="ltr"
            value={form.provider}
            onChange={(event) => setForm({ ...form, provider: event.target.value })}
          />
        </Field>
        <Field label={fa.sms.apiKey} hint="پس از ذخیره فقط «••••» نمایش داده می‌شود.">
          <input
            className="input"
            dir="ltr"
            type="password"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </Field>
        <Field label={fa.sms.sender}>
          <input
            className="input tnum"
            dir="ltr"
            value={form.sender}
            onChange={(event) => setForm({ ...form, sender: event.target.value })}
          />
        </Field>
        <Field label={fa.sms.priority} hint={fa.sms.priorityHint}>
          <input
            className="input tnum w-24"
            dir="ltr"
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}
          />
        </Field>
        <Field label={fa.sms.template} hint={fa.sms.templateHint}>
          <input
            className="input"
            dir="ltr"
            value={form.template}
            onChange={(event) => setForm({ ...form, template: event.target.value })}
          />
        </Field>
        <Field label={fa.sms.templateParameter}>
          <input
            className="input"
            dir="ltr"
            value={form.templateParameter}
            onChange={(event) => setForm({ ...form, templateParameter: event.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={form.isActive}
            onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
          />
          {fa.sms.active}
        </label>
      </Modal>
    </section>
  );
}

/** Every attempt, with the provider's own words. `raw` is never paraphrased — that is the point. */
function AttemptsTable({ rows, empty }: { rows: SmsAttemptRow[]; empty: string }): JSX.Element {
  return (
    <DataTable
      rows={rows}
      empty={empty}
      columns={[
        {
          key: 'provider',
          header: fa.sms.provider,
          render: (row) => (
            <span dir="ltr" className="font-mono text-xs">
              {row.provider}
            </span>
          ),
        },
        {
          key: 'ok',
          header: fa.sms.delivered,
          render: (row) => <Badge value={row.ok ? 'PAID' : 'FAILED'} />,
        },
        {
          key: 'status',
          header: fa.sms.status,
          render: (row) => <span className="tnum text-xs">{row.status ?? '—'}</span>,
        },
        { key: 'mode', header: fa.sms.mode, render: (row) => row.mode },
        {
          key: 'raw',
          header: fa.sms.realResponse,
          render: (row) => (
            <span dir="ltr" className="block max-w-md truncate font-mono text-[11px]">
              {row.raw ?? row.error ?? '—'}
            </span>
          ),
        },
      ]}
    />
  );
}
