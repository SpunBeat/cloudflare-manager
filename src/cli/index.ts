#!/usr/bin/env node
import { createServices } from '../core/index.js';
import { CloudflareApiError, ConfigError, TunnelManagerError } from '../core/errors.js';
import { viteSnippet, VITE_WHY } from '../core/health.js';
import { validateProtocol } from '../core/tunnel-service.js';
import type { Mapping, Protocol, Snapshot } from '../core/types.js';
import { c, table } from './format.js';

const USAGE = `${c.bold('tunnel-manager')} - subdominios sobre un unico Cloudflare Tunnel

${c.bold('USO')}
  tunnel-manager <comando> [args]

${c.bold('COMANDOS')}
  list                              Tabla de mapeos (ingress + DNS + salud local)
  status                            Estado del tunel y sus conectores
  sync                              Reconcilia contra Cloudflare (alias de list)
  add <sub> <puerto> [--proto p]    Crea ingress + CNAME (atomico)
  update <sub> [puerto] [--proto p] Cambia puerto/protocolo (solo ingress)
  off <sub>                         Quita el ingress, conserva el CNAME
  on <sub> [puerto]                 Restaura el ingress con el puerto recordado
  rm <sub> [--keep-dns]             Borra ingress + CNAME (pide confirmacion)
  prefs                             Muestra las preferencias locales

${c.bold('OPCIONES')}
  --proto http|https|tcp   Protocolo hacia el origen local (default: http)
  --keep-dns               En rm, conserva el CNAME
  --yes, -y                No pedir confirmacion
  --no-health              Omite el health check local (mas rapido)
  --json                   Salida JSON cruda
`;

interface Flags {
  proto?: Protocol;
  keepDns: boolean;
  yes: boolean;
  health: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { keepDns: false, yes: false, health: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--proto') flags.proto = validateProtocol(argv[++i] ?? '');
    else if (a.startsWith('--proto=')) flags.proto = validateProtocol(a.slice(8));
    else if (a === '--keep-dns') flags.keepDns = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--no-health') flags.health = false;
    else if (a === '--json') flags.json = true;
    else if (a.startsWith('-')) throw new TunnelManagerError(`Opcion desconocida: ${a}`);
    else positional.push(a);
  }
  return { cmd: positional.shift() ?? 'list', positional, flags };
}

const STATUS_BADGE: Record<Mapping['status'], string> = {
  active: c.green('activo'),
  disabled: c.gray('apagado'),
  'orphan-dns': c.yellow('dns-huerfano'),
  'orphan-ingress': c.yellow('sin-dns'),
};

function healthCell(m: Mapping): string {
  if (m.port === null) return c.gray('-');
  const h = m.health;
  if (!h) return c.gray('?');
  if (!h.ok) return c.red('caido');
  const via = h.via === '[::1]' ? c.dim(' ipv6') : '';
  return `${c.green(String(h.statusCode))} ${c.dim(`${h.latencyMs}ms`)}${via}`;
}

