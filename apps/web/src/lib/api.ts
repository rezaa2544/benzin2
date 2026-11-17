export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** Fastify's request id; the server logs the same value, so it is the one thing support can search. */
  requestId?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** The client never owns storage; the session module does, and hands over these hooks. */
export interface ApiDeps {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  onTokens: (tokens: Tokens) => void;
  onLogout: () => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
    /**
     * G-21: the tracking code the user reads out loud. The server already sends it with every
     * error; dropping it here meant the UI could only say «خطا» and support had nothing to grep.
     */
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const NETWORK: ApiErrorShape = { code: 'NETWORK', message: 'شبکه در دسترس نیست' };

/**
 * Thin JSON client for `/v1` (task E9-03). Relative base URL only — the browser talks to
 * its own origin and Vite/Caddy proxy `/v1` to the API, so no host is ever hard-coded and
 * the sandbox preview keeps working. A 401 triggers exactly one refresh attempt.
 */
export class ApiClient {
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly deps: ApiDeps) {}

  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  del<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, { body });
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const base = this.deps.baseUrl ?? '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; retried?: boolean } = {},
  ): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.deps.getAccessToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(this.url(path, options.query), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new ApiError(NETWORK.code, NETWORK.message, 0);
    }

    if (response.status === 401 && !options.retried) {
      const refreshed = await this.refresh();
      if (refreshed) {
        return this.request<T>(method, path, { ...options, retried: true });
      }
      this.deps.onLogout();
      throw new ApiError('UNAUTHORIZED', 'نشست منقضی شد؛ دوباره وارد شو', 401);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      const envelope = (payload as { error?: ApiErrorShape } | null)?.error;
      throw new ApiError(
        envelope?.code ?? 'HTTP_ERROR',
        envelope?.message ?? `HTTP ${response.status}`,
        response.status,
        envelope?.details ?? {},
        envelope?.requestId ?? null,
      );
    }
    return payload as T;
  }

  /** Single-flight refresh: concurrent 401s share one rotation instead of racing. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      const refreshToken = this.deps.getRefreshToken();
      if (!refreshToken) return false;
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      try {
        const response = await fetchImpl(this.url('/v1/auth/refresh'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as Tokens;
        this.deps.onTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The tracking code for an error, short enough to read over the phone. Falls back to a locally
 * generated code so *every* error has something to quote — a user staring at a dead screen with no
 * code is the case this exists for.
 */
export function errorTracking(error: unknown): string {
  if (error instanceof ApiError && error.requestId) {
    return `#${error.requestId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }
  return '#LOCAL';
}

const PERSIAN = /[\u0600-\u06FF]/;

/**
 * Persian message for an error code.
 *
 * G-21: the order is *mapped code → Persian server message → generic Persian line*. Handing the
 * raw server message to the screen leaked English («Unexpected server error») into a Persian UI
 * whenever the code was not in the local map, which is exactly what the spec forbids.
 */
export function errorMessage(error: unknown, map: Record<string, string>): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') return map['NETWORK'] ?? 'شبکه در دسترس نیست';
    const mapped = map[error.code];
    if (mapped) return mapped;
    if (PERSIAN.test(error.message)) return error.message;
    return map['UNKNOWN'] ?? 'خطای غیرمنتظره؛ دوباره تلاش کن.';
  }
  return map['UNKNOWN'] ?? 'خطای غیرمنتظره؛ دوباره تلاش کن.';
}
