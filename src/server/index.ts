import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServices } from '../core/index.js';
import { ConfigError } from '../core/errors.js';
import { DashboardStateService } from './dashboard-state.js';
import { createApiRoutes } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(here, '../web');

export interface StartOptions {
  port?: number;
  open?: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<{ port: number; close: () => void }> {
  const services = createServices();
  const dash = new DashboardStateService(services);
  const port = opts.port ?? services.state.prefs.serverPort;

  const app = new Hono();
  app.route('/api', createApiRoutes(services, dash));

  if (existsSync(WEB_DIST)) {
    // El bundle vive junto al server en dist/. En dev sirve Vite y esto no existe.
    app.use('/*', serveStatic({ root: resolve(WEB_DIST, '..'), rewriteRequestPath: (p) => `/web${p}` }));
    app.get('*', serveStatic({ path: './dist/web/index.html' }));
  } else {
    app.get('/', (c) =>
      c.text(
        'El bundle del dashboard no esta construido.\n' +
          'Usa `pnpm dev` (Vite en 5173) o `pnpm build && pnpm start`.\n',
        200,
      ),
    );
  }

  dash.start();
  void services.process.followLogs();

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  // Sin esto, un puerto ocupado sale como un volcado crudo de Node y no queda
  // claro que lo mas probable es tener otra instancia ya corriendo.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `El puerto ${port} ya esta en uso.\n` +
          '  Probablemente tienes otro tunnel-manager corriendo. Para verlo:\n' +
          `    lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          `  O arranca en otro puerto:  pnpm start --port=4041`,
      );
    } else {
      console.error('Error del servidor:', err);
    }
    process.exit(1);
  });

  const url = `http://localhost:${port}`;
  // Anunciar solo cuando el socket esta realmente escuchando: si el puerto esta
  // ocupado, decir "escuchando" y luego fallar es peor que no decir nada.
  server.on('listening', () => {
    console.log(`tunnel-manager escuchando en ${url}`);
    console.log(`  modo: ${services.state.prefs.mode}   dominio: ${services.config.baseDomain}`);
    console.log('  ligado a 127.0.0.1: el dashboard NO es accesible desde la red local.');
    if (opts.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  });

  const close = () => {
    dash.stop();
    void services.process.dispose();
    server.close();
  };
  process.once('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(0);
  });

  return { port, close };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const options: StartOptions = { open: process.argv.includes('--open') };
  if (portArg) options.port = Number(portArg.slice(7));
  startServer(options).catch((err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`Error de configuracion:\n  ${err.message}`);
    } else {
      console.error('No pude arrancar el servidor:', err);
    }
    process.exit(1);
  });
}
