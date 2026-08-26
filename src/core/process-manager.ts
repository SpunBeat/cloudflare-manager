import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TunnelManagerError } from './errors.js';
import { LogRing, FileFollower, readLastLines } from './logs.js';
import {
  CLOUDFLARED_LABEL,
  findCloudflaredProcesses,
  readLaunchdInfo,
  sudoCommandFor,
  sudoIsCached,
  type CloudflaredProcess,
  type LaunchdInfo,
  type ServiceAction,
} from './launchd.js';
import type { Mode } from './state.js';

export interface SpawnStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  lastError?: string;
}

export interface LocalStatus {
  mode: Mode;
  launchd: LaunchdInfo;
  processes: CloudflaredProcess[];
  spawn: SpawnStatus;
  /** Resumen legible: lo que se muestra arriba en la UI. */
  summary: string;
  warnings: string[];
}

export interface ProcessManagerOptions {
  mode?: Mode;
  tunnelToken?: string;
  cloudflaredPath?: string;
  /** Sondas del sistema, inyectables para testear sin depender del host real. */
  probes?: {
    readLaunchdInfo?: typeof readLaunchdInfo;
    findCloudflaredProcesses?: typeof findCloudflaredProcesses;
  };
}

/**
 * Dos modos:
 *  - `service` (default): NO lanza nada. Observa el daemon de launchd y ofrece
 *    control via sudo, siempre bajo confirmacion explicita del usuario.
 *  - `spawn`: lanza cloudflared como proceso hijo y es duena de su ciclo de vida.
 */
export class ProcessManager extends EventEmitter {
  #mode: Mode;
  #child: ChildProcess | null = null;
  #spawnStatus: SpawnStatus = { running: false };
  #follower: FileFollower | null = null;
  #cleanupBound = false;
  readonly logs = new LogRing(500);
  readonly #readLaunchd: typeof readLaunchdInfo;
  readonly #findProcesses: typeof findCloudflaredProcesses;

  constructor(private readonly opts: ProcessManagerOptions = {}) {
    super();
    this.#mode = opts.mode ?? 'service';
    this.#readLaunchd = opts.probes?.readLaunchdInfo ?? readLaunchdInfo;
    this.#findProcesses = opts.probes?.findCloudflaredProcesses ?? findCloudflaredProcesses;
  }

  get mode(): Mode {
    return this.#mode;
  }