function renderSnapshot(s: Snapshot): string {
  const t = s.tunnel;
  const statusColor = t.status === 'healthy' ? c.green : t.status === 'degraded' ? c.yellow : c.red;
  const colos = t.connectors.flatMap((x) => x.colos);
  const head =
    `${c.bold('Tunel')} ${t.name} ${c.gray(`(${t.id.slice(0, 8)})`)}  ` +
    `${statusColor(t.status.toUpperCase())}  ` +
    `${c.dim(`${t.connectors.length} conector(es)`)}` +
    (colos.length ? c.dim(` [${colos.join(' ')}]`) : '') +
    `  ${c.dim(`config v${t.configVersion} ${t.configSource}`)}`;

  const rows = s.mappings.map((m) => [
    c.cyan(m.hostname),
    m.service ?? c.gray('-'),
    STATUS_BADGE[m.status],
    healthCell(m),
  ]);

  const body = rows.length
    ? table(['HOSTNAME', 'SERVICIO LOCAL', 'ESTADO', 'SALUD'], rows)
    : c.gray('  (sin mapeos)');

  const warns = t.warnings.map((w) => `${c.yellow('!')} ${w}`).join('\n');
  return [head, '', body, warns ? `\n${warns}` : ''].join('\n');
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} [s/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(/^s(i)?$/i.test(String(d).trim()));
    });
    process.stdin.resume();
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(USAGE);
    return 0;
  }

  const { cmd, positional, flags } = parseArgs(argv);
  const { tunnel, config, state } = createServices();

  switch (cmd) {
    case 'list':
    case 'sync': {
      const snap = await tunnel.reconcile({ health: flags.health });
      console.log(flags.json ? JSON.stringify(snap, null, 2) : renderSnapshot(snap));
      return 0;
    }

    case 'status': {
      const [t, connectors] = await Promise.all([tunnel.getTunnel(), tunnel.getConnectors()]);
      if (flags.json) {
        console.log(JSON.stringify({ tunnel: t, connectors }, null, 2));
        return 0;
      }
      const color = t.status === 'healthy' ? c.green : t.status === 'degraded' ? c.yellow : c.red;
      console.log(`${c.bold(t.name)} ${c.gray(t.id)}`);
      console.log(`estado: ${color(t.status)}   activo desde: ${t.conns_active_at ?? c.gray('nunca')}`);
      console.log();
      console.log(
        table(
          ['CONECTOR', 'VERSION', 'ARCH', 'DESDE', 'IP ORIGEN', 'CONNS', 'COLOS'],
          connectors.map((x) => [
            x.id.slice(0, 8),
            x.version ?? '?',
            x.arch ?? '?',
            x.runAt ?? '?',
            x.originIp,
            String(x.connCount),
            x.colos.join(' '),
          ]),
        ),
      );
      if (connectors.length > 1) {
        console.log(`\n${c.yellow('!')} Mas de un conector: revisa si tienes cloudflared duplicado.`);
      }
      return 0;
    }

    case 'add': {
      const sub = positional[0];
      const portRaw = positional[1];
      if (!sub || !portRaw) {
        throw new TunnelManagerError('Uso: tunnel-manager add <sub> <puerto> [--proto http]');
      }
      const res = await tunnel.createMapping(sub, Number(portRaw), flags.proto ?? 'http');
      console.log(`${c.green('OK')} ${c.cyan(`https://${res.mapping.hostname}`)} -> ${res.mapping.service}`);
      console.log(`   ingress escrito, CNAME ${res.dnsCreated ? 'creado' : 'ya existia'}`);
      if (!res.health.ok) {
        console.log(
          `   ${c.yellow('aviso')} nada escuchando en el puerto ${res.mapping.port}. ` +
            'El mapeo ya existe; arranca tu dev server cuando quieras.',
        );
      }
      if (res.isVite) {
        console.log(`\n${c.magenta('Vite detectado')}. Agrega a tu vite.config:\n`);
        console.log(
          viteSnippet(config.baseDomain)
            .split('\n')
            .map((l) => `   ${c.dim(l)}`)
            .join('\n'),
        );
        console.log();
        for (const w of VITE_WHY) console.log(`   ${c.gray('-')} ${w}`);
      }
      return 0;
    }

    case 'update': {
      const sub = positional[0];
      const portRaw = positional[1];
      if (!sub) throw new TunnelManagerError('Uso: tunnel-manager update <sub> [puerto] [--proto http]');
      if (!portRaw && !flags.proto) throw new TunnelManagerError('Indica un puerto nuevo o --proto.');
      const m = await tunnel.updateMapping(sub, portRaw ? Number(portRaw) : undefined, flags.proto);
      console.log(`${c.green('OK')} ${c.cyan(m.hostname)} -> ${m.service}`);
      return 0;
    }

    case 'off': {
      const sub = positional[0];
      if (!sub) throw new TunnelManagerError('Uso: tunnel-manager off <sub>');
      const r = await tunnel.disableMapping(sub);
      console.log(
        `${c.green('OK')} ${c.cyan(tunnel.hostnameFor(r.subdomain))} apagado (404 en el edge). ` +
          `CNAME conservado, puerto ${r.port} recordado.`,
      );
      return 0;
    }

    case 'on': {
      const sub = positional[0];
      const portRaw = positional[1];
      if (!sub) throw new TunnelManagerError('Uso: tunnel-manager on <sub> [puerto]');
      const m = await tunnel.enableMapping(sub, portRaw ? Number(portRaw) : undefined);
      console.log(`${c.green('OK')} ${c.cyan(`https://${m.hostname}`)} -> ${m.service}`);
      if (m.health && !m.health.ok) {
        console.log(`   ${c.yellow('aviso')} nada escuchando en el puerto ${m.port}.`);
      }
      return 0;
    }

    case 'rm': {
      const sub = positional[0];
      if (!sub) throw new TunnelManagerError('Uso: tunnel-manager rm <sub> [--keep-dns]');
      const hostname = tunnel.hostnameFor(sub);
      if (!flags.yes) {
        const what = flags.keepDns ? 'la regla de ingress' : 'la regla de ingress Y el CNAME';
        const ok = await confirm(`Borrar ${what} de ${c.cyan(hostname)}?`);
        if (!ok) {
          console.log(c.gray('cancelado'));
          return 1;
        }
      }
      const r = await tunnel.removeMapping(sub, { keepDns: flags.keepDns });
      console.log(
        `${c.green('OK')} ${hostname}: ingress ${r.ingressRemoved ? 'borrado' : c.gray('no existia')}, ` +
          `CNAME ${flags.keepDns ? c.gray('conservado') : r.dnsRemoved ? 'borrado' : c.gray('no existia')}`,
      );
      return 0;
    }

    case 'prefs': {
      console.log(JSON.stringify(state.prefs, null, 2));
      console.log(c.gray(`\n${state.file}`));
      return 0;
    }

    default:
      console.error(`${c.red('Comando desconocido:')} ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof CloudflareApiError) {
      console.error(`${c.red('Error de la API de Cloudflare')}\n  ${err.message}`);
      for (const h of err.hints) console.error(`  ${c.yellow('->')} ${h}`);
    } else if (err instanceof ConfigError) {
      console.error(`${c.red('Error de configuracion')}\n  ${err.message}`);
    } else if (err instanceof TunnelManagerError) {
      console.error(`${c.red('Error')} ${err.message}`);
      if (err.hint) console.error(`  ${c.yellow('->')} ${err.hint}`);
    } else {
      console.error(`${c.red('Error inesperado')}\n`, err);
    }
    process.exit(1);
  });
