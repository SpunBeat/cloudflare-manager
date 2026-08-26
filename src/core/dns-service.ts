import type { CloudflareClient } from './cloudflare-client.js';
import type { DnsRecord } from './types.js';
import { CloudflareApiError, TunnelManagerError } from './errors.js';

export class DnsService {
  constructor(
    private readonly cf: CloudflareClient,
    private readonly zoneId: string,
    private readonly tunnelId: string,
  ) {}

  get target(): string {
    return `${this.tunnelId}.cfargotunnel.com`;
  }

  /** Todos los CNAME de la zona (paginado completo). */
  async listCnames(): Promise<DnsRecord[]> {
    const out: DnsRecord[] = [];
    for (let page = 1; page <= 20; page++) {
      const env = await this.cf.get<DnsRecord[]>(
        `/zones/${this.zoneId}/dns_records?type=CNAME&per_page=100&page=${page}`,
      );
      out.push(...env.result);
      const info = env.result_info;
      if (!info || out.length >= info.total_count || env.result.length === 0) break;
    }
    return out;
  }

  /** Solo los CNAME que apuntan a NUESTRO tunel. */
  async listTunnelCnames(): Promise<DnsRecord[]> {
    return (await this.listCnames()).filter((r) => r.content === this.target);
  }

  async find(hostname: string): Promise<DnsRecord | null> {
    const env = await this.cf.get<DnsRecord[]>(
      `/zones/${this.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    return env.result[0] ?? null;
  }

  /**
   * Garantiza que exista el CNAME `hostname -> <tunnel>.cfargotunnel.com` proxied.
   * Idempotente. Devuelve `created: false` si ya estaba bien.
   * Si el hostname existe pero apunta a otro lado, NO lo pisa: eso seria destruir
   * configuracion ajena sin pedir permiso.
   */
  async ensure(hostname: string, comment?: string): Promise<{ record: DnsRecord; created: boolean }> {
    const existing = await this.find(hostname);

    if (existing) {
      if (existing.content !== this.target) {
        throw new TunnelManagerError(
          `Ya existe un CNAME para ${hostname} que apunta a "${existing.content}", no a este tunel.`,
          'Borralo a mano en el dashboard de Cloudflare si quieres reusar ese hostname.',
        );
      }
      if (!existing.proxied) {
        // Un CNAME a cfargotunnel.com sin proxy no resuelve: hay que corregirlo.
        const env = await this.cf.patch<DnsRecord>(
          `/zones/${this.zoneId}/dns_records/${existing.id}`,
          { proxied: true },
        );
        return { record: env.result, created: false };
      }
      return { record: existing, created: false };
    }

    const env = await this.cf.post<DnsRecord>(`/zones/${this.zoneId}/dns_records`, {
      type: 'CNAME',
      name: hostname,
      content: this.target,
      proxied: true,
      ttl: 1, // 1 = automatico; obligatorio cuando proxied=true
      comment: comment ?? 'gestionado por tunnel-manager',
    });
    return { record: env.result, created: true };
  }

  /** Borra el CNAME solo si apunta a nuestro tunel. Idempotente. */
  async remove(hostname: string): Promise<boolean> {
    const existing = await this.find(hostname);
    if (!existing) return false;
    if (existing.content !== this.target) {
      throw new TunnelManagerError(
        `Me niego a borrar el CNAME de ${hostname}: apunta a "${existing.content}", no a este tunel.`,
      );
    }
    try {
      await this.cf.delete(`/zones/${this.zoneId}/dns_records/${existing.id}`);
      return true;
    } catch (err) {
      // 81044 = ya no existe. Alguien mas lo borro; el objetivo se cumplio igual.
      if (err instanceof CloudflareApiError && err.has(81044)) return false;
      throw err;
    }
  }

  /** Restaura un registro borrado durante un rollback. */
  async restore(record: DnsRecord): Promise<void> {
    const existing = await this.find(record.name);
    if (existing) return;
    await this.cf.post(`/zones/${this.zoneId}/dns_records`, {
      type: 'CNAME',
      name: record.name,
      content: record.content,
      proxied: record.proxied,
      ttl: record.ttl,
      comment: record.comment ?? undefined,
    });
  }
}
