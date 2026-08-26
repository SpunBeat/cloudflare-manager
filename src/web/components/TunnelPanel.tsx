import { useState } from 'react';
import type { DashboardState } from '../api.js';
import { api } from '../api.js';
import { Alert } from './Dialog.js';

const STATUS_CLASS: Record<string, string> = {
  healthy: 'ok',
  degraded: 'warn',
  down: 'bad',
  inactive: 'dim',
};

export function TunnelPanel({ state, onBusy }: { state: DashboardState; onBusy: (b: boolean) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const t = state.snapshot?.tunnel;
  const local = state.local;

  async function runService(action: 'start' | 'stop' | 'restart') {
    const { command } = await api.sudoCommand(action);
    const { cached } = await api.sudoCached();
    const warning = cached
      ? ''
      : '\n\nsudo pedira tu contrasena EN LA TERMINAL donde corre el servidor, no aqui.';
    if (!confirm(`Se ejecutara:\n\n${command}${warning}\n\nContinuar?`)) return;

    setPending(action);
    setActionError(null);
    onBusy(true);
    try {
      const res = await api.serviceAction(action);
      if (!res.ok) setActionError(`${res.command} termino con codigo ${res.code}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      onBusy(false);
    }
  }

  const connectorCount = t?.connectors.length ?? 0;
  const colos = t?.connectors.flatMap((c) => c.colos) ?? [];

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Túnel</span>
        <span className="spacer" />
        {local?.mode === 'service' && (
          <>
            <button onClick={() => runService('restart')} disabled={pending !== null}>
              {pending === 'restart' ? '…' : 'Reiniciar'}
            </button>
            {local.launchd.state === 'running' ? (
              <button className="danger" onClick={() => runService('stop')} disabled={pending !== null}>
                {pending === 'stop' ? '…' : 'Detener'}
              </button>
            ) : (
              <button onClick={() => runService('start')} disabled={pending !== null}>
                {pending === 'start' ? '…' : 'Arrancar'}
              </button>
            )}
          </>
        )}
      </div>

      <div className="tunnel-grid">
        <Field label="nombre" value={t?.name ?? '—'} />
        <Field
          label="estado"
          node={
            t ? (
              <span className={`badge ${STATUS_CLASS[t.status] ?? 'dim'}`}>{t.status}</span>
            ) : (
              <span className="badge dim">…</span>
            )
          }
        />
        <Field
          label="conectores"
          node={
            <span className={`badge ${connectorCount === 1 ? 'ok' : connectorCount === 0 ? 'bad' : 'warn'}`}>
              {connectorCount}
            </span>
          }
        />
        <Field label="colos" value={colos.length ? [...new Set(colos)].join(' ') : '—'} />
        <Field label="config" value={t ? `v${t.configVersion} · ${t.configSource}` : '—'} />
        <Field
          label="proceso local"
          node={
            <span className={`badge ${local?.launchd.state === 'running' || local?.spawn.running ? 'ok' : 'warn'}`}>
              {local?.summary ?? '…'}
            </span>
          }
        />
      </div>

      {(t?.warnings.length || local?.warnings.length || actionError || state.error) && (
        <div className="panel-body" style={{ paddingTop: 0 }}>
          {state.error && (
            <Alert kind="error">
              <strong>No pude sincronizar con Cloudflare</strong>
              <span>{state.error.message}</span>
              {state.error.hints.map((h) => (
                <span key={h} className="hint">
                  → {h}
                </span>
              ))}
            </Alert>
          )}
          {actionError && <Alert kind="error">{actionError}</Alert>}
          {t?.warnings.map((w) => (
            <Alert kind="warn" key={w}>
              {w}
            </Alert>
          ))}
          {local?.warnings.map((w) => (
            <Alert kind="warn" key={w}>
              {w}
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, node }: { label: string; value?: string; node?: React.ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <span className="value">{node ?? value}</span>
    </div>
  );
}
