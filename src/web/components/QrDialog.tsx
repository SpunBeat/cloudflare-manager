import { Dialog } from './Dialog.js';

export function QrDialog({ hostname, onClose }: { hostname: string; onClose: () => void }) {
  const url = `https://${hostname}`;
  return (
    <Dialog title="Abrir en el teléfono" onClose={onClose} footer={<button onClick={onClose}>Cerrar</button>}>
      <div className="qr">
        <img src={`/api/qr?text=${encodeURIComponent(url)}`} alt={`QR de ${url}`} />
        <span className="url">{url}</span>
        <span className="hint">Escanéalo con la cámara; funciona desde cualquier red.</span>
      </div>
    </Dialog>
  );
}
