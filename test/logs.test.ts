import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileFollower, LogRing, readLastLines } from '../src/core/logs.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-logs-'));
  dirs.push(dir);
  const file = join(dir, 'test.log');
  writeFileSync(file, content);
  return file;
}

describe('LogRing', () => {
  it('descarta las lineas mas viejas al pasarse del maximo', () => {
    const ring = new LogRing(3);
    for (const l of ['a', 'b', 'c', 'd', 'e']) ring.push(l);
    expect(ring.lines).toEqual(['c', 'd', 'e']);
  });

  it('parte un chunk en lineas y descarta las vacias', () => {
    const ring = new LogRing(10);
    expect(ring.pushChunk('uno\ndos\n\ntres\n')).toEqual(['uno', 'dos', 'tres']);
  });
});

describe('readLastLines', () => {
  it('devuelve las ultimas N lineas', async () => {
    const file = tmpFile(Array.from({ length: 50 }, (_, i) => `linea ${i}`).join('\n'));
    expect(await readLastLines(file, 3)).toEqual(['linea 47', 'linea 48', 'linea 49']);
  });

  it('devuelve todo si el archivo es mas corto que N', async () => {
    expect(await readLastLines(tmpFile('a\nb\n'), 100)).toEqual(['a', 'b']);
  });

  it('no pierde lineas cuando el archivo cabe entero en la ventana', async () => {
    // La logica descarta la primera linea por venir cortada, pero solo debe
    // hacerlo si de verdad empezamos a leer a media linea.
    const file = tmpFile('primera\nsegunda\ntercera');
    expect(await readLastLines(file, 10)).toEqual(['primera', 'segunda', 'tercera']);
  });

  it('no trunca una linea a la mitad al leer solo la cola', async () => {
    // Lineas largas: la ventana (N*512) arranca en medio de una linea.
    const long = Array.from({ length: 200 }, (_, i) => `${i}:${'x'.repeat(400)}`).join('\n');
    const out = await readLastLines(tmpFile(long), 5);
    expect(out).toHaveLength(5);
    for (const line of out) expect(line).toMatch(/^\d+:x+$/);
  });

  it('devuelve vacio si el archivo no existe', async () => {
    expect(await readLastLines('/no/existe/nada.log', 10)).toEqual([]);
  });
});

describe('FileFollower', () => {
  it('emite solo las lineas agregadas despues de arrancar', async () => {
    const file = tmpFile('vieja\n');
    const seen: string[] = [];
    const f = new FileFollower(file, 20);
    f.on('line', (l: string) => seen.push(l));
    f.start();

    appendFileSync(file, 'nueva1\nnueva2\n');
    await new Promise((r) => setTimeout(r, 120));
    f.stop();

    expect(seen).toEqual(['nueva1', 'nueva2']);
    expect(seen).not.toContain('vieja');
  });

  it('vuelve a empezar si el log rota (encoge)', async () => {
    const file = tmpFile('a\nb\nc\nd\ne\n');
    const seen: string[] = [];
    const f = new FileFollower(file, 20);
    f.on('line', (l: string) => seen.push(l));
    f.start();

    writeFileSync(file, 'rotado\n'); // el archivo encoge
    await new Promise((r) => setTimeout(r, 120));
    f.stop();

    expect(seen).toContain('rotado');
  });
});
