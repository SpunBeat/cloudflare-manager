import type { CloudflareClient } from './cloudflare-client.js';
import type { DnsService } from './dns-service.js';
import type { StateStore } from './state.js';
import type { Config } from './config.js';
import { TunnelManagerError } from './errors.js';
import { checkHealth as defaultCheckHealth, detectVite as defaultDetectVite } from './health.js';
import {
  PROTOCOLS,
  type HealthResult,
  type ConnectorInfo,
  type IngressRule,
  type Mapping,
  type Protocol,
  type Snapshot,
  type TunnelClient,
  type TunnelConfig,
  type TunnelConfigResult,
  type TunnelDetail,
  type TunnelSnapshot,
} from './types.js';

export const CATCH_ALL_SERVICE = 'http_status:404';

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSubdomain(sub: string): string {
  const s = sub.trim().toLowerCase();
  if (!s) throw new TunnelManagerError('El subdominio no puede estar vacio.');
  if (s.includes('.')) {
    throw new TunnelManagerError(
      `"${s}" tiene un punto: solo se admite un nivel de subdominio.`,
      'El certificado universal de Cloudflare cubre *.dominio pero no *.*.dominio, ' +
        'asi que un subdominio anidado daria error de TLS.',
    );
  }
  if (!LABEL_RE.test(s)) {
    throw new TunnelManagerError(
      `"${s}" no es un subdominio valido.`,
      'Solo letras, digitos y guiones; sin empezar ni terminar en guion; maximo 63 caracteres.',
    );
  }
  return s;
}

export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelManagerError(`Puerto invalido: ${port}. Debe ser un entero entre 1 y 65535.`);
  }
  return port;
}

export function validateProtocol(p: string): Protocol {
  const v = p.trim().toLowerCase() as Protocol;
  if (!PROTOCOLS.includes(v)) {
    throw new TunnelManagerError(`Protocolo invalido: "${p}". Usa uno de: ${PROTOCOLS.join(', ')}.`);
  }
  return v;
}

export function buildService(port: number, protocol: Protocol): string {
  return `${protocol}://localhost:${port}`;
}

/** Extrae puerto y protocolo de un string de servicio de ingress. */
export function parseService(service: string): { protocol: Protocol; port: number | null } {
  const m = /^(https?|tcp):\/\/[^:/]+:(\d+)/.exec(service);
  if (!m) return { protocol: 'http', port: null };
  return { protocol: m[1] as Protocol, port: Number(m[2]) };
}

/** Una regla sin `hostname` es, por definicion de cloudflared, un catch-all. */
function isCatchAll(rule: IngressRule): boolean {
  return !rule.hostname;
}

/**
 * Invariante central: el arreglo de ingress SIEMPRE termina en exactamente un
 * catch-all, y ningun catch-all queda en medio (haria inalcanzables las reglas
 * siguientes). No existe otro camino para escribir ingress, asi que no hay
 * forma de dejar el tunel sin catch-all.
 */
export function normalizeIngress(rules: IngressRule[]): IngressRule[] {
  const hostRules = rules.filter((r) => !isCatchAll(r));
  const existingCatchAll = [...rules].reverse().find(isCatchAll);
  // Respetamos un catch-all personalizado si el usuario ya tenia uno distinto.
  const service = existingCatchAll?.service ?? CATCH_ALL_SERVICE;
  return [...hostRules, { service }];
}

export interface CreateResult {
  mapping: Mapping;
  dnsCreated: boolean;
  health: HealthResult;
  isVite: boolean;
}

/**
 * Encapsula ingress + DNS como una sola operacion. Toda escritura pasa por
 * `#mutate`, que serializa (mutex), lee-modifica-escribe el arreglo completo
 * y fuerza la invariante del catch-all.
 */
export interface TunnelServiceDeps {
  /** Inyectables para poder testear sin tocar la red local. */
  checkHealth?: typeof defaultCheckHealth;
  detectVite?: typeof defaultDetectVite;
}

export class TunnelService {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #checkHealth: typeof defaultCheckHealth;
  readonly #detectVite: typeof defaultDetectVite;

  constructor(
    private readonly cf: CloudflareClient,
    private readonly cfg: Config,
    private readonly dns: DnsService,
    private readonly state: StateStore,
    deps: TunnelServiceDeps = {},
  ) {
    this.#checkHealth = deps.checkHealth ?? defaultCheckHealth;
    this.#detectVite = deps.detectVite ?? defaultDetectVite;
  }

  hostnameFor(sub: string): string {
    return `${sub}.${this.cfg.baseDomain}`;
  }

  subdomainOf(hostname: string): string | null {
    const suffix = `.${this.cfg.baseDomain}`;
    if (!hostname.endsWith(suffix)) return null;
    return hostname.slice(0, -suffix.length);
  }

