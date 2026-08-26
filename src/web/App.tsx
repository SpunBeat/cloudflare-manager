import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, RequestError, type CreateResponse, type DashboardState } from './api.js';
import { TunnelPanel } from './components/TunnelPanel.js';
import { MappingsTable } from './components/MappingsTable.js';
import { NewMappingDialog } from './components/NewMappingDialog.js';
import { ViteHelpDialog } from './components/ViteHelpDialog.js';
import { QrDialog } from './components/QrDialog.js';
import { LogsPanel } from './components/LogsPanel.js';
import { Alert } from './components/Dialog.js';

const MAX_LOG_LINES = 400;

export function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hints: string[] } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [viteHelp, setViteHelp] = useState<{ hostname: string; snippet: string; why: string[] } | null>(null);
  const logBuffer = useRef<string[]>([]);

  useEffect(() => {
    void api.logs(200).then((r) => {
      logBuffer.current = r.lines;
      setLogs(r.lines);
    });
    return subscribe({
      onState: setState,
      onLog: (line) => {
        // Buffer acotado: una sesion larga acumularia miles de nodos.
        logBuffer.current = [...logBuffer.current, line].slice(-MAX_LOG_LINES);
        setLogs(logBuffer.current);
      },
      onStatus: setConnected,
    });
  }, []);

  const handleError = useCallback((err: unknown) => {
    setError({
      message: err instanceof Error ? err.message : String(err),
      hints: err instanceof RequestError ? err.hints : [],
    });
  }, []);

  function onCreated(res: CreateResponse) {
    setShowNew(false);
    if (res.viteHelp) {
      setViteHelp({
        hostname: res.mapping.hostname,
        snippet: res.viteHelp.snippet,
        why: res.viteHelp.why,
      });
    } else if (res.health && !res.health.ok) {
      setError({
        message: `${res.mapping.hostname} está publicado, pero nada responde en el puerto ${res.mapping.port}.`,
        hints: ['Arranca tu dev server; el mapeo ya existe y no hace falta recrearlo.'],
      });
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>tunnel-manager</h1>
        <span className="domain">{state?.baseDomain ?? '…'}</span>
        <span className="spacer" />
        <span className={`live ${connected ? '' : 'off'}`}>
          <span className="dot" />
          {connected ? 'en vivo' : 'desconectado'}
        </span>
        <button className="ghost" disabled={busy} onClick={() => void api.sync().catch(handleError)}>
          ⟳ Sincronizar
        </button>
      </div>

      {error && (
        <Alert kind="error">
          <span>{error.message}</span>
          {error.hints.map((h) => (
            <span key={h} className="hint">
              → {h}
            </span>
          ))}
          <span>
            <button className="ghost" onClick={() => setError(null)}>
              cerrar
            </button>
          </span>
        </Alert>
      )}

      {state ? (
        <>
          <TunnelPanel state={state} onBusy={setBusy} />
          <MappingsTable
            mappings={state.snapshot?.mappings ?? []}
            busy={busy}
            onBusy={setBusy}
            onError={handleError}
            onQr={setQr}
            onNew={() => setShowNew(true)}
          />
          <LogsPanel lines={logs} mode={state.local?.mode ?? 'service'} />
        </>
      ) : (
        <div className="panel">
          <div className="empty">Conectando con el servidor…</div>
        </div>
      )}

      {showNew && state && (
        <NewMappingDialog
          baseDomain={state.baseDomain}
          onClose={() => setShowNew(false)}
          onCreated={onCreated}
        />
      )}
      {qr && <QrDialog hostname={qr} onClose={() => setQr(null)} />}
      {viteHelp && <ViteHelpDialog {...viteHelp} onClose={() => setViteHelp(null)} />}
    </div>
  );
}
