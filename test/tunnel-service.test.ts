import { afterEach, describe, expect, it } from 'vitest';
import { CATCH_ALL_SERVICE, normalizeIngress, parseService } from '../src/core/tunnel-service.js';
import { TunnelManagerError } from '../src/core/errors.js';
import { CloudflareApiError } from '../src/core/errors.js';
import { TARGET, cname } from './fake-cloudflare.js';
import { makeHarness } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function harness(...args: Parameters<typeof makeHarness>) {
  const h = makeHarness(...args);
  cleanups.push(h.cleanup);
  return h;
}

const PARASITOS = { hostname: 'parasitos.nurbs.dev', service: 'http://localhost:5176' };
const CATCH_ALL = { service: CATCH_ALL_SERVICE };

describe('normalizeIngress: la invariante del catch-all', () => {
  it('agrega el catch-all cuando falta', () => {
    expect(normalizeIngress([PARASITOS])).toEqual([PARASITOS, CATCH_ALL]);
  });

  it('nunca deja mas de un catch-all', () => {
    const out = normalizeIngress([CATCH_ALL, PARASITOS, CATCH_ALL]);
    expect(out.filter((r) => !r.hostname)).toHaveLength(1);
    expect(out.at(-1)).toEqual(CATCH_ALL);
  });

  it('mueve al final un catch-all que quedo en medio', () => {
    // Un catch-all en medio haria inalcanzables las reglas siguientes.
    const out = normalizeIngress([CATCH_ALL, PARASITOS]);
    expect(out).toEqual([PARASITOS, CATCH_ALL]);
  });

  it('respeta un catch-all personalizado en vez de imponer 404', () => {
    const custom = { service: 'http://localhost:9999' };
    expect(normalizeIngress([PARASITOS, custom]).at(-1)).toEqual(custom);
  });

  it('preserva el orden de las reglas con hostname', () => {
    const a = { hostname: 'a.nurbs.dev', service: 'http://localhost:1' };
    const b = { hostname: 'b.nurbs.dev', service: 'http://localhost:2' };
    expect(normalizeIngress([a, b, CATCH_ALL])).toEqual([a, b, CATCH_ALL]);
  });

  it('es idempotente', () => {
    const once = normalizeIngress([PARASITOS]);
    expect(normalizeIngress(once)).toEqual(once);
  });
});

describe('parseService', () => {
  it.each([
    ['http://localhost:5176', 'http', 5176],
    ['https://localhost:8443', 'https', 8443],
    ['tcp://localhost:22', 'tcp', 22],
  ])('%s', (svc, proto, port) => {
    expect(parseService(svc)).toEqual({ protocol: proto, port });
  });

  it('devuelve port null para servicios sin puerto', () => {
    expect(parseService('http_status:404').port).toBeNull();
  });
});

