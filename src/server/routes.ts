import { Hono } from 'hono';
import QRCode from 'qrcode';
import type { Services } from '../core/index.js';
import type { DashboardStateService } from './dashboard-state.js';
import { CloudflareApiError, ConfigError, TunnelManagerError } from '../core/errors.js';
import { viteSnippet, VITE_WHY } from '../core/health.js';
import { validateProtocol } from '../core/tunnel-service.js';
import { sudoCommandFor, type ServiceAction } from '../core/launchd.js';

interface ApiError {
  error: string;
  hints: string[];
  kind: 'cloudflare' | 'config' | 'validation' | 'unknown';
}

function toApiError(err: unknown): { body: ApiError; status: 400 | 403 | 500 } {
  if (err instanceof CloudflareApiError) {
    return {
      body: { error: err.message, hints: err.hints, kind: 'cloudflare' },
      status: err.status === 403 || err.status === 401 ? 403 : 400,
    };
  }
  if (err instanceof TunnelManagerError) {
    return { body: { error: err.message, hints: err.hint ? [err.hint] : [], kind: 'validation' }, status: 400 };
  }
  if (err instanceof ConfigError) {
    return { body: { error: err.message, hints: [], kind: 'config' }, status: 500 };
  }
  return { body: { error: err instanceof Error ? err.message : String(err), hints: [], kind: 'unknown' }, status: 500 };
}

