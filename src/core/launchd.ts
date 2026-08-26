import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

export const CLOUDFLARED_LABEL = 'com.cloudflare.cloudflared';
export const CLOUDFLARED_PLIST = `/Library/LaunchDaemons/${CLOUDFLARED_LABEL}.plist`;
export const SERVICE_TARGET = `system/${CLOUDFLARED_LABEL}`;

export interface LaunchdInfo {
  supported: boolean;
  label: string;
  /** El servicio esta registrado en launchd. */
  loaded: boolean;
  /** running | waiting | not running ... */
  state?: string;
  pid?: number;
  runs?: number;
  lastExitCode?: string;
  plistPath?: string;
  plistExists: boolean;
  program?: string;
  args?: string[];
  stdoutPath?: string;
  stderrPath?: string;
  raw?: string;
  error?: string;
}

/**
 * Parsea la salida de `launchctl print`, que es un formato anidado con llaves.
 * Solo tomamos las claves de profundidad 1: `state` aparece tambien dentro de
 * los bloques `type = resource` / `type = jetsam`, y confundirlos reportaria
 * "active" cuando el servicio real esta detenido.
 */
export function parseLaunchctlPrint(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const opens = (trimmed.match(/\{/g) ?? []).length;
    const closes = (trimmed.match(/\}/g) ?? []).length;

    // `key = {` abre un bloque: la clave no es un valor escalar.
    if (depth === 1 && !/\{|\}/.test(trimmed)) {
      const eq = trimmed.indexOf(' = ');
      if (eq !== -1) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 3).trim();
        if (!(key in out)) out[key] = value;
      }
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  return out;
}

/** Extrae el bloque `arguments = { ... }` como lista. */
export function parseArguments(text: string): string[] | undefined {
  const m = /\n\targuments = \{\n([\s\S]*?)\n\t\}/.exec(text);
  if (!m) return undefined;
  return m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Lee el estado del daemon SIN sudo. Nota: `launchctl list | grep cloudflared`
 * (el enfoque intuitivo) NO funciona aqui: cloudflared se instala como
 * LaunchDaemon de sistema y `launchctl list` sin privilegios solo muestra el
 * dominio del usuario, asi que devolveria vacio con el servicio corriendo.
 */
export async function readLaunchdInfo(): Promise<LaunchdInfo> {
  const base: LaunchdInfo = {
    supported: process.platform === 'darwin',
    label: CLOUDFLARED_LABEL,
    loaded: false,
    plistExists: existsSync(CLOUDFLARED_PLIST),
  };

  if (!base.supported) {
    return { ...base, error: `El modo service usa launchd; esta plataforma es ${process.platform}.` };
  }

  try {
    const { stdout } = await exec('launchctl', ['print', SERVICE_TARGET], { timeout: 5_000 });
    const fields = parseLaunchctlPrint(stdout);
    const pid = Number(fields.pid);
    const runs = Number(fields.runs);
    const info: LaunchdInfo = {
      ...base,
      loaded: true,
      raw: stdout,
      plistPath: fields.path ?? CLOUDFLARED_PLIST,
    };
    if (fields.state) info.state = fields.state;
    if (Number.isFinite(pid)) info.pid = pid;
    if (Number.isFinite(runs)) info.runs = runs;
    if (fields['last exit code']) info.lastExitCode = fields['last exit code'];
    if (fields.program) info.program = fields.program;
    if (fields['stdout path']) info.stdoutPath = fields['stdout path'];
    if (fields['stderr path']) info.stderrPath = fields['stderr path'];
    const args = parseArguments(stdout);
    if (args) info.args = args;
    return info;
  } catch (err) {
    // launchctl sale con codigo != 0 cuando el servicio no esta cargado.
    const msg = err instanceof Error ? err.message : String(err);
    if (/Could not find service|No such process/i.test(msg)) {
      return { ...base, loaded: false };
    }
    return { ...base, error: msg };
  }
}

export interface CloudflaredProcess {
  pid: number;
  command: string;
}

/** Procesos cloudflared vivos en este host, segun el SO (no segun Cloudflare). */
export async function findCloudflaredProcesses(): Promise<CloudflaredProcess[]> {
  try {
    const { stdout } = await exec('pgrep', ['-fl', 'cloudflared'], { timeout: 5_000 });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(' ');
        return { pid: Number(line.slice(0, sp)), command: line.slice(sp + 1) };
      })
      // pgrep -f tambien casa con procesos que solo MENCIONAN cloudflared
      // (un `grep cloudflared`, este mismo proceso). Exigimos que el binario lo sea.
      .filter((p) => Number.isFinite(p.pid) && /(^|\/)cloudflared(\s|$)/.test(p.command));
  } catch {
    // pgrep sale con 1 cuando no hay coincidencias: no es un error.
    return [];
  }
}

export type ServiceAction = 'start' | 'stop' | 'restart';

export function sudoCommandFor(action: ServiceAction): string[] {
  switch (action) {
    case 'stop':
      // bootout/bootstrap, no load/unload: estos ultimos estan deprecados
      // desde macOS 10.11 y emiten advertencias en Darwin moderno.
      return ['launchctl', 'bootout', SERVICE_TARGET];
    case 'start':
      return ['launchctl', 'bootstrap', 'system', CLOUDFLARED_PLIST];
    case 'restart':
      return ['launchctl', 'kickstart', '-k', SERVICE_TARGET];
  }
}

/** true si sudo no pediria contrasena ahora mismo (credencial en cache). */
export async function sudoIsCached(): Promise<boolean> {
  try {
    await exec('sudo', ['-n', 'true'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