describe('reconciliacion', () => {
  it('descubre un mapeo preexistente que la herramienta nunca creo', async () => {
    // Esta es la prueba de aceptacion de la fase 1: parasitos ya existia.
    const h = harness({
      ingress: [PARASITOS, CATCH_ALL],
      dns: [cname('parasitos.nurbs.dev')],
    });
    const snap = await h.tunnel.reconcile({ health: false });
    expect(snap.mappings).toHaveLength(1);
    expect(snap.mappings[0]).toMatchObject({
      subdomain: 'parasitos',
      hostname: 'parasitos.nurbs.dev',
      port: 5176,
      protocol: 'http',
      status: 'active',
    });
  });

  it('clasifica los cuatro estados posibles', async () => {
    const h = harness({
      ingress: [
        PARASITOS,
        { hostname: 'sindns.nurbs.dev', service: 'http://localhost:3000' },
        CATCH_ALL,
      ],
      dns: [
        cname('parasitos.nurbs.dev'),
        cname('apagado.nurbs.dev'),
        cname('huerfano.nurbs.dev'),
      ],
    });
    h.state.markDisabled('apagado', 4000, 'http');

    const snap = await h.tunnel.reconcile({ health: false });
    const byName = Object.fromEntries(snap.mappings.map((m) => [m.subdomain, m]));

    expect(byName.parasitos!.status).toBe('active');
    expect(byName.sindns!.status).toBe('orphan-ingress');
    expect(byName.apagado!.status).toBe('disabled');
    expect(byName.apagado!.port).toBe(4000); // el puerto se recuerda localmente
    expect(byName.huerfano!.status).toBe('orphan-dns');
  });

  it('ignora hostnames de otras zonas', async () => {
    const h = harness({
      ingress: [{ hostname: 'algo.otrodominio.com', service: 'http://localhost:1' }, CATCH_ALL],
    });
    const snap = await h.tunnel.reconcile({ health: false });
    expect(snap.mappings).toHaveLength(0);
  });

  it('avisa cuando hay dos conectores desde la misma IP', async () => {
    const conn = (clientId: string, colo: string) => ({
      id: `c-${colo}`,
      client_id: clientId,
      client_version: '2026.8.2',
      colo_name: colo,
      origin_ip: '189.1.2.3',
      opened_at: '2026-08-25T18:00:00Z',
    });
    const h = harness({
      clients: [
        { id: 'client-uno', version: '2026.8.2', run_at: 'ayer', conns: [conn('client-uno', 'DFW'), conn('client-uno', 'QRO')] },
        { id: 'client-dos', version: '2026.8.2', run_at: 'hoy', conns: [conn('client-dos', 'LAX')] },
      ],
    });
    const snap = await h.tunnel.reconcile({ health: false });
    expect(snap.tunnel.connectors).toHaveLength(2);
    expect(snap.tunnel.warnings.join(' ')).toMatch(/2 conectores desde 189\.1\.2\.3/);
  });

  it('NO avisa por las multiples conexiones de un solo conector', async () => {
    // El error clasico: contar conns (4 colos) en vez de Clients (1 proceso).
    const conn = (colo: string) => ({
      id: `c-${colo}`,
      client_id: 'client-uno',
      client_version: '2026.8.2',
      colo_name: colo,
      origin_ip: '189.1.2.3',
      opened_at: '2026-08-25T18:00:00Z',
    });
    const h = harness({
      clients: [{ id: 'client-uno', conns: [conn('DFW'), conn('DFW'), conn('QRO'), conn('QRO')] }],
    });
    const snap = await h.tunnel.reconcile({ health: false });
    expect(snap.tunnel.connectors).toHaveLength(1);
    expect(snap.tunnel.connectors[0]!.colos).toEqual(['DFW', 'QRO']);
    expect(snap.tunnel.warnings).toHaveLength(0);
  });

  it('avisa si la config del tunel es local', async () => {
    const h = harness({ source: 'local' });
    const snap = await h.tunnel.reconcile({ health: false });
    expect(snap.tunnel.warnings.join(' ')).toMatch(/config del tunel es local/);
  });
});

