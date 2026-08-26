import type { DnsRecord, TunnelClient, TunnelConfigResult, TunnelDetail } from '../src/core/types.js';

export const ACCOUNT = 'a'.repeat(32);
export const ZONE = 'b'.repeat(32);
export const TUNNEL = 'e7c0265f-ef68-4802-9fa0-3e8b007cbcf1';
export const TARGET = `${TUNNEL}.cfargotunnel.com`;

export interface FakeOptions {
  /** Fuerza que el proximo POST de DNS falle: para probar el rollback. */
  failDnsPost?: boolean;
  /** Fuerza que el PUT de configurations falle. */
  failConfigPut?: boolean;
}

let idCounter = 0;

/**
 * Simula la API v4 al nivel de `fetch`, no del servicio: asi los tests ejercitan
 * tambien el cliente HTTP, el envelope de Cloudflare y el mapeo de errores.
 */
export function createFakeCloudflare(init?: {
  ingress?: TunnelConfigResult['config']['ingress'];
  dns?: DnsRecord[];
  clients?: TunnelClient[];
  source?: 'local' | 'cloudflare';
}) {
  const state = {
    version: 1,
    source: init?.source ?? ('cloudflare' as const),
    config: {
      ingress: init?.ingress ?? [{ service: 'http_status:404' }],
      'warp-routing': { enabled: false },
    } as TunnelConfigResult['config'],
    dns: init?.dns ? [...init.dns] : ([] as DnsRecord[]),
    clients: init?.clients ?? ([] as TunnelClient[]),
    tunnel: {
      id: TUNNEL,
      name: 'nurbs-dev',
      status: 'healthy',
      conns_active_at: '2026-08-25T18:00:00Z',
      conns_inactive_at: null,
    } as TunnelDetail,
    opts: {} as FakeOptions,
    /** Historial de PUTs de config, para verificar que nunca se escribe sin catch-all. */
    configWrites: [] as TunnelConfigResult['config'][],
  };

  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const fail = (status: number, code: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl: typeof fetch = async (input, init2) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const method = (init2?.method ?? 'GET').toUpperCase();
    const body = init2?.body ? JSON.parse(String(init2.body)) : undefined;

    // --- configuraciones del tunel ---
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) {
      if (method === 'GET') {
        return ok({ tunnel_id: TUNNEL, version: state.version, config: state.config, source: state.source });
      }
      if (method === 'PUT') {
        if (state.opts.failConfigPut) return fail(400, 1004, 'config invalida (simulado)');
        state.config = body.config;
        state.version += 1;
        state.configWrites.push(structuredClone(body.config));
        return ok({ tunnel_id: TUNNEL, version: state.version, config: state.config, source: state.source });
      }
    }

    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}` && method === 'GET') {
      return ok(state.tunnel);
    }
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/connections` && method === 'GET') {
      return ok(state.clients);
    }

    // --- DNS ---
    if (path === `/zones/${ZONE}/dns_records`) {
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        let rows = state.dns;
        if (type) rows = rows.filter((r) => r.type === type);
        if (name) rows = rows.filter((r) => r.name === name);
        return ok(rows, {
          result_info: { page: 1, per_page: 100, count: rows.length, total_count: rows.length },
        });
      }
      if (method === 'POST') {
        if (state.opts.failDnsPost) return fail(403, 1001, 'Not authorized (simulado)');
        if (state.dns.some((r) => r.name === body.name && r.type === body.type)) {
          return fail(400, 81053, 'Record already exists.');
        }
        const rec: DnsRecord = {
          id: `rec${++idCounter}`,
          name: body.name,
          type: body.type,
          content: body.content,
          proxied: body.proxied ?? false,
          ttl: body.ttl ?? 1,
          comment: body.comment ?? null,
        };
        state.dns.push(rec);
        return ok(rec);
      }
    }

    const dnsIdMatch = new RegExp(`^/zones/${ZONE}/dns_records/([^/]+)$`).exec(path);
    if (dnsIdMatch) {
      const id = dnsIdMatch[1]!;
      const idx = state.dns.findIndex((r) => r.id === id);
      if (idx === -1) return fail(404, 81044, 'Record does not exist.');
      if (method === 'PATCH') {
        state.dns[idx] = { ...state.dns[idx]!, ...body };
        return ok(state.dns[idx]);
      }
      if (method === 'DELETE') {
        const [removed] = state.dns.splice(idx, 1);
        return ok({ id: removed!.id });
      }
    }

    return fail(404, 7003, `Could not route to ${path}`);
  };

  return { state, fetchImpl };
}

export function cname(name: string, content = TARGET, proxied = true): DnsRecord {
  return { id: `rec-${name}`, name, type: 'CNAME', content, proxied, ttl: 1, comment: null };
}
