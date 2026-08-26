import type { HealthResult, Protocol } from './types.js';

/**
 * Vite (y varios dev servers) bindean `localhost` resolviendo SOLO a [::1].
 * Chequear unicamente 127.0.0.1 reporta "caido" un servicio perfectamente vivo,
 * asi que probamos ambas familias y reportamos cual respondio.
 */
const HOSTS = ['127.0.0.1', '[::1]'] as const;

export interface HealthOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function probe(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ statusCode: number; latencyMs: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: ac.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'tunnel-manager/healthcheck' },
    });
    return { statusCode: res.status, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Un servicio esta vivo si contesta CUALQUIER cosa por HTTP, incluido un 404:
 * el dev server esta escuchando, que es lo que nos importa. Solo ECONNREFUSED
 * (o timeout) cuenta como caido.
 */
export async function checkHealth(
  port: number,
  protocol: Protocol = 'http',
  opts: HealthOptions = {},
): Promise<HealthResult> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const f = opts.fetchImpl ?? globalThis.fetch;

  if (protocol === 'tcp') {
    return { ok: false, error: 'health check HTTP no aplica a servicios tcp://', checkedAt };
  }

  const scheme = protocol === 'https' ? 'https' : 'http';
  const errors: string[] = [];

  for (const host of HOSTS) {
    try {
      const { statusCode, latencyMs } = await probe(`${scheme}://${host}:${port}/`, timeoutMs, f);
      return { ok: true, statusCode, latencyMs, via: host, checkedAt };
    } catch (err) {
      errors.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: false, error: errors.join(' | '), checkedAt };
}

/**
 * Deteccion de Vite por su endpoint de cliente HMR, no por heuristicas sobre el
 * HTML: /@vite/client solo existe si hay un dev server de Vite detras.
 */
export async function detectVite(
  port: number,
  protocol: Protocol = 'http',
  opts: HealthOptions = {},
): Promise<boolean> {
  if (protocol === 'tcp') return false;
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const f = opts.fetchImpl ?? globalThis.fetch;
  const scheme = protocol === 'https' ? 'https' : 'http';

  for (const host of HOSTS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(`${scheme}://${host}:${port}/@vite/client`, {
        method: 'GET',
        signal: ac.signal,
        headers: { 'user-agent': 'tunnel-manager/healthcheck' },
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') ?? '';
      if (/javascript|typescript/i.test(ct)) return true;
    } catch {
      /* siguiente host */
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/** El snippet que hay que pegar en vite.config para que el tunel funcione. */
export function viteSnippet(baseDomain: string): string {
  return `server: {
  allowedHosts: ['.${baseDomain}'],
  hmr: { clientPort: 443, protocol: 'wss' },
}`;
}

export const VITE_WHY = [
  `sin allowedHosts Vite responde "Blocked request" a cualquier host que no sea localhost`,
  `sin hmr la pagina carga pero no hace hot reload desde el telefono`,
];
