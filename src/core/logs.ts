import { createReadStream, statSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

/** Buffer circular de lineas: la UI solo necesita la cola reciente. */
export class LogRing {
  #lines: string[] = [];
  constructor(private readonly max = 500) {}

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.max) this.#lines.splice(0, this.#lines.length - this.max);
  }

  pushChunk(chunk: string): string[] {
    const lines = chunk.split('\n').filter((l) => l.length > 0);
    for (const l of lines) this.push(l);
    return lines;
  }

  get lines(): string[] {
    return [...this.#lines];
  }
  tail(n: number): string[] {
    return this.#lines.slice(-n);
  }
  clear(): void {
    this.#lines = [];
  }
}

/** Ultimas `n` lineas de un archivo, leyendo solo la cola. */
export async function readLastLines(path: string, n = 100): Promise<string[]> {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  // 512 bytes por linea es holgado para logs de cloudflared.
  const start = Math.max(0, size - n * 512);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path, { start })
      .on('data', (c) => chunks.push(c as Buffer))
      .on('end', () => resolve())
      .on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  const lines = text.split('\n').filter(Boolean);
  // La primera linea puede venir cortada a la mitad si empezamos en medio.
  if (start > 0) lines.shift();
  return lines.slice(-n);
}

/**
 * Sigue un archivo por sondeo de tamano. fs.watch en macOS no es fiable para
 * archivos que otro proceso escribe con append, y el sondeo es barato.
 */
export class FileFollower extends EventEmitter {
  #timer: NodeJS.Timeout | null = null;
  #offset = 0;
  #stopped = false;

  constructor(
    private readonly path: string,
    private readonly intervalMs = 1_000,
  ) {
    super();
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#offset = existsSync(this.path) ? statSync(this.path).size : 0;
    this.#timer = setInterval(() => void this.#poll(), this.intervalMs);
    this.#timer.unref?.();
  }

  async #poll(): Promise<void> {
    if (this.#stopped || !existsSync(this.path)) return;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    // Si encogio, el log rotó: volvemos a empezar desde cero.
    if (size < this.#offset) this.#offset = 0;
    if (size === this.#offset) return;

    const start = this.#offset;
    this.#offset = size;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      createReadStream(this.path, { start, end: size - 1 })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', () => resolve())
        .on('error', () => resolve());
    });
    const text = Buffer.concat(chunks).toString('utf8');
    for (const line of text.split('\n').filter(Boolean)) this.emit('line', line);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