  setMode(mode: Mode): void {
    if (mode === this.#mode) return;
    if (this.#mode === 'spawn' && this.#child) {
      throw new TunnelManagerError(
        'Hay un cloudflared lanzado por la herramienta. Detenlo antes de cambiar a modo service.',
      );
    }
    this.#mode = mode;
    this.stopFollowingLogs();
  }

  async status(): Promise<LocalStatus> {
    const [launchd, processes] = await Promise.all([this.#readLaunchd(), this.#findProcesses()]);
    const warnings: string[] = [];

    // Nuestro propio hijo aparece en pgrep; no cuenta como proceso ajeno.
    const ownPid = this.#child?.pid;
    const foreign = processes.filter((p) => p.pid !== ownPid);

    if (foreign.length > 1) {
      warnings.push(
        `Hay ${foreign.length} procesos cloudflared corriendo en este host: ` +
          `${foreign.map((p) => `pid ${p.pid}`).join(', ')}. ` +
          'Dos conectores del mismo tunel se reparten el trafico y hacen imposible razonar ' +
          'sobre que instancia sirve cada peticion.',
      );
    }
    if (this.#mode === 'spawn' && launchd.loaded && launchd.state === 'running') {
      warnings.push(
        `El modo es spawn pero el servicio de launchd (${CLOUDFLARED_LABEL}) tambien esta corriendo. ` +
          'Detenlo o cambia a modo service para no tener dos conectores.',
      );
    }
    if (this.#mode === 'service' && !launchd.plistExists) {
      warnings.push(
        `No existe ${launchd.plistPath ?? '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist'}: ` +
          'cloudflared no esta instalado como servicio. Usa modo spawn o instala el servicio.',
      );
    }
    if (launchd.error) warnings.push(`No pude leer launchd: ${launchd.error}`);

    return {
      mode: this.#mode,
      launchd,
      processes,
      spawn: { ...this.#spawnStatus },
      summary: this.#summarize(launchd, foreign),
      warnings,
    };
  }

  #summarize(launchd: LaunchdInfo, processes: CloudflaredProcess[]): string {
    if (this.#mode === 'spawn') {
      if (this.#spawnStatus.running) return `lanzado por la herramienta (pid ${this.#spawnStatus.pid})`;
      if (this.#spawnStatus.exitCode !== undefined) {
        return `detenido (codigo ${this.#spawnStatus.exitCode ?? this.#spawnStatus.exitSignal})`;
      }
      return 'no lanzado';
    }
    if (!launchd.supported) return 'launchd no disponible en esta plataforma';
    if (!launchd.loaded) {
      return launchd.plistExists
        ? 'servicio instalado pero NO cargado en launchd'
        : 'servicio no instalado';
    }
    const pid = launchd.pid ? ` (pid ${launchd.pid})` : '';
    if (launchd.state === 'running') return `servicio de launchd corriendo${pid}`;
    // Cargado pero sin proceso: launchd lo reintentara o murio.
    const extra = processes.length ? '' : ', sin proceso vivo';
    return `servicio cargado, estado "${launchd.state ?? '?'}"${extra}`;
  }

  // --- Modo service: control via sudo ---

  /**
   * Ejecuta `sudo launchctl ...` heredando stdio, de modo que la peticion de
   * contrasena aparece en la TERMINAL donde corre este proceso, no en el
   * navegador. Nunca se invoca sin confirmacion explicita de quien lo pide.
   */
  async controlService(action: ServiceAction): Promise<{ ok: boolean; command: string; code: number | null }> {
    if (this.#mode !== 'service') {
      throw new TunnelManagerError(`controlService solo aplica en modo service (modo actual: ${this.#mode}).`);
    }
    if (process.platform !== 'darwin') {
      throw new TunnelManagerError(`El control del servicio usa launchd; esta plataforma es ${process.platform}.`);
    }

    const args = sudoCommandFor(action);
    const command = `sudo ${args.join(' ')}`;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sudo', args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (c) => resolve(c));
    });
    return { ok: code === 0, command, code };
  }

  /** Para avisar en la UI si el boton va a pedir contrasena en la terminal. */
  sudoIsCached(): Promise<boolean> {
    return sudoIsCached();
  }

  // --- Modo spawn: ciclo de vida del hijo ---

  async startSpawn(): Promise<SpawnStatus> {
    if (this.#mode !== 'spawn') {
      throw new TunnelManagerError(`startSpawn solo aplica en modo spawn (modo actual: ${this.#mode}).`);
    }
    if (this.#child) throw new TunnelManagerError('Ya hay un cloudflared lanzado por la herramienta.');
    const token = this.opts.tunnelToken;
    if (!token) {
      throw new TunnelManagerError(
        'Falta CF_TUNNEL_TOKEN en .env, requerido por el modo spawn.',
        'Es el blob largo que usaste en `cloudflared service install <token>`.',
      );
    }

    const bin = this.opts.cloudflaredPath ?? 'cloudflared';
    const child = spawn(bin, ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached:false para que muera con nosotros si algo sale mal.
      detached: false,
    });
    this.#child = child;
    this.#spawnStatus = { running: true, pid: child.pid ?? 0, startedAt: new Date().toISOString() };

    const onData = (buf: Buffer) => {
      for (const line of this.logs.pushChunk(buf.toString('utf8'))) this.emit('log', line);
    };
    child.stdout?.on('data', onData);
    // cloudflared escribe TODO su log en stderr, incluido el informativo.
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      this.#spawnStatus = { running: false, lastError: err.message };
      this.#child = null;
      this.emit('exit', this.#spawnStatus);
    });
    child.on('close', (code, signal) => {
      this.#spawnStatus = {
        running: false,
        exitCode: code,
        exitSignal: signal,
        ...(this.#spawnStatus.startedAt ? { startedAt: this.#spawnStatus.startedAt } : {}),
      };
      this.#child = null;
      this.emit('exit', this.#spawnStatus);
      this.emit('log', `[tunnel-manager] cloudflared termino (codigo=${code} senal=${signal})`);
    });

    this.#bindCleanup();
    return { ...this.#spawnStatus };
  }

  /** SIGTERM y, si no obedece, SIGKILL. No dejamos huerfanos. */
  async stopSpawn(timeoutMs = 5_000): Promise<void> {
    const child = this.#child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, timeoutMs);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.#child = null;
  }

  #bindCleanup(): void {
    if (this.#cleanupBound) return;
    this.#cleanupBound = true;
    const bye = () => {
      this.#child?.kill('SIGTERM');
    };
    process.once('exit', bye);
    process.once('SIGINT', () => {
      bye();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      bye();
      process.exit(143);
    });
  }

  // --- Logs, unificados entre modos ---

  /**
   * En modo spawn los logs vienen del hijo. En modo service vienen del archivo
   * donde launchd redirige stderr: cloudflared loguea todo ahi, incluido el
   * informativo, asi que stdout suele estar vacio.
   */
  async recentLogs(n = 100): Promise<string[]> {
    if (this.#mode === 'spawn') return this.logs.tail(n);
    const info = await this.#readLaunchd();
    const path = info.stderrPath;
    if (!path) return [];
    return readLastLines(path, n);
  }

  async followLogs(): Promise<{ following: boolean; source: string }> {
    if (this.#mode === 'spawn') return { following: true, source: 'proceso hijo' };
    const info = await this.#readLaunchd();
    const path = info.stderrPath;
    if (!path) return { following: false, source: 'sin archivo de log' };
    this.stopFollowingLogs();
    const follower = new FileFollower(path);
    follower.on('line', (line: string) => {
      this.logs.push(line);
      this.emit('log', line);
    });
    follower.start();
    this.#follower = follower;
    return { following: true, source: path };
  }

  stopFollowingLogs(): void {
    this.#follower?.stop();
    this.#follower = null;
  }

  async dispose(): Promise<void> {
    this.stopFollowingLogs();
    await this.stopSpawn();
  }
}
