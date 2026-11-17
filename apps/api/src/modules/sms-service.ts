import type { Clock, User } from '../domain/entities.js';
import type { Repositories, SmsSender } from '../ports.js';
import type { ProviderSetting } from '../domain/entities.js';
import {
  DEFAULT_OTP_MESSAGE,
  FailoverSmsSender,
  KavenegarTransport,
  SmsIrTransport,
  type FetchLike,
  type SmsAttempt,
  type SmsTransport,
} from '../infra/sms/index.js';
import type { SettingsService } from './settings-service.js';

/**
 * G-14 — the SMS panel.
 *
 * Until now the chain (sms.ir → kavenegar → console) was built once at boot from environment
 * variables: changing a key meant editing `.env` and restarting. The acceptance text asks instead
 * for keys *and templates* to come from the panel, with a «ارسال آزمایشی» button that reports what
 * the service actually answered.
 *
 * So this service owns the chain at runtime:
 *
 *  - the chain is read from `provider_settings` (kind = SMS), highest `priority` first, and the
 *    console sender is always the last link so development and CI never depend on an account;
 *  - saving a provider calls `refresh()`, which drops the cached chain — no restart;
 *  - `testSend()` walks the chain (or one named provider) and returns every attempt, including the
 *    provider's own response body, for the panel to print verbatim.
 *
 * The environment chain passed into the app stays as the fallback: a deployment that has not
 * configured anything in the panel behaves exactly as before.
 */

/**
 * The env-built chain (or the console sender in development) is the *last link* of the panel chain,
 * not a parallel system: if every provider the owner configured fails, delivery falls back to what
 * the deployment had before G-14 — and the attempt log shows that it did.
 */
const fallbackTransport = (fallback: SmsSender): SmsTransport => ({
  name: 'default',
  send: (phone, message) => fallback.send(phone, message).then(() => ({ raw: 'default chain' })),
  sendCode: (phone, code) => fallback.sendCode(phone, code).then(() => ({ raw: 'default chain' })),
});

export interface SmsChainLink {
  provider: string;
  /** Higher runs first; the console link is always 0. */
  priority: number;
  isActive: boolean;
  /** Whether a key is stored — never the key itself. */
  keySet: boolean;
  sender: string | null;
  /** The provider-side template that carries the OTP code, when one is configured. */
  template: string | null;
}

export interface SmsPanelStatus {
  /** `notification.sms_enabled` — the switch that stops notifications, not the chain itself. */
  enabled: boolean;
  /** Where the chain comes from: the panel, the environment, or the console fallback. */
  source: 'PANEL' | 'ENV' | 'CONSOLE';
  chain: SmsChainLink[];
  /** The text used for a code when a provider has no approved template. */
  otpMessage: string;
  lastAttempts: SmsAttempt[];
}

export interface SmsTestResult {
  delivered: boolean;
  attempts: SmsAttempt[];
  message: string;
}

interface SmsServiceOptions {
  /** The env-built chain, used when the panel has no active SMS provider. */
  fallback: SmsSender;
  /** Test seam: a fake fetch keeps the suite offline. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export class SmsService implements SmsSender {
  private cached: { sender: FailoverSmsSender; source: SmsPanelStatus['source'] } | null = null;
  private attempts: SmsAttempt[] = [];
  private lastOtpMessage = DEFAULT_OTP_MESSAGE;

  constructor(
    private readonly repos: Pick<Repositories, 'providerSettings' | 'audit'>,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly options: SmsServiceOptions,
  ) {}

  /** Drops the cached chain; the next send re-reads the panel. Called after every provider save. */
  refresh(): void {
    this.cached = null;
  }

  /** G-14: the OTP text is a panel setting; a template without `{code}` is ignored, not obeyed. */
  private async otpMessage(): Promise<string> {
    const config = await this.settings.get();
    const configured = config['notification.sms_otp_message'];
    const candidate = typeof configured === 'string' && configured.trim().length > 0
      ? configured
      : DEFAULT_OTP_MESSAGE;
    this.lastOtpMessage = candidate.includes('{code}') ? candidate : DEFAULT_OTP_MESSAGE;
    return this.lastOtpMessage;
  }

  private async smsSettings(): Promise<ProviderSetting[]> {
    const all = await this.repos.providerSettings.list();
    return all
      .filter((row) => row.kind === 'SMS')
      .sort((a, b) => this.priorityOf(b) - this.priorityOf(a) || a.provider.localeCompare(b.provider));
  }

  private priorityOf(setting: ProviderSetting): number {
    const value = setting.config['priority'];
    return typeof value === 'number' ? value : 0;
  }

  private transportFor(setting: ProviderSetting): SmsTransport | null {
    const apiKey = String(setting.config['apiKey'] ?? '');
    const senderLine = String(setting.config['sender'] ?? '');
    const template = setting.config['template'];
    const baseUrl = setting.config['baseUrl'];
    if (!apiKey) return null;
    try {
      if (setting.provider === 'smsir') {
        if (!senderLine) return null;
        return new SmsIrTransport({
          apiKey,
          lineNumber: senderLine,
          ...(typeof template === 'string' && template.trim() !== ''
            ? { templateId: Number(template) }
            : {}),
          ...(typeof setting.config['templateParameter'] === 'string'
            ? { templateParameter: setting.config['templateParameter'] as string }
            : {}),
          ...(typeof baseUrl === 'string' && baseUrl ? { baseUrl } : {}),
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        });
      }
      if (setting.provider === 'kavenegar') {
        if (!senderLine) return null;
        return new KavenegarTransport({
          apiKey,
          sender: senderLine,
          ...(typeof template === 'string' && template.trim() !== ''
            ? { template }
            : {}),
          ...(typeof baseUrl === 'string' && baseUrl ? { baseUrl } : {}),
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        });
      }
    } catch {
      return null;
    }
    return null;
  }

