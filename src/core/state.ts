import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Protocol } from './types.js';

export type Mode = 'service' | 'spawn';

export interface Prefs {
  mode: Mode;
  healthIntervalMs: number;
  tunnelPollMs: number;
  serverPort: number;
}

export interface DisabledEntry {
  port: number;
  protocol: Protocol;
  disabledAt: string;
}

export interface NoteEntry {
  isVite?: boolean;
  label?: string;
}

export interface StateData {
  version: 1;
  prefs: Prefs;
  /** Mapeos apagados a proposito: conservamos el puerto para reactivar con un clic. */
  disabled: Record<string, DisabledEntry>;
  notes: Record<string, NoteEntry>;
}

export const DEFAULT_PREFS: Prefs = {
  mode: 'service',
  healthIntervalMs: 5_000,
  // La API de Cloudflare tiene rate limits; el estado del tunel cambia lento.
  tunnelPollMs: 15_000,
  serverPort: 4040,
};

function defaults(): StateData {
  return { version: 1, prefs: { ...DEFAULT_PREFS }, disabled: {}, notes: {} };
}

/**
 * Estado local en ~/.tunnel-manager/state.json. NUNCA guarda credenciales.
 * Cloudflare es la fuente de verdad; esto solo recuerda lo que Cloudflare no
 * puede saber: que un mapeo esta apagado a proposito y no es basura.
 */
export class StateStore {
  readonly dir: string;
  readonly file: string;
  #data: StateData;

  constructor(dir = join(homedir(), '.tunnel-manager')) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.#data = this.#load();
  }

  #load(): StateData {
    if (!existsSync(this.file)) return defaults();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateData>;
      return {
        version: 1,
        prefs: { ...DEFAULT_PREFS, ...(parsed.prefs ?? {}) },
        disabled: parsed.disabled ?? {},
        notes: parsed.notes ?? {},
      };
    } catch {
      // Estado corrupto: es reconstruible desde Cloudflare, asi que jamas
      // debe impedir el arranque. Lo apartamos y seguimos.
      try {
        renameSync(this.file, `${this.file}.bak`);
      } catch {
        /* si tampoco se puede renombrar, seguimos con defaults igual */
      }
      return defaults();
    }
  }

  get data(): StateData {
    return this.#data;
  }
  get prefs(): Prefs {
    return this.#data.prefs;
  }

  /** Escritura atomica: tmp + rename, para no dejar un JSON a medias. */
  save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    this.#data.prefs = { ...this.#data.prefs, ...patch };
    this.save();
    return this.#data.prefs;
  }

  getDisabled(sub: string): DisabledEntry | undefined {
    return this.#data.disabled[sub];
  }
  markDisabled(sub: string, port: number, protocol: Protocol): void {
    this.#data.disabled[sub] = { port, protocol, disabledAt: new Date().toISOString() };
    this.save();
  }
  clearDisabled(sub: string): void {
    delete this.#data.disabled[sub];
    this.save();
  }

  getNote(sub: string): NoteEntry | undefined {
    return this.#data.notes[sub];
  }
  setNote(sub: string, patch: NoteEntry): void {
    this.#data.notes[sub] = { ...this.#data.notes[sub], ...patch };
    this.save();
  }
  clearNote(sub: string): void {
    delete this.#data.notes[sub];
    this.save();
  }

  /** Olvida todo rastro de un subdominio (al eliminarlo de verdad). */
  forget(sub: string): void {
    delete this.#data.disabled[sub];
    delete this.#data.notes[sub];
    this.save();
  }
}
