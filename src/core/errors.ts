export interface CfError {
  code: number;
  message: string;
}

/**
 * Los codigos de error de Cloudflare son crípticos y varios significan lo mismo
 * ("no tienes permiso") desde capas distintas. Traducirlos aqui evita que el
 * usuario final tenga que buscar el numero.
 */
const HINTS: Record<number, string> = {
  1000: 'Token invalido, revocado o mal copiado.\n     Ojo: los tokens account-owned (prefijo "cfat_") SIEMPRE fallan en /user/tokens/verify,\n     aunque esten perfectos. Verificalos con: GET /accounts/{account_id}/tokens/verify\n     (es GET; POST devuelve 7001 "Method POST not available for that URI").',
  1001: 'El token es valido pero no tiene permiso sobre este recurso.\n     Para el tunel hace falta el grupo "Argo Tunnel (Legacy)" > Edit sobre Entire Account\n     (en el UI actual NO existe un grupo llamado "Cloudflare Tunnel"; el grupo nuevo\n     "Connectivity Directory" NO cubre los endpoints /cfd_tunnel que usa esta herramienta).\n     Sintoma tipico: listar tuneles devuelve success:true con total_count:0 en vez de 403.',
  1004: 'Cloudflare rechazo el registro DNS (validacion). Revisa nombre y contenido.',
  6003: 'Cabecera de autenticacion mal formada. Revisa que CF_API_TOKEN no tenga comillas ni espacios.',
  7003: 'Ruta o identificador inexistente. Revisa CF_ACCOUNT_ID / CF_ZONE_ID / CF_TUNNEL_ID.',
  9106: 'Falta el token o no aplica a esta cuenta.',
  9109: 'El token no tiene alcance sobre esta cuenta.\n     Si el token es account-owned, confirma que pertenece a la cuenta correcta.',
  10000: 'Autenticacion fallida.',
  81044: 'El registro DNS no existe.',
  81053: 'Ya existe un registro DNS con ese nombre.',
  81057: 'Ya existe un registro DNS identico.',
};

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CfError[];
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, errors: CfError[]) {
    const parts = errors.length
      ? errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
      : `HTTP ${status}`;
    super(`${method} ${path} fallo: ${parts}`);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.errors = errors;
    this.method = method;
    this.path = path;
  }

  /** Pistas accionables para los codigos que trae este error. */
  get hints(): string[] {
    const out: string[] = [];
    for (const e of this.errors) {
      const h = HINTS[e.code];
      if (h && !out.includes(h)) out.push(h);
    }
    if (!out.length && this.status === 403) out.push(HINTS[1001]!);
    return out;
  }

  has(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

/** Error de configuracion local (.env, estado). No es culpa de Cloudflare. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Error de validacion o de negocio de la propia herramienta. */
export class TunnelManagerError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'TunnelManagerError';
    this.hint = hint;
  }
}
