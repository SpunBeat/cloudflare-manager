import { useState } from 'react';
import type { Mapping } from '../../core/types.js';
import { api } from '../api.js';

const STATUS: Record<Mapping['status'], { label: string; cls: string; title: string }> = {
  active: { label: 'activo', cls: 'ok', title: 'Regla de ingress + CNAME. Sirviendo.' },
  disabled: { label: 'apagado', cls: 'dim', title: 'CNAME conservado, sin ingress: el edge responde 404.' },
  'orphan-dns': {
    label: 'dns huérfano',
    cls: 'warn',
    title: 'Existe el CNAME pero no hay regla de ingress ni registro local de que lo apagaras.',
  },
  'orphan-ingress': {
    label: 'sin dns',
    cls: 'warn',
    title: 'Hay regla de ingress pero falta el CNAME: el hostname no resuelve.',
  },
};

interface Props {
  mappings: Mapping[];
  busy: boolean;
  onBusy: (b: boolean) => void;
  onError: (e: unknown) => void;
  onQr: (hostname: string) => void;
  onNew: () => void;
}

export function MappingsTable({ mappings, busy, onBusy, onError, onQr, onNew }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftPort, setDraftPort] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    onBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      onBusy(false);
    }
  }

  function startEdit(m: Mapping) {
    setEditing(m.subdomain);
    setDraftPort(String(m.port ?? ''));
  }

  async function commitEdit(m: Mapping) {
    const port = Number(draftPort);
    setEditing(null);
    if (!Number.isInteger(port) || port === m.port) return;
    await run(() => api.update(m.subdomain, port));
  }

  async function copy(hostname: string) {
    await navigator.clipboard.writeText(`https://${hostname}`);
    setCopied(hostname);
    setTimeout(() => setCopied((c) => (c === hostname ? null : c)), 1400);
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Mapeos</span>
        <span className="hint">{mappings.length}</span>
        <span className="spacer" />
        <button className="primary" onClick={onNew}>
          + Nuevo mapeo
        </button>
      </div>

      {mappings.length === 0 ? (
        <div className="empty">
          Sin mapeos todavía. Crea uno para exponer un puerto local en tu dominio.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Servicio local</th>
              <th>Estado</th>
              <th>Salud</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => {
              const st = STATUS[m.status];
              const isOff = m.status !== 'active';
              return (
                <tr key={m.subdomain} className={isOff ? 'is-off' : ''}>
                  <td>
                    <a
                      className="host"
                      href={`https://${m.hostname}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {m.hostname}
                    </a>
                  </td>
                  <td>
                    {editing === m.subdomain ? (
                      <input
                        autoFocus
                        style={{ width: 90 }}
                        value={draftPort}
                        onChange={(e) => setDraftPort(e.target.value)}
                        onBlur={() => void commitEdit(m)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitEdit(m);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : (
                      <span
                        className="svc"
                        title="Clic para cambiar el puerto"
                        onClick={() => m.port !== null && startEdit(m)}
                        style={{ cursor: m.port !== null ? 'pointer' : 'default' }}
                      >
                        {m.service ?? '—'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${st.cls}`} title={st.title}>
                      {st.label}
                    </span>
                  </td>
                  <td className="health">
                    {m.port === null ? (
                      <span className="ms">—</span>
                    ) : !m.health ? (
                      <span className="ms">…</span>
                    ) : m.health.ok ? (
                      <>
                        <span style={{ color: 'var(--green)' }}>{m.health.statusCode}</span>{' '}
                        <span className="ms">
                          {m.health.latencyMs}ms{m.health.via === '[::1]' ? ' ipv6' : ''}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: 'var(--red)' }} title={m.health.error}>
                        caído
                      </span>
                    )}
                  </td>
                  <td className="actions">
                    <button className="icon ghost" title="Copiar URL" onClick={() => void copy(m.hostname)}>
                      {copied === m.hostname ? '✓' : '⧉'}
                    </button>
                    <button className="icon ghost qr-btn" title="QR para el teléfono" onClick={() => onQr(m.hostname)}>
                      QR
                    </button>
                    {m.status === 'active' ? (
                      <button
                        disabled={busy}
                        title="Quita el ingress; conserva el CNAME y recuerda el puerto"
                        onClick={() => void run(() => api.disable(m.subdomain))}
                      >
                        Apagar
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        title={m.port ? `Restaura el ingress en el puerto ${m.port}` : 'Pedirá un puerto'}
                        onClick={() =>
                          void run(async () => {
                            let port = m.port ?? undefined;
                            if (port === undefined) {
                              const answer = prompt(`¿En qué puerto sirve ${m.hostname}?`);
                              if (!answer) return;
                              port = Number(answer);
                            }
                            await api.enable(m.subdomain, port);
                          })
                        }
                      >
                        Encender
                      </button>
                    )}
                    <button
                      className="danger"
                      disabled={busy}
                      title="Borra la regla de ingress y el CNAME"
                      onClick={() =>
                        void run(async () => {
                          if (
                            !confirm(
                              `Borrar ${m.hostname}?\n\nSe elimina la regla de ingress Y el CNAME. ` +
                                'Esto no se puede deshacer desde aquí.',
                            )
                          )
                            return;
                          await api.remove(m.subdomain);
                        })
                      }
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
