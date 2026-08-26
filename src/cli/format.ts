// El byte ESC se construye con fromCharCode para no incrustar un caracter de
// control literal en el fuente.
const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Ancho visible ignorando secuencias ANSI. */
function width(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd();
  const out = [c.bold(line(headers)), c.gray(widths.map((w) => '-'.repeat(w)).join('  '))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}
