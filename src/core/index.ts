import { loadConfig, loadDotEnv, type Config } from './config.js';
import { CloudflareClient } from './cloudflare-client.js';
import { DnsService } from './dns-service.js';
import { StateStore } from './state.js';
import { TunnelService, type TunnelServiceDeps } from './tunnel-service.js';
import { ProcessManager } from './process-manager.js';

export interface Services {
  config: Config;
  cf: CloudflareClient;
  dns: DnsService;
  state: StateStore;
  tunnel: TunnelService;
  process: ProcessManager;
}

/** Punto de entrada unico: el server y el CLI construyen la misma capa. */
export function createServices(
  opts: { stateDir?: string; envPath?: string; deps?: TunnelServiceDeps } = {},
): Services {
  loadDotEnv(opts.envPath);
  const config = loadConfig();
  const cf = new CloudflareClient(config.apiToken, { apiBase: config.apiBase });
  const dns = new DnsService(cf, config.zoneId, config.tunnelId);
  const state = new StateStore(opts.stateDir);
  const tunnel = new TunnelService(cf, config, dns, state, opts.deps ?? {});
  const proc = new ProcessManager({
    mode: state.prefs.mode,
    ...(config.tunnelToken ? { tunnelToken: config.tunnelToken } : {}),
  });
  return { config, cf, dns, state, tunnel, process: proc };
}

export * from './types.js';
export * from './errors.js';
export { TunnelService, normalizeIngress, parseService, buildService, CATCH_ALL_SERVICE } from './tunnel-service.js';
export { CloudflareClient } from './cloudflare-client.js';
export { DnsService } from './dns-service.js';
export { StateStore } from './state.js';
export { checkHealth, detectVite, viteSnippet, VITE_WHY } from './health.js';
export { ProcessManager } from './process-manager.js';
export * from './launchd.js';
export { LogRing, FileFollower, readLastLines } from './logs.js';
