import { useEffect, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ title, onClose, children, footer }: Props) {
  // Escape cierra: en un panel de control se abren y cierran dialogos a menudo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'warn' | 'error' | 'info'; children: ReactNode }) {
  return (
    <div className={`alert ${kind}`}>
      <span>{kind === 'error' ? '✕' : kind === 'warn' ? '⚠' : 'ℹ'}</span>
      <div className="stack">{children}</div>
    </div>
  );
}
