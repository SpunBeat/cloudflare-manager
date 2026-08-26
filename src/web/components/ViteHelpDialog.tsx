import { Dialog, Alert } from './Dialog.js';

interface Props {
  hostname: string;
  snippet: string;
  why: string[];
  onClose: () => void;
}

export function ViteHelpDialog({ hostname, snippet, why, onClose }: Props) {
  return (
    <Dialog
      title="Detecté un dev server de Vite"
      onClose={onClose}
      footer={
        <>
          <button onClick={() => void navigator.clipboard.writeText(snippet)}>Copiar snippet</button>
          <button className="primary" onClick={onClose}>
            Entendido
          </button>
        </>
      }
    >
      <Alert kind="info">
        <span>
          <code className="mono">{hostname}</code> ya está publicado, pero Vite lo rechazará hasta
          que agregues esto a tu <code>vite.config</code>.
        </span>
      </Alert>
      <pre className="snippet">{snippet}</pre>
      <div className="stack">
        {why.map((w) => (
          <div key={w} className="hint">
            • {w}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
