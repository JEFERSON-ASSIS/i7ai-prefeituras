import { gatewayBaseAllowed } from '../catalog/model-route-policy';

/** SGDM answered 404: the tenant, user or route is unknown there (or its integration key is not configured). */
export class SgdmNotFound extends Error {
  constructor() { super('O SGDM não encontrou o recurso solicitado.'); this.name = 'SgdmNotFound'; }
}

/** SGDM could not be reached or refused the request. The message never contains the integration key. */
export class SgdmUnavailable extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'SgdmUnavailable'; }
}

/** Server-to-server integration needs both the SGDM URL and the shared key; otherwise i7Ai runs standalone. */
export function sgdmIntegrationEnabled(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.SGDM_API_URL?.trim() && env.SGDM_INTEGRATION_KEY?.trim());
}

/** GET on SGDM's internal `/integracoes/i7ai/*` API with the integration key; JSON body on success. */
export async function sgdmIntegrationGet<T>(path: string, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!sgdmIntegrationEnabled(env)) throw new SgdmUnavailable('Integração com o SGDM não configurada.');
  let base: URL;
  try { base = new URL(env.SGDM_API_URL!.trim()); } catch { throw new SgdmUnavailable('SGDM_API_URL inválida.'); }
  if (!gatewayBaseAllowed(base, env, 'SGDM_INTERNAL_HOSTS')) throw new SgdmUnavailable('SGDM_API_URL não permitida (use HTTPS ou um host interno declarado).');
  let response: Response;
  try {
    response = await fetch(base.href.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''), {
      redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + env.SGDM_INTEGRATION_KEY!.trim(), Accept: 'application/json' },
    });
  } catch {
    throw new SgdmUnavailable('O SGDM não respondeu.');
  }
  if (response.status === 404) throw new SgdmNotFound();
  if (!response.ok) throw new SgdmUnavailable('O SGDM recusou a consulta (HTTP ' + response.status + ').', response.status);
  try { return await response.json() as T; } catch { throw new SgdmUnavailable('O SGDM devolveu uma resposta inválida.', response.status); }
}