  /** Serializa las escrituras: la UI y el CLI pueden pedir cambios a la vez. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --- Lectura ---

  async getConfiguration(): Promise<TunnelConfigResult> {
    const env = await this.cf.get<TunnelConfigResult>(
      `/accounts/${this.cfg.accountId}/cfd_tunnel/${this.cfg.tunnelId}/configurations`,
    );
    return env.result;
  }

  async getTunnel(): Promise<TunnelDetail> {
    const env = await this.cf.get<TunnelDetail>(
      `/accounts/${this.cfg.accountId}/cfd_tunnel/${this.cfg.tunnelId}`,
    );
    return env.result;
  }

  /**
   * Un Client = un proceso cloudflared. El campo `connections` del detalle del
   * tunel esta deprecado y ademas lista las ~4 conexiones QUIC de un mismo
   * proceso, lo que hace imposible detectar procesos duplicados.
   */
  async getConnectors(): Promise<ConnectorInfo[]> {
    const env = await this.cf.get<TunnelClient[]>(
      `/accounts/${this.cfg.accountId}/cfd_tunnel/${this.cfg.tunnelId}/connections`,
    );
    return (env.result ?? []).map((c) => ({
      id: c.id,
      version: c.version,
      arch: c.arch,
      runAt: c.run_at,
      originIp: c.conns?.[0]?.origin_ip ?? '?',
      colos: [...new Set((c.conns ?? []).map((x) => x.colo_name))].sort(),
      connCount: c.conns?.length ?? 0,
    }));
  }

  // --- Escritura ---

