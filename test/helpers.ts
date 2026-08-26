import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudflareClient } from '../src/core/cloudflare-client.js';
import { DnsService } from '../src/core/dns-service.js';
import { StateStore } from '../src/core/state.js';
import { TunnelService } from '../src/core/tunnel-service.js';
import type { Config } from '../src/core/config.js';
import type { HealthResult } from '../src/core/types.js';
import { ACCOUNT, TUNNEL, ZONE, createFakeCloudflare } from './fake-cloudflare.js';

export const CONFIG: Config = {
  apiToken: 'fake-token',
  accountId: ACCOUNT,
  zoneId: ZONE,
  tunnelId: TUNNEL,
  baseDomain: 'nurbs.dev',
  apiBase: 'https://api.cloudflare.com/client/v4',
};

const HEALTHY: HealthResult = { ok: true, statusCode: 200, latencyMs: 3, via: '[::1]', checkedAt: 'now' };

export function makeHarness(init?: Parameters<typeof createFakeCloudflare>[0]) {
  const fake = createFakeCloudflare(init);
  const cf = new CloudflareClient(CONFIG.apiToken, {
    apiBase: CONFIG.apiBase,
    fetchImpl: fake.fetchImpl,
    maxRetries: 0,
  });
  const dns = new DnsService(cf, CONFIG.zoneId, CONFIG.tunnelId);
  const stateDir = mkdtempSync(join(tmpdir(), 'tm-test-'));
  const state = new StateStore(stateDir);
  const tunnel = new TunnelService(cf, CONFIG, dns, state, {
    checkHealth: async () => HEALTHY,
    detectVite: async () => false,
  });
  return {
    fake,
    cf,
    dns,
    state,
    tunnel,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
    /** Reglas de ingress actuales en el "servidor". */
    ingress: () => fake.state.config.ingress ?? [],
    hostnames: () => (fake.state.config.ingress ?? []).filter((r) => r.hostname).map((r) => r.hostname),
  };
}