  private async chain(): Promise<{ sender: FailoverSmsSender; source: SmsPanelStatus['source'] }> {
    if (this.cached) return this.cached;
    const rows = (await this.smsSettings()).filter((row) => row.isActive);
    const transports: SmsTransport[] = [];
    for (const row of rows) {
      const transport = this.transportFor(row);
      if (transport) transports.push(transport);
    }
    if (transports.length === 0) {
      // Nothing usable in the panel: the environment chain (or the console sender in dev/tests)
      // keeps behaving exactly as it did before G-14.
      this.cached = {
        sender: new FailoverSmsSender([], () => {}, await this.otpMessage()),
        source: 'ENV',
      };
      return this.cached;
    }
    transports.push(fallbackTransport(this.options.fallback));
    this.cached = {
      sender: new FailoverSmsSender(
        transports,
        (attempt) => {
          this.attempts = [attempt, ...this.attempts].slice(0, 20);
          const log = this.options.log ?? ((line: string) => console.info(line));
          log(
            attempt.ok
              ? `[sms] delivered via ${attempt.provider} (${attempt.mode})`
              : `[sms] ${attempt.provider} failed (${attempt.mode}): ${attempt.error ?? 'unknown'}`,
          );
        },
        await this.otpMessage(),
      ),
      source: 'PANEL',
    };
    return this.cached;
  }

  private async delegate(): Promise<SmsSender> {
    const built = await this.chain();
    return built.source === 'PANEL' ? built.sender : this.options.fallback;
  }

  async send(phone: string, message: string): Promise<void> {
    await (await this.delegate()).send(phone, message);
  }

  async sendCode(phone: string, code: string): Promise<void> {
    await (await this.delegate()).sendCode(phone, code);
  }

  async status(): Promise<SmsPanelStatus> {
    const config = await this.settings.get();
    const rows = await this.smsSettings();
    const built = await this.chain();
    return {
      enabled: config['notification.sms_enabled'],
      source: built.source,
      otpMessage: this.lastOtpMessage,
      chain: [
        ...rows.map((row) => ({
          provider: row.provider,
          priority: this.priorityOf(row),
          isActive: row.isActive,
          keySet: Boolean(String(row.config['apiKey'] ?? '')),
          sender: typeof row.config['sender'] === 'string' ? (row.config['sender'] as string) : null,
          template:
            typeof row.config['template'] === 'string' && (row.config['template'] as string) !== ''
              ? (row.config['template'] as string)
              : null,
        })),
        // The default chain is part of the chain whether or not it has a row: it is the last resort.
        { provider: 'default', priority: 0, isActive: true, keySet: true, sender: null, template: null },
      ],
      lastAttempts: this.attempts,
    };
  }

  /**
   * «ارسال آزمایشی»: walks the real chain — or only the named provider, so a broken second link can
   * be tested without turning the first one off — and reports the provider's own answer.
   */
  async testSend(actor: User, phone: string, provider?: string): Promise<SmsTestResult> {
    const message = 'پیام آزمایشی بنزین: تنظیمات پنل پیامک درست است.';
    const rows = (await this.smsSettings()).filter((row) => row.isActive);
    let sender: FailoverSmsSender | null = null;

    if (provider && provider !== 'auto') {
      const row = rows.find((candidate) => candidate.provider === provider);
      if (!row) {
        return {
          delivered: false,
          attempts: [],
          message: 'این ارائه‌دهنده در پنل فعال نیست',
        };
      }
      if (provider === 'console') {
        await this.options.fallback.send(phone, message);
        const attempt: SmsAttempt = {
          provider: 'default',
          ok: true,
          status: null,
          error: null,
          mode: 'text',
          raw: 'default chain',
        };
        return { delivered: true, attempts: [attempt], message };
      }
      const transport = this.transportFor(row);
      if (!transport) {
        return {
          delivered: false,
          attempts: [],
          message: 'کلید یا شمارهٔ خط این ارائه‌دهنده در پنل ثبت نشده است',
        };
      }
      sender = new FailoverSmsSender([transport], () => {}, await this.otpMessage());
    } else {
      const built = await this.chain();
      sender =
        built.source === 'PANEL'
          ? built.sender
          : new FailoverSmsSender(
              [fallbackTransport(this.options.fallback)],
              () => {},
              await this.otpMessage(),
            );
    }

    const result = await sender.sendWithAttempts(phone, message);
    await this.repos.audit.append({
      actorId: actor.id,
      action: 'sms.tested',
      entity: 'provider',
      entityId: provider && provider !== 'auto' ? provider : 'chain',
      metadata: {
        phone,
        delivered: result.delivered,
        attempts: result.attempts.map((attempt) => ({
          provider: attempt.provider,
          ok: attempt.ok,
          status: attempt.status,
          mode: attempt.mode,
        })),
      },
    });
    return { ...result, message };
  }

  /** The panel's «ارسال آزمایشی» result must be attributable to a moment in time. */
  testedAt(): string {
    return this.clock.now().toISOString();
  }
}