  async #writeConfig(base: TunnelConfig, ingress: IngressRule[]): Promise<TunnelConfigResult> {
    // Preservamos el resto de la config: PUT sobreescribe el objeto completo,
    // no solo el ingress, y perder warp-routing seria un efecto colateral silencioso.
    const config: TunnelConfig = { ...base, ingress: normalizeIngress(ingress) };
    const env = await this.cf.put<TunnelConfigResult>(
      `/accounts/${this.cfg.accountId}/cfd_tunnel/${this.cfg.tunnelId}/configurations`,
      { config },
    );
    return env.result;
  }

  /** Lee -> transforma en memoria -> escribe el arreglo completo. Serializado. */
  #mutate(fn: (rules: IngressRule[]) => IngressRule[]): Promise<{ before: TunnelConfigResult; ingress: IngressRule[] }> {
    return this.#locked(async () => {
      const before = await this.getConfiguration();
      if (before.source === 'local') {
        throw new TunnelManagerError(
          'Este tunel esta configurado localmente (source="local"), no desde Cloudflare.',
          'Escribir la config por API no tendria efecto. Convierte el tunel a remotely-managed en el dashboard.',
        );
      }
      const current = before.config.ingress ?? [];
      const next = fn(structuredClone(current));
      await this.#writeConfig(before.config, next);
      return { before, ingress: normalizeIngress(next) };
    });
  }

  /** Restaura un ingress previo tal cual (rollback). */
  async #restoreIngress(snapshot: TunnelConfigResult): Promise<void> {
    await this.#writeConfig(snapshot.config, snapshot.config.ingress ?? []);
  }

  async createMapping(
    subInput: string,
    portInput: number,
    protocolInput: Protocol = 'http',
  ): Promise<CreateResult> {
    const sub = validateSubdomain(subInput);
    const port = validatePort(portInput);
    const protocol = validateProtocol(protocolInput);
    const hostname = this.hostnameFor(sub);
    const service = buildService(port, protocol);

    const cfgBefore = await this.getConfiguration();
    if ((cfgBefore.config.ingress ?? []).some((r) => r.hostname === hostname)) {
      throw new TunnelManagerError(
        `Ya existe una regla de ingress para ${hostname}.`,
        `Usa "update ${sub} ${port}" para cambiarle el puerto.`,
      );
    }

    // Avisamos pero no bloqueamos: es normal crear el mapeo antes de arrancar el dev server.
    const health = await this.#checkHealth(port, protocol);
    const isVite = health.ok ? await this.#detectVite(port, protocol) : false;

    const { before } = await this.#mutate((rules) => [...rules, { hostname, service }]);

    let dnsCreated = false;
    try {
      const res = await this.dns.ensure(hostname);
      dnsCreated = res.created;
    } catch (err) {
      // El ingress ya se escribio: dejarlo seria un hostname sin CNAME.
      // Revertimos al snapshot exacto previo a nuestra escritura.
      try {
        await this.#restoreIngress(before);
      } catch (rollbackErr) {
        throw new TunnelManagerError(
          `Fallo crear el CNAME de ${hostname} Y fallo el rollback del ingress: ${String(rollbackErr)}`,
          `Revisa la config del tunel a mano: la regla de ${hostname} pudo quedar huerfana.`,
        );
      }
      throw err;
    }

    if (isVite) this.state.setNote(sub, { isVite: true });
    this.state.clearDisabled(sub);

    return {
      mapping: {
        subdomain: sub,
        hostname,
        port,
        protocol,
        service,
        status: 'active',
        dns: null,
        health,
      },
      dnsCreated,
      health,
      isVite,
    };
  }

  /** Cambia puerto/protocolo. Solo toca ingress: el CNAME no depende del puerto. */
  async updateMapping(subInput: string, port?: number, protocol?: Protocol): Promise<Mapping> {
    const sub = validateSubdomain(subInput);
    const hostname = this.hostnameFor(sub);

    // Si esta apagado, el "mapeo" vive solo en el estado local.
    const disabled = this.state.getDisabled(sub);
    if (disabled) {
      const nextPort = port === undefined ? disabled.port : validatePort(port);
      const nextProto = protocol === undefined ? disabled.protocol : validateProtocol(protocol);
      this.state.markDisabled(sub, nextPort, nextProto);
      return {
        subdomain: sub,
        hostname,
        port: nextPort,
        protocol: nextProto,
        service: buildService(nextPort, nextProto),
        status: 'disabled',
        dns: null,
      };
    }

    let resolvedPort = port ?? null;
    let resolvedProto: Protocol = protocol ?? 'http';

    await this.#mutate((rules) => {
      const idx = rules.findIndex((r) => r.hostname === hostname);
      if (idx === -1) {
        throw new TunnelManagerError(`No existe un mapeo activo para ${hostname}.`);
      }
      const current = parseService(rules[idx]!.service);
      resolvedPort = port === undefined ? current.port : validatePort(port);
      resolvedProto = protocol === undefined ? current.protocol : validateProtocol(protocol);
      if (resolvedPort === null) {
        throw new TunnelManagerError(
          `No pude leer el puerto actual de ${hostname} (service="${rules[idx]!.service}").`,
          'Indica el puerto explicitamente.',
        );
      }
      const next = [...rules];
      next[idx] = { ...next[idx]!, service: buildService(resolvedPort, resolvedProto) };
      return next;
    });

    return {
      subdomain: sub,
      hostname,
      port: resolvedPort,
      protocol: resolvedProto,
      service: resolvedPort === null ? null : buildService(resolvedPort, resolvedProto),
      status: 'active',
      dns: null,
    };
  }

  /** Apaga: quita el ingress (404 en el edge) pero conserva el CNAME y el puerto. */
  async disableMapping(subInput: string): Promise<{ subdomain: string; port: number; protocol: Protocol }> {
    const sub = validateSubdomain(subInput);
    const hostname = this.hostnameFor(sub);

    let saved: { port: number; protocol: Protocol } | null = null;
    await this.#mutate((rules) => {
      const rule = rules.find((r) => r.hostname === hostname);
      if (!rule) throw new TunnelManagerError(`No existe un mapeo activo para ${hostname}.`);
      const { port, protocol } = parseService(rule.service);
      if (port === null) {
        throw new TunnelManagerError(
          `No pude leer el puerto de ${hostname} (service="${rule.service}"); no lo apago para no perder el dato.`,
        );
      }
      saved = { port, protocol };
      return rules.filter((r) => r.hostname !== hostname);
    });

    const s = saved as unknown as { port: number; protocol: Protocol };
    this.state.markDisabled(sub, s.port, s.protocol);
    return { subdomain: sub, ...s };
  }

  /** Enciende: re-agrega el ingress con el puerto recordado y garantiza el CNAME. */
  async enableMapping(subInput: string, portOverride?: number): Promise<Mapping> {
    const sub = validateSubdomain(subInput);
    const hostname = this.hostnameFor(sub);
    const remembered = this.state.getDisabled(sub);

    const known = portOverride ?? remembered?.port;
    if (known === undefined) {
      throw new TunnelManagerError(
        `No recuerdo el puerto de ${hostname}.`,
        `Indicalo explicitamente: "on ${sub} <puerto>".`,
      );
    }
    const port = validatePort(known);
    const protocol = remembered?.protocol ?? 'http';
    const service = buildService(port, protocol);

    const { before } = await this.#mutate((rules) => {
      if (rules.some((r) => r.hostname === hostname)) {
        throw new TunnelManagerError(`${hostname} ya esta activo.`);
      }
      return [...rules, { hostname, service }];
    });

    try {
      await this.dns.ensure(hostname);
    } catch (err) {
      await this.#restoreIngress(before).catch(() => undefined);
      throw err;
    }

    this.state.clearDisabled(sub);
    const health = await this.#checkHealth(port, protocol);
    return { subdomain: sub, hostname, port, protocol, service, status: 'active', dns: null, health };
  }

  /** Elimina de verdad: ingress + CNAME + estado local. */
  async removeMapping(subInput: string, opts: { keepDns?: boolean } = {}): Promise<{ ingressRemoved: boolean; dnsRemoved: boolean }> {
    const sub = validateSubdomain(subInput);
    const hostname = this.hostnameFor(sub);

    let ingressRemoved = false;
    await this.#mutate((rules) => {
      const next = rules.filter((r) => r.hostname !== hostname);
      ingressRemoved = next.length !== rules.length;
      return next;
    });

    let dnsRemoved = false;
    if (!opts.keepDns) dnsRemoved = await this.dns.remove(hostname);

    this.state.forget(sub);
    return { ingressRemoved, dnsRemoved };
  }

  // --- Reconciliacion ---

  /**
   * Cruza ingress + CNAMEs + estado local. Cloudflare manda: si un mapeo existe
   * alla y no aca, aparece igual (esa es la prueba de aceptacion con parasitos).
   */
  async reconcile(opts: { health?: boolean } = {}): Promise<Snapshot> {
    const [cfgRes, tunnel, connectors, cnames] = await Promise.all([
      this.getConfiguration(),
      this.getTunnel(),
      this.getConnectors(),
      this.dns.listTunnelCnames(),
    ]);

    const ingress = cfgRes.config.ingress ?? [];
    const byHost = new Map<string, Mapping>();

    for (const rule of ingress) {
      if (!rule.hostname) continue;
      const sub = this.subdomainOf(rule.hostname);
      if (sub === null) continue; // hostname de otra zona: no es asunto nuestro
      const { port, protocol } = parseService(rule.service);
      byHost.set(rule.hostname, {
        subdomain: sub,
        hostname: rule.hostname,
        port,
        protocol,
        service: rule.service,
        status: 'orphan-ingress', // se corrige abajo si aparece su CNAME
        dns: null,
      });
    }

    for (const rec of cnames) {
      const sub = this.subdomainOf(rec.name);
      if (sub === null) continue;
      const existing = byHost.get(rec.name);
      if (existing) {
        existing.dns = rec;
        existing.status = 'active';
        continue;
      }
      // CNAME sin ingress: apagado a proposito, o huerfano de verdad.
      const disabled = this.state.getDisabled(sub);
      byHost.set(rec.name, {
        subdomain: sub,
        hostname: rec.name,
        port: disabled?.port ?? null,
        protocol: disabled?.protocol ?? 'http',
        service: disabled ? buildService(disabled.port, disabled.protocol) : null,
        status: disabled ? 'disabled' : 'orphan-dns',
        dns: rec,
      });
    }

    const mappings = [...byHost.values()].sort((a, b) => a.subdomain.localeCompare(b.subdomain));

    if (opts.health !== false) {
      await Promise.all(
        mappings.map(async (m) => {
          if (m.port === null) return;
          m.health = await this.#checkHealth(m.port, m.protocol);
        }),
      );
    }

    const warnings: string[] = [];
    if (cfgRes.source === 'local') {
      warnings.push(
        'La config del tunel es local (source="local"): los cambios por API no tendran efecto.',
      );
    }
    // Varios Clients con la misma IP = varios procesos cloudflared en este host.
    const byIp = new Map<string, ConnectorInfo[]>();
    for (const c of connectors) {
      byIp.set(c.originIp, [...(byIp.get(c.originIp) ?? []), c]);
    }
    for (const [ip, list] of byIp) {
      if (list.length > 1) {
        warnings.push(
          `Hay ${list.length} conectores desde ${ip}: probablemente tienes mas de un proceso cloudflared ` +
            `(p.ej. el servicio de launchd y uno manual). Conectores: ${list
              .map((c) => `${c.id.slice(0, 8)} (v${c.version ?? '?'}, desde ${c.runAt ?? '?'})`)
              .join(', ')}`,
        );
      }
    }
    const lastRule = ingress[ingress.length - 1];
    if (!lastRule || lastRule.hostname) {
      warnings.push('La config del tunel NO termina en una regla catch-all. Se corregira en la proxima escritura.');
    }

    const tunnelSnapshot: TunnelSnapshot = {
      id: tunnel.id,
      name: tunnel.name,
      status: tunnel.status,
      configSource: cfgRes.source,
      configVersion: cfgRes.version,
      connectors,
      warnings,
    };

    return {
      tunnel: tunnelSnapshot,
      mappings,
      baseDomain: this.cfg.baseDomain,
      checkedAt: new Date().toISOString(),
    };
  }
}
