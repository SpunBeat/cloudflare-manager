import { useState } from 'react';
import { api, RequestError, type CreateResponse } from '../api.js';
import { Dialog, Alert } from './Dialog.js';

interface Props {
  baseDomain: string;
  onClose: () => void;
  onCreated: (res: CreateResponse) => void;
}

export function NewMappingDialog({ baseDomain, onClose, onCreated }: Props) {
  const [sub, setSub] = useState('');
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState('http');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hints: string[] } | null>(null);

  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const subValid = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub);
  const canSubmit = subValid && portValid && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.create(sub, portNum, protocol));
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        hints: err instanceof RequestError ? err.hints : [],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Nuevo mapeo"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Creando…' : 'Crear'}
          </button>
        </>
      }
    >
      {error && (
        <Alert kind="error">
          <span>{error.message}</span>
          {error.hints.map((h) => (
            <span key={h} className="hint">
              → {h}
            </span>
          ))}
        </Alert>
      )}

      <div className="row">
        <label style={{ flex: 2 }}>
          Subdominio
          <input
            autoFocus
            className={sub && !subValid ? 'err' : ''}
            placeholder="mi-app"
            value={sub}
            onChange={(e) => setSub(e.target.value.toLowerCase().trim())}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
        <label>
          Puerto
          <input
            className={port && !portValid ? 'err' : ''}
            placeholder="5173"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
        <label style={{ maxWidth: 90 }}>
          Protocolo
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option value="http">http</option>
            <option value="https">https</option>
            <option value="tcp">tcp</option>
          </select>
        </label>
      </div>

      <div className="hint mono">
        {sub ? `${sub}.${baseDomain}` : `<subdominio>.${baseDomain}`} →{' '}
        {protocol}://localhost:{port || '<puerto>'}
      </div>

      {sub && !subValid && (
        <Alert kind="warn">
          Solo letras, dígitos y guiones, sin punto. Un subdominio anidado no lo cubre el
          certificado universal de Cloudflare.
        </Alert>
      )}
      {protocol === 'https' && (
        <Alert kind="warn">
          La mayoría de dev servers hablan HTTP plano; con <code>https</code> suelen dar 502.
        </Alert>
      )}
    </Dialog>
  );
}
