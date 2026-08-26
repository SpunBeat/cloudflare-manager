import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

export type Mode = 'service' | 'spawn';

export interface Config {
  apiToken: string;
  accountId: string;
  zoneId: string;
  tunnelId: string;
  baseDomain: string;
  tunnelToken?: string;
  apiBase: string;
}

/** Parser minimo de .env. No expande variables ni ejecuta nada. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Quitar comillas envolventes si las hay: un token entre comillas produce
    // un 6003 de Cloudflare que es dificil de diagnosticar.
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Carga .env sin pisar variables que ya existan en el entorno real. */
export function loadDotEnv(envPath?: string): void {
  const path = envPath ?? resolve(findProjectRoot(), '.env');
  if (!existsSync(path)) return;
  const vars = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const req = (key: string): string => {
    const v = env[key]?.trim();
    if (!v) missing.push(key);
    return v ?? '';
  };

  const apiToken = req('CF_API_TOKEN');
  const accountId = req('CF_ACCOUNT_ID');
  const zoneId = req('CF_ZONE_ID');
  const tunnelId = req('CF_TUNNEL_ID');
  const baseDomain = req('BASE_DOMAIN');

  if (missing.length) {
    throw new ConfigError(
      `Faltan variables en .env: ${missing.join(', ')}\n` +
        `Copia .env.example a .env y llena los valores.`,
    );
  }

  const bad: string[] = [];
  if (!HEX32_RE.test(accountId)) bad.push(`CF_ACCOUNT_ID debe ser 32 hex (recibi ${accountId.length} chars)`);
  if (!HEX32_RE.test(zoneId)) bad.push(`CF_ZONE_ID debe ser 32 hex (recibi ${zoneId.length} chars)`);
  if (!UUID_RE.test(tunnelId)) bad.push(`CF_TUNNEL_ID debe ser un UUID (recibi "${tunnelId}")`);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(baseDomain)) bad.push(`BASE_DOMAIN no parece un dominio: "${baseDomain}"`);
  if (bad.length) throw new ConfigError(`Valores invalidos en .env:\n  - ${bad.join('\n  - ')}`);

  const cfg: Config = {
    apiToken,
    accountId,
    zoneId,
    tunnelId,
    baseDomain: baseDomain.toLowerCase(),
    apiBase: env.CF_API_BASE?.trim() || 'https://api.cloudflare.com/client/v4',
  };
  const tt = env.CF_TUNNEL_TOKEN?.trim();
  if (tt) cfg.tunnelToken = tt;
  return cfg;
}

/** El contenido que debe tener el CNAME de cualquier hostname del tunel. */
export function tunnelCname(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}