describe('createMapping', () => {
  it('escribe ingress y CNAME, y deja el catch-all al final', async () => {
    const h = harness();
    const res = await h.tunnel.createMapping('prueba', 5177);

    expect(res.mapping.service).toBe('http://localhost:5177');
    expect(res.dnsCreated).toBe(true);
    expect(h.ingress().at(-1)).toEqual(CATCH_ALL);
    expect(h.hostnames()).toEqual(['prueba.nurbs.dev']);

    const rec = h.fake.state.dns.find((r) => r.name === 'prueba.nurbs.dev');
    expect(rec).toMatchObject({ type: 'CNAME', content: TARGET, proxied: true });
  });

  it('rechaza un subdominio que ya existe', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL] });
    await expect(h.tunnel.createMapping('parasitos', 9999)).rejects.toThrow(/Ya existe una regla de ingress/);
  });

  it.each([
    ['sub.anidado', /solo se admite un nivel/],
    ['-malo', /no es un subdominio valido/],
    ['con espacio', /no es un subdominio valido/],
    ['', /no puede estar vacio/],
  ])('rechaza el subdominio %s', async (sub, re) => {
    const h = harness();
    await expect(h.tunnel.createMapping(sub, 3000)).rejects.toThrow(re);
  });

  it.each([0, 65536, 1.5, NaN])('rechaza el puerto %s', async (port) => {
    const h = harness();
    await expect(h.tunnel.createMapping('x', port)).rejects.toThrow(TunnelManagerError);
  });

  it('no bloquea si el servicio local no responde', async () => {
    const h = makeHarness();
    cleanups.push(h.cleanup);
    const tunnel = new (await import('../src/core/tunnel-service.js')).TunnelService(
      h.cf,
      (await import('./helpers.js')).CONFIG,
      h.dns,
      h.state,
      { checkHealth: async () => ({ ok: false, error: 'ECONNREFUSED', checkedAt: 'now' }), detectVite: async () => false },
    );
    const res = await tunnel.createMapping('nadie', 9999);
    expect(res.health.ok).toBe(false);
    expect(res.mapping.status).toBe('active'); // el mapeo se crea igual
  });

  it('revierte el ingress si falla la creacion del CNAME', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL] });
    h.fake.state.opts.failDnsPost = true;

    await expect(h.tunnel.createMapping('prueba', 5177)).rejects.toThrow(CloudflareApiError);

    // El ingress volvio exactamente a como estaba: sin rastro de prueba.
    expect(h.hostnames()).toEqual(['parasitos.nurbs.dev']);
    expect(h.ingress().at(-1)).toEqual(CATCH_ALL);
    expect(h.fake.state.dns.find((r) => r.name === 'prueba.nurbs.dev')).toBeUndefined();
  });

  it('reusa un CNAME preexistente que ya apunta al tunel (idempotencia)', async () => {
    const h = harness({ dns: [cname('revivido.nurbs.dev')] });
    const res = await h.tunnel.createMapping('revivido', 3000);
    expect(res.dnsCreated).toBe(false);
    expect(h.fake.state.dns.filter((r) => r.name === 'revivido.nurbs.dev')).toHaveLength(1);
  });

  it('se niega a secuestrar un CNAME que apunta a otro lado', async () => {
    const h = harness({ dns: [cname('ajeno.nurbs.dev', 'otra-cosa.example.com')] });
    await expect(h.tunnel.createMapping('ajeno', 3000)).rejects.toThrow(/apunta a "otra-cosa/);
    // Y el ingress quedo revertido.
    expect(h.hostnames()).toEqual([]);
  });

  it('corrige un CNAME correcto pero sin proxy', async () => {
    // Un CNAME a cfargotunnel.com sin proxy simplemente no resuelve.
    const h = harness({ dns: [cname('sinproxy.nurbs.dev', TARGET, false)] });
    await h.tunnel.createMapping('sinproxy', 3000);
    expect(h.fake.state.dns.find((r) => r.name === 'sinproxy.nurbs.dev')!.proxied).toBe(true);
  });
});

describe('apagar y encender', () => {
  it('apagar quita el ingress, conserva el CNAME y recuerda el puerto', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });

    const r = await h.tunnel.disableMapping('parasitos');
    expect(r.port).toBe(5176);
    expect(h.hostnames()).toEqual([]);
    expect(h.ingress().at(-1)).toEqual(CATCH_ALL);
    expect(h.fake.state.dns.find((x) => x.name === 'parasitos.nurbs.dev')).toBeDefined();
    expect(h.state.getDisabled('parasitos')).toMatchObject({ port: 5176, protocol: 'http' });
  });

  it('encender restaura el ingress con el puerto recordado', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    await h.tunnel.disableMapping('parasitos');
    const m = await h.tunnel.enableMapping('parasitos');

    expect(m.service).toBe('http://localhost:5176');
    expect(h.hostnames()).toEqual(['parasitos.nurbs.dev']);
    expect(h.state.getDisabled('parasitos')).toBeUndefined();
  });

  it('el ciclo apagar/encender deja el ingress identico', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    const before = structuredClone(h.ingress());
    await h.tunnel.disableMapping('parasitos');
    await h.tunnel.enableMapping('parasitos');
    expect(h.ingress()).toEqual(before);
  });

  it('encender sin puerto recordado pide uno explicito', async () => {
    const h = harness({ dns: [cname('misterio.nurbs.dev')] });
    await expect(h.tunnel.enableMapping('misterio')).rejects.toThrow(/No recuerdo el puerto/);
    const m = await h.tunnel.enableMapping('misterio', 7777);
    expect(m.port).toBe(7777);
  });

  it('apagar algo que no esta activo falla con mensaje claro', async () => {
    const h = harness();
    await expect(h.tunnel.disableMapping('fantasma')).rejects.toThrow(/No existe un mapeo activo/);
  });
});

