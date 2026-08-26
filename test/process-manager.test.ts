import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/core/process-manager.js';
import { CLOUDFLARED_PLIST, type CloudflaredProcess, type LaunchdInfo } from '../src/core/launchd.js';
import type { Mode } from '../src/core/state.js';

function launchd(patch: Partial<LaunchdInfo> = {}): LaunchdInfo {
  return {
    supported: true,
    label: 'com.cloudflare.cloudflared',
    loaded: true,
    plistExists: true,
    plistPath: CLOUDFLARED_PLIST,
    state: 'running',
    pid: 1999,
    runs: 1,
    stderrPath: '/Library/Logs/com.cloudflare.cloudflared.err.log',
    ...patch,
  };
}

function procs(...pids: number[]): CloudflaredProcess[] {
  return pids.map((pid) => ({ pid, command: '/opt/homebrew/bin/cloudflared tunnel run --token-file /x' }));
}

function manager(mode: Mode, info: LaunchdInfo, list: CloudflaredProcess[]) {
  return new ProcessManager({
    mode,
    probes: { readLaunchdInfo: async () => info, findCloudflaredProcesses: async () => list },
  });
}

describe('estado en modo service', () => {
  it('refleja el servicio corriendo', async () => {
    const st = await manager('service', launchd(), procs(1999)).status();
    expect(st.summary).toBe('servicio de launchd corriendo (pid 1999)');
    expect(st.warnings).toHaveLength(0);
  });

  it('detecta el servicio descargado (bootout) sin confundirlo con desinstalado', async () => {
    // Esta es la prueba de aceptacion de la fase 2: tras `launchctl bootout`
    // el plist sigue en disco pero el job ya no esta registrado.
    const st = await manager('service', launchd({ loaded: false, plistExists: true }), []).status();
    expect(st.summary).toBe('servicio instalado pero NO cargado en launchd');
    expect(st.warnings).toHaveLength(0);
  });

  it('distingue "no instalado" de "no cargado"', async () => {
    const st = await manager('service', launchd({ loaded: false, plistExists: false }), []).status();
    expect(st.summary).toBe('servicio no instalado');
    expect(st.warnings.join(' ')).toMatch(/no esta instalado como servicio/);
  });

  it('reporta cargado pero muerto', async () => {
    const info = launchd({ state: 'not running', lastExitCode: '1' });
    delete (info as { pid?: number }).pid;
    const st = await manager('service', info, []).status();
    expect(st.summary).toMatch(/cargado, estado "not running", sin proceso vivo/);
  });

  it('avisa si hay dos procesos cloudflared en el host', async () => {
    const st = await manager('service', launchd(), procs(1999, 4242)).status();
    expect(st.warnings.join(' ')).toMatch(/2 procesos cloudflared/);
    expect(st.warnings.join(' ')).toMatch(/pid 1999, pid 4242/);
  });

  it('no avisa con un solo proceso', async () => {
    const st = await manager('service', launchd(), procs(1999)).status();
    expect(st.warnings).toHaveLength(0);
  });

  it('reporta el error si launchctl falla', async () => {
    const st = await manager('service', launchd({ error: 'permiso denegado' }), []).status();
    expect(st.warnings.join(' ')).toMatch(/No pude leer launchd: permiso denegado/);
  });
});

describe('estado en modo spawn', () => {
  it('avisa si el servicio de launchd tambien corre', async () => {
    // El caso que produce dos conectores: servicio + proceso manual.
    const st = await manager('spawn', launchd({ state: 'running' }), procs(1999)).status();
    expect(st.warnings.join(' ')).toMatch(/modo es spawn pero el servicio de launchd/);
  });

  it('no avisa si el servicio esta detenido', async () => {
    const st = await manager('spawn', launchd({ loaded: false }), []).status();
    expect(st.warnings.join(' ')).toHaveLength(0);
  });

  it('reporta "no lanzado" antes de arrancar', async () => {
    const st = await manager('spawn', launchd({ loaded: false }), []).status();
    expect(st.summary).toBe('no lanzado');
    expect(st.spawn.running).toBe(false);
  });
});

describe('guardas de modo', () => {
  it('startSpawn falla en modo service', async () => {
    const pm = manager('service', launchd(), []);
    await expect(pm.startSpawn()).rejects.toThrow(/solo aplica en modo spawn/);
  });

  it('controlService falla en modo spawn', async () => {
    const pm = manager('spawn', launchd(), []);
    await expect(pm.controlService('stop')).rejects.toThrow(/solo aplica en modo service/);
  });

  it('startSpawn exige CF_TUNNEL_TOKEN', async () => {
    const pm = new ProcessManager({
      mode: 'spawn',
      probes: { readLaunchdInfo: async () => launchd(), findCloudflaredProcesses: async () => [] },
    });
    await expect(pm.startSpawn()).rejects.toThrow(/Falta CF_TUNNEL_TOKEN/);
  });
});