export function createApiRoutes(services: Services, dash: DashboardStateService): Hono {
  const api = new Hono();

  // Un unico manejador de errores: ninguna ruta repite try/catch.
  api.onError((err, c) => {
    const { body, status } = toApiError(err);
    return c.json(body, status);
  });

  api.get('/state', (c) => c.json(dash.state));

  api.post('/sync', async (c) => c.json(await dash.refresh()));

  /**
   * SSE. Cada cliente recibe el estado actual al conectarse y luego cada
   * cambio, de modo que no hay que sincronizar parcialmente en el navegador.
   */
  api.get('/events', (c) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              /* cliente desconectado */
            }
          };
          send('state', dash.state);
          const onState = (s: unknown) => send('state', s);
          const onLog = (line: string) => send('log', line);
          dash.on('state', onState);
          services.process.on('log', onLog);
          // Comentario SSE periodico: mantiene viva la conexion tras proxies.
          const ping = setInterval(() => {
            try {
              controller.enqueue(enc.encode(': ping\n\n'));
            } catch {
              /* ignorado */
            }
          }, 25_000);
          ping.unref?.();

          c.req.raw.signal.addEventListener('abort', () => {
            clearInterval(ping);
            dash.off('state', onState);
            services.process.off('log', onLog);
            try {
              controller.close();
            } catch {
              /* ya cerrado */
            }
          });
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      },
    );
  });

  // --- Mapeos ---

  api.post('/mappings', async (c) => {
    const body = await c.req.json<{ subdomain?: string; port?: number; protocol?: string }>();
    const res = await services.tunnel.createMapping(
      String(body.subdomain ?? ''),
      Number(body.port),
      body.protocol ? validateProtocol(body.protocol) : 'http',
    );
    await dash.refresh();
    return c.json(
      {
        ...res,
        viteHelp: res.isVite
          ? { snippet: viteSnippet(services.config.baseDomain), why: VITE_WHY }
          : null,
      },
      201,
    );
  });

  api.patch('/mappings/:sub', async (c) => {
    const body = await c.req.json<{ port?: number; protocol?: string }>();
    const mapping = await services.tunnel.updateMapping(
      c.req.param('sub'),
      body.port === undefined ? undefined : Number(body.port),
      body.protocol ? validateProtocol(body.protocol) : undefined,
    );
    await dash.refresh();
    return c.json(mapping);
  });

  api.post('/mappings/:sub/disable', async (c) => {
    const res = await services.tunnel.disableMapping(c.req.param('sub'));
    await dash.refresh();
    return c.json(res);
  });

  api.post('/mappings/:sub/enable', async (c) => {
    const body = await c.req.json<{ port?: number }>().catch(() => ({}) as { port?: number });
    const res = await services.tunnel.enableMapping(
      c.req.param('sub'),
      body.port === undefined ? undefined : Number(body.port),
    );
    await dash.refresh();
    return c.json(res);
  });

  api.delete('/mappings/:sub', async (c) => {
    const keepDns = c.req.query('keepDns') === 'true';
    const res = await services.tunnel.removeMapping(c.req.param('sub'), { keepDns });
    await dash.refresh();
    return c.json(res);
  });

  // --- cloudflared ---

  api.get('/logs', async (c) => {
    const n = Number(c.req.query('n') ?? 100);
    return c.json({ lines: await services.process.recentLogs(n), mode: services.process.mode });
  });

  api.get('/service', async (c) => c.json(await services.process.status()));

  /**
   * Ejecuta sudo. La peticion de contrasena aparece en la TERMINAL donde corre
   * este servidor, nunca en el navegador: por eso la UI avisa antes y esta
   * ruta puede tardar lo que tarde el usuario en teclearla.
   */
  api.post('/service/:action', async (c) => {
    const action = c.req.param('action') as ServiceAction;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return c.json({ error: `Accion invalida: ${action}`, hints: [], kind: 'validation' }, 400);
    }
    const res = await services.process.controlService(action);
    await new Promise((r) => setTimeout(r, 1200)); // launchd tarda en reflejarlo
    await dash.refresh();
    return c.json(res);
  });

  api.get('/service/sudo-cached', async (c) => c.json({ cached: await services.process.sudoIsCached() }));

  // --- Preferencias ---

  api.get('/prefs', (c) => c.json(services.state.prefs));

  api.put('/prefs', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const patch: Record<string, unknown> = {};
    if (typeof body.mode === 'string') {
      if (body.mode !== 'service' && body.mode !== 'spawn') {
        throw new TunnelManagerError(`Modo invalido: ${body.mode}`);
      }
      services.process.setMode(body.mode);
      patch.mode = body.mode;
    }
    // Un intervalo demasiado corto martillea la API o el dev server local.
    if (typeof body.healthIntervalMs === 'number') {
      patch.healthIntervalMs = Math.max(1_000, body.healthIntervalMs);
    }
    if (typeof body.tunnelPollMs === 'number') {
      patch.tunnelPollMs = Math.max(5_000, body.tunnelPollMs);
    }
    const prefs = services.state.setPrefs(patch);
    dash.restartTimers();
    return c.json(prefs);
  });

  // --- Utilidades ---

  api.get('/qr', async (c) => {
    const text = c.req.query('text');
    if (!text) throw new TunnelManagerError('Falta el parametro "text".');
    // SVG en vez de PNG: escala sin pixelarse y pesa menos.
    //
    // Polaridad estandar (modulos oscuros sobre claro) aunque el tema sea
    // oscuro: la camara de iOS y varios escaneres de Android asumen esa
    // polaridad y fallan con un QR invertido, que es justo lo que este QR
    // existe para evitar. El margen de 2 modulos es la "quiet zone" que pide
    // la especificacion; con menos, algunos escaneres no lo detectan.
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 2,
      color: { dark: '#0d1117', light: '#ffffff' },
    });
    // Sin cache: generar el SVG cuesta microsegundos, y un QR cacheado por
    // horas significa que cualquier cambio de render deja imagenes viejas
    // pegadas en el <img> ya decodificado del navegador.
    return new Response(svg, {
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
    });
  });

  api.get('/vite-snippet', (c) =>
    c.json({ snippet: viteSnippet(services.config.baseDomain), why: VITE_WHY }),
  );

  api.get('/sudo-command/:action', (c) => {
    const action = c.req.param('action') as ServiceAction;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return c.json({ error: 'accion invalida' }, 400);
    }
    return c.json({ command: `sudo ${sudoCommandFor(action).join(' ')}` });
  });

  return api;
}