describe('updateMapping', () => {
  it('cambia el puerto sin tocar el CNAME', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    const dnsBefore = structuredClone(h.fake.state.dns);

    const m = await h.tunnel.updateMapping('parasitos', 5180);
    expect(m.service).toBe('http://localhost:5180');
    expect(h.ingress()[0]!.service).toBe('http://localhost:5180');
    expect(h.fake.state.dns).toEqual(dnsBefore);
  });

  it('cambia solo el protocolo conservando el puerto', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL] });
    const m = await h.tunnel.updateMapping('parasitos', undefined, 'https');
    expect(m.service).toBe('https://localhost:5176');
  });

  it('actualiza el puerto recordado de un mapeo apagado', async () => {
    const h = harness({ dns: [cname('off.nurbs.dev')] });
    h.state.markDisabled('off', 3000, 'http');
    const m = await h.tunnel.updateMapping('off', 3001);
    expect(m.status).toBe('disabled');
    expect(h.state.getDisabled('off')!.port).toBe(3001);
    expect(h.hostnames()).toEqual([]); // sigue apagado
  });
});

describe('removeMapping', () => {
  it('borra ingress y CNAME sin dejar rastro', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    const r = await h.tunnel.removeMapping('parasitos');

    expect(r).toEqual({ ingressRemoved: true, dnsRemoved: true });
    expect(h.hostnames()).toEqual([]);
    expect(h.fake.state.dns).toHaveLength(0);
    expect(h.ingress()).toEqual([CATCH_ALL]);
    expect(h.state.getDisabled('parasitos')).toBeUndefined();
  });

  it('con --keep-dns conserva el CNAME', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    const r = await h.tunnel.removeMapping('parasitos', { keepDns: true });
    expect(r.dnsRemoved).toBe(false);
    expect(h.fake.state.dns).toHaveLength(1);
  });

  it('es idempotente: borrar dos veces no falla', async () => {
    const h = harness({ ingress: [PARASITOS, CATCH_ALL], dns: [cname('parasitos.nurbs.dev')] });
    await h.tunnel.removeMapping('parasitos');
    const second = await h.tunnel.removeMapping('parasitos');
    expect(second).toEqual({ ingressRemoved: false, dnsRemoved: false });
  });

  it('se niega a borrar un CNAME que apunta a otro lado', async () => {
    const h = harness({ dns: [cname('ajeno.nurbs.dev', 'otra-cosa.example.com')] });
    await expect(h.tunnel.removeMapping('ajeno')).rejects.toThrow(/Me niego a borrar/);
  });
});

describe('seguridad de la config', () => {
  it('toda escritura de config incluye el catch-all al final', async () => {
    const h = harness();
    await h.tunnel.createMapping('a', 3001);
    await h.tunnel.createMapping('b', 3002);
    await h.tunnel.updateMapping('a', 3003);
    await h.tunnel.disableMapping('b');
    await h.tunnel.removeMapping('a');

    expect(h.fake.state.configWrites.length).toBeGreaterThan(0);
    for (const written of h.fake.state.configWrites) {
      const rules = written.ingress ?? [];
      expect(rules.at(-1)).toEqual(CATCH_ALL);
      expect(rules.filter((r) => !r.hostname)).toHaveLength(1);
    }
  });

  it('preserva warp-routing al escribir ingress', async () => {
    const h = harness();
    h.fake.state.config['warp-routing'] = { enabled: true };
    await h.tunnel.createMapping('x', 3000);
    expect(h.fake.state.config['warp-routing']).toEqual({ enabled: true });
  });

  it('se niega a escribir si el tunel tiene config local', async () => {
    const h = harness({ source: 'local' });
    await expect(h.tunnel.createMapping('x', 3000)).rejects.toThrow(/configurado localmente/);
    expect(h.fake.state.configWrites).toHaveLength(0);
  });

  it('serializa escrituras concurrentes sin perder ninguna', async () => {
    // Sin el mutex, dos read-modify-write simultaneos se pisan y uno se pierde.
    const h = harness();
    await Promise.all([
      h.tunnel.createMapping('uno', 3001),
      h.tunnel.createMapping('dos', 3002),
      h.tunnel.createMapping('tres', 3003),
    ]);
    expect(h.hostnames().sort()).toEqual(['dos.nurbs.dev', 'tres.nurbs.dev', 'uno.nurbs.dev']);
    expect(h.ingress().at(-1)).toEqual(CATCH_ALL);
  });
});
