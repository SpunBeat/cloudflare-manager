import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArguments, parseLaunchctlPrint, sudoCommandFor } from '../src/core/launchd.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseLaunchctlPrint', () => {
  const running = fixture('launchctl-print-running.txt');

  it('lee los campos de nivel superior del daemon real', () => {
    const f = parseLaunchctlPrint(running);
    expect(f.state).toBe('running');
    expect(f.pid).toBe('1999');
    expect(f.type).toBe('LaunchDaemon');
    expect(f.path).toBe('/Library/LaunchDaemons/com.cloudflare.cloudflared.plist');
    expect(f.program).toBe('/opt/homebrew/bin/cloudflared');
    expect(f['stderr path']).toBe('/Library/Logs/com.cloudflare.cloudflared.err.log');
    expect(f['last exit code']).toBe('(never exited)');
  });

  it('NO confunde el "state = active" anidado con el estado del servicio', () => {
    // La salida real trae `state = active` dentro de los bloques
    // `type = resource` y `type = jetsam`. Un parser plano leeria "active"
    // y reportaria el servicio como vivo aunque estuviera detenido.
    expect(running).toMatch(/\n\t\tstate = active/);
    expect(parseLaunchctlPrint(running).state).toBe('running');
  });

  it('ignora las claves que abren un bloque', () => {
    const f = parseLaunchctlPrint(running);
    expect(f.arguments).toBeUndefined();
    expect(f.environment).toBeUndefined();
  });

  it('extrae los argumentos del proceso', () => {
    expect(parseArguments(running)).toEqual([
      '/opt/homebrew/bin/cloudflared',
      'tunnel',
      'run',
      '--token-file',
      '/Library/Application Support/com.cloudflare.cloudflared/token',
    ]);
  });

  it('devuelve vacio ante la salida de un servicio inexistente', () => {
    const f = parseLaunchctlPrint(fixture('launchctl-print-missing.txt'));
    expect(f.state).toBeUndefined();
    expect(f.pid).toBeUndefined();
  });

  it('detecta un servicio cargado pero detenido', () => {
    // launchd conserva el job registrado tras un fallo: `state = not running`
    // con un `last exit code` distinto de cero. Cargado != corriendo.
    const stopped = `system/com.cloudflare.cloudflared = {
\tactive count = 0
\tpath = /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
\tstate = not running
\truns = 3
\tlast exit code = 1
}`;
    const f = parseLaunchctlPrint(stopped);
    expect(f.state).toBe('not running');
    expect(f['last exit code']).toBe('1');
    expect(f.pid).toBeUndefined();
  });
});

describe('sudoCommandFor', () => {
  it('usa bootout/bootstrap, no load/unload', () => {
    // load/unload estan deprecados desde macOS 10.11 y emiten advertencias.
    expect(sudoCommandFor('stop')).toEqual(['launchctl', 'bootout', 'system/com.cloudflare.cloudflared']);
    expect(sudoCommandFor('start')).toEqual([
      'launchctl',
      'bootstrap',
      'system',
      '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist',
    ]);
  });

  it('reinicia con kickstart -k', () => {
    expect(sudoCommandFor('restart')).toEqual([
      'launchctl',
      'kickstart',
      '-k',
      'system/com.cloudflare.cloudflared',
    ]);
  });

  it('ningun comando incluye sudo: lo agrega quien ejecuta, tras confirmar', () => {
    for (const a of ['start', 'stop', 'restart'] as const) {
      expect(sudoCommandFor(a)).not.toContain('sudo');
    }
  });
});
