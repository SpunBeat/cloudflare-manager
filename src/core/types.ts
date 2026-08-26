/** Protocolo hacia el origen local. `http` es el default explicito: la mayoria
 *  de dev servers (Vite incluido) hablan HTTP plano y `https://` da 502. */
export type Protocol = 'http' | 'https' | 'tcp';

export const PROTOCOLS: readonly Protocol[] = ['http', 'https', 'tcp'];

/** Regla de ingress tal como la almacena Cloudflare. Una regla sin `hostname`
 *  es, por definicion de cloudflared, un catch-all. */
export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
}

export interface TunnelConfig {
  ingress?: IngressRule[];
  originRequest?: Record<string, unknown>;
  'warp-routing'?: { enabled: boolean };
}

/** Respuesta de GET/PUT /cfd_tunnel/{id}/configurations */
export interface TunnelConfigResult {
  tunnel_id: string;
  version: number;
  config: TunnelConfig;
  /** `local` = el tunel se configura por archivo, no por API. Escribir seria inutil. */
  source: 'local' | 'cloudflare';
  account_id?: string;
  created_at?: string;
}

export type TunnelStatus = 'inactive' | 'degraded' | 'healthy' | 'down';

export interface TunnelDetail {
  id: string;
  name: string;
  status: TunnelStatus;
  conns_active_at: string | null;
  conns_inactive_at: string | null;
  created_at?: string;
}

/** Una conexion QUIC individual hacia un colo. */
export interface TunnelConn {
  id: string;
  client_id: string;
  client_version: string;
  colo_name: string;
  origin_ip: string;
  opened_at: string;
  uuid?: string;
  is_pending_reconnect?: boolean;
}

/** Un Client = UN proceso cloudflared. Sus `conns` son las ~4 conexiones que
 *  ese unico proceso abre hacia distintos colos. Contar `conns` para detectar
 *  procesos duplicados es el error clasico; hay que contar Clients. */
export interface TunnelClient {
  id: string;
  arch?: string;
  version?: string;
  config_version?: number;
  run_at?: string;
  features?: string[];
  conns: TunnelConn[];
}

export interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string | null;
}

/**
 * - `active`        ingress + CNAME. Sirviendo.
 * - `disabled`      CNAME pero sin ingress, y lo apagamos nosotros a proposito.
 * - `orphan-dns`    CNAME apuntando al tunel sin ingress y sin registro local.
 * - `orphan-ingress` regla de ingress sin su CNAME: el hostname no resuelve.
 */
export type MappingStatus = 'active' | 'disabled' | 'orphan-dns' | 'orphan-ingress';

export interface HealthResult {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  /** En cual familia de direcciones respondio. Vite bindea solo [::1] por default. */
  via?: string;
  isVite?: boolean;
  error?: string;
  checkedAt: string;
}

export interface Mapping {
  subdomain: string;
  hostname: string;
  port: number | null;
  protocol: Protocol;
  /** El string `service` crudo del ingress, p.ej. `http://localhost:5176`. */
  service: string | null;
  status: MappingStatus;
  dns: DnsRecord | null;
  health?: HealthResult | null;
}

export interface ConnectorInfo {
  id: string;
  version?: string;
  arch?: string;
  runAt?: string;
  originIp: string;
  colos: string[];
  connCount: number;
}

export interface TunnelSnapshot {
  id: string;
  name: string;
  status: TunnelStatus;
  configSource: 'local' | 'cloudflare';
  configVersion: number;
  connectors: ConnectorInfo[];
  /** Avisos accionables: conectores duplicados, config local, catch-all raro. */
  warnings: string[];
}

export interface Snapshot {
  tunnel: TunnelSnapshot;
  mappings: Mapping[];
  baseDomain: string;
  checkedAt: string;
}
