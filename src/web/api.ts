import type { HealthResult, Mapping, Snapshot } from '../core/types.js';
import type { LocalStatus } from '../core/process-manager.js';
import type { Prefs } from '../core/state.js';

export interface DashboardState {
  snapshot: Snapshot | null;
  local: LocalStatus | null;
  prefs: Prefs;
  baseDomain: string;
  updatedAt: string;
  error: { message: string; hints: string[] } | null;
}

export interface ApiError {
  error: string;
  hints: string[];
  kind: string;
}

/** Los errores de la API llegan con pistas accionables; las conservamos. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data as ApiError | null;
    throw new RequestError(e?.error ?? `HTTP ${res.status}`, e?.hints ?? []);
  }
  return data as T;
}

export interface CreateResponse {
  mapping: Mapping;
  dnsCreated: boolean;
  health: HealthResult;
  isVite: boolean;
  viteHelp: { snippet: string; why: string[] } | null;
}

export const api = {
  state: () => req<DashboardState>('/state'),
  sync: () => req<DashboardState>('/sync', { method: 'POST' }),

  create: (subdomain: string, port: number, protocol: string) =>
    req<CreateResponse>('/mappings', {
      method: 'POST',
      body: JSON.stringify({ subdomain, port, protocol }),
    }),
  update: (sub: string, port?: number, protocol?: string) =>
    req<Mapping>(`/mappings/${sub}`, { method: 'PATCH', body: JSON.stringify({ port, protocol }) }),
  disable: (sub: string) => req(`/mappings/${sub}/disable`, { method: 'POST' }),
  enable: (sub: string, port?: number) =>
    req(`/mappings/${sub}/enable`, { method: 'POST', body: JSON.stringify({ port }) }),
  remove: (sub: string, keepDns = false) =>
    req(`/mappings/${sub}?keepDns=${keepDns}`, { method: 'DELETE' }),

  logs: (n = 200) => req<{ lines: string[]; mode: string }>(`/logs?n=${n}`),
  serviceAction: (action: 'start' | 'stop' | 'restart') =>
    req<{ ok: boolean; command: string; code: number | null }>(`/service/${action}`, { method: 'POST' }),
  sudoCached: () => req<{ cached: boolean }>('/service/sudo-cached'),
  sudoCommand: (action: string) => req<{ command: string }>(`/sudo-command/${action}`),

  prefs: (patch: Partial<Prefs>) => req<Prefs>('/prefs', { method: 'PUT', body: JSON.stringify(patch) }),
  viteSnippet: () => req<{ snippet: string; why: string[] }>('/vite-snippet'),
};

/** Suscripcion SSE: el servidor manda el estado completo en cada cambio. */
export function subscribe(handlers: {
  onState: (s: DashboardState) => void;
  onLog: (line: string) => void;
  onStatus?: (connected: boolean) => void;
}): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => handlers.onState(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('log', (e) => handlers.onLog(JSON.parse((e as MessageEvent).data)));
  es.onopen = () => handlers.onStatus?.(true);
  es.onerror = () => handlers.onStatus?.(false);
  return () => es.close();
}
