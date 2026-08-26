import { EventEmitter } from 'node:events';
import type { Services } from '../core/index.js';
import type { Snapshot } from '../core/types.js';
import type { LocalStatus } from '../core/process-manager.js';
import type { Prefs } from '../core/state.js';
import { checkHealth } from '../core/health.js';

export interface DashboardState {
  snapshot: Snapshot | null;
  local: LocalStatus | null;
  prefs: Prefs;
  baseDomain: string;
  updatedAt: string;
  /** Ultimo error de sincronizacion; la UI lo muestra sin perder el estado previo. */
  error: { message: string; hints: string[] } | null;
}

/**
 * Mantiene el estado que consume el dashboard y lo emite por SSE.
 *
 * Dos cadencias distintas a proposito: el health check local es barato y
 * frecuente, pero la API de Cloudflare tiene rate limits y su estado cambia
 * lento, asi que la reconciliacion completa va mucho mas espaciada.
 */
export class DashboardStateService extends EventEmitter {
  #state: DashboardState;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #healthTimer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly services: Services) {
    super();
    this.setMaxListeners(50);
    this.#state = {
      snapshot: null,
      local: null,
      prefs: services.state.prefs,
      baseDomain: services.config.baseDomain,
      updatedAt: new Date().toISOString(),
      error: null,
    };
  }

  get state(): DashboardState {
    return this.#state;
  }

  #publish(patch: Partial<DashboardState>): void {
    this.#state = { ...this.#state, ...patch, updatedAt: new Date().toISOString() };
    this.emit('state', this.#state);
  }

  /** Reconciliacion completa contra Cloudflare + estado local del proceso. */
  async refresh(): Promise<DashboardState> {
    try {
      const [snapshot, local] = await Promise.all([
        this.services.tunnel.reconcile({ health: true }),
        this.services.process.status(),
      ]);
      this.#publish({ snapshot, local, prefs: this.services.state.prefs, error: null });
    } catch (err) {
      // Un fallo de red no debe vaciar la tabla: conservamos el ultimo snapshot
      // bueno y solo marcamos el error.
      const e = err as { message?: string; hints?: string[] };
      this.#publish({
        error: { message: e.message ?? String(err), hints: e.hints ?? [] },
      });
    }
    return this.#state;
  }

  /** Solo re-chequea los servicios locales; no toca la API de Cloudflare. */
  async refreshHealth(): Promise<void> {
    const snap = this.#state.snapshot;
    if (!snap) return;
    const mappings = await Promise.all(
      snap.mappings.map(async (m) => {
        if (m.port === null) return m;
        return { ...m, health: await checkHealth(m.port, m.protocol) };
      }),
    );
    const local = await this.services.process.status();
    this.#publish({ snapshot: { ...snap, mappings }, local });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.refresh();
    const prefs = this.services.state.prefs;
    this.#reconcileTimer = setInterval(() => void this.refresh(), prefs.tunnelPollMs);
    this.#healthTimer = setInterval(() => void this.refreshHealth(), prefs.healthIntervalMs);
    this.#reconcileTimer.unref?.();
    this.#healthTimer.unref?.();
  }

  /** Re-arranca los temporizadores cuando cambian los intervalos. */
  restartTimers(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#reconcileTimer = null;
    this.#healthTimer = null;
    this.#running = false;
  }
}
