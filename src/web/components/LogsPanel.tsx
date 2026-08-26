import { useEffect, useRef, useState } from 'react';

function lineClass(line: string): string {
  if (/\bERR\b|\berror\b/i.test(line)) return 'l-err';
  if (/\bWRN\b|\bwarn\b/i.test(line)) return 'l-warn';
  if (/Registered tunnel connection|Updated to new configuration/i.test(line)) return 'l-ok';
  return '';
}

export function LogsPanel({ lines, mode }: { lines: string[]; mode: string }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLPreElement>(null);

  const shown = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  useEffect(() => {
    if (autoScroll && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, autoScroll]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Logs de cloudflared</span>
        <span className="hint">{mode === 'spawn' ? 'proceso hijo' : 'servicio de launchd'}</span>
        <span className="spacer" />
        <input
          placeholder="filtrar…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 140 }}
        />
        <button className="ghost" onClick={() => setAutoScroll((v) => !v)} title="Seguir el final del log">
          {autoScroll ? '↓ auto' : '↓ manual'}
        </button>
      </div>
      <pre className="logs" ref={box}>
        {shown.length === 0
          ? '(sin líneas)'
          : shown.map((l, i) => (
              <div key={i} className={lineClass(l)}>
                {l}
              </div>
            ))}
      </pre>
    </div>
  );
}
