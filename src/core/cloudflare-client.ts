import { CloudflareApiError, type CfError } from './errors.js';

export interface CfEnvelope<T> {
  success: boolean;
  errors: CfError[];
  messages: unknown[];
  result: T;
  result_info?: { page: number; per_page: number; count: number; total_count: number };
}

export interface CloudflareClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Reintentos para fallos transitorios (red, 429, 5xx). No aplica a 4xx. */
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cliente HTTP de la API v4 de Cloudflare. Escrito a mano sobre fetch:
 * el SDK oficial arrastra dependencias y oculta justo los campos que
 * necesitamos inspeccionar (source, config_version).
 */
export class CloudflareClient {
  readonly #token: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #timeoutMs: number;
  readonly #onRetry: CloudflareClientOptions['onRetry'];

  constructor(token: string, opts: CloudflareClientOptions = {}) {
    this.#token = token;
    this.#apiBase = (opts.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#baseDelayMs = opts.baseDelayMs ?? 400;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#onRetry = opts.onRetry;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<CfEnvelope<T>> {
    const url = `${this.#apiBase}${path}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        // Backoff exponencial con jitter, para no sincronizar reintentos.
        const delay = Math.round(this.#baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
        this.#onRetry?.({ attempt, delayMs: delay, reason: String(lastErr) });
        await sleep(delay);
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
      try {
        const res = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ac.signal,
        });

        const text = await res.text();
        let env: CfEnvelope<T> | undefined;
        try {
          env = text ? (JSON.parse(text) as CfEnvelope<T>) : undefined;
        } catch {
          /* respuesta no-JSON: cae al manejo de abajo */
        }

        if (res.ok && env?.success) return env;

        // Un 429 puede traer Retry-After; respetarlo gana al backoff calculado.
        if (RETRYABLE_STATUS.has(res.status) && attempt < this.#maxRetries) {
          const ra = Number(res.headers.get('retry-after'));
          if (Number.isFinite(ra) && ra > 0) await sleep(Math.min(ra * 1000, 30_000));
          lastErr = `HTTP ${res.status}`;
          continue;
        }

        throw new CloudflareApiError(method, path, res.status, env?.errors ?? []);
      } catch (err) {
        clearTimeout(timer);
        // Los errores de la API (4xx) no se reintentan: reintentar un 403 es inutil.
        if (err instanceof CloudflareApiError) throw err;
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt >= this.#maxRetries) {
          throw new Error(`${method} ${path} fallo tras ${attempt + 1} intentos: ${lastErr}`);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${method} ${path} fallo: ${String(lastErr)}`);
  }

  get<T>(path: string): Promise<CfEnvelope<T>> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown): Promise<CfEnvelope<T>> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body: unknown): Promise<CfEnvelope<T>> {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<CfEnvelope<T>> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<CfEnvelope<T>> {
    return this.request<T>('DELETE', path);
  }
}
