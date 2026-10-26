import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { gatewayBaseAllowed } from '../catalog/model-route-policy';

/** Admin access to the LiteLLM gateway: root URL (without /v1) and the admin key. */
export function litellmAdmin() {
  const configured = (process.env.LITELLM_ADMIN_URL || process.env.OMNIROUTER_BASE_URL || '').trim();
  const key = (process.env.LITELLM_ADMIN_KEY || process.env.OMNIROUTER_API_KEY || '').trim();
  if (!configured || !key || /[\r\n]/.test(key)) throw new ServiceUnavailableException('Configure o gateway de IA (LiteLLM) no servidor.');
  let url: URL;
  try { url = new URL(configured); } catch { throw new ServiceUnavailableException('O endereço do gateway de IA é inválido.'); }
  if (!gatewayBaseAllowed(url)) throw new ServiceUnavailableException('O gateway de IA deve usar HTTPS, salvo localhost no desenvolvimento ou serviços internos em OMNIROUTER_INTERNAL_HOSTS.');
  return { base: url.href.replace(/\/+$/, '').replace(/\/v1$/, ''), key };
}

/** Calls a LiteLLM admin route. `allowNotFound` turns 404 into null. */
export async function litellmCall(method: string, path: string, body?: unknown, allowNotFound = false, timeoutMs = 15000): Promise<unknown> {
  const { base, key } = litellmAdmin();
  let response: Response;
  try {
    response = await fetch(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ServiceUnavailableException('O gateway de IA não respondeu. Verifique se o LiteLLM está em execução.');
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new BadGatewayException('O gateway de IA recusou a operação: ' + await litellmErrorMessage(response));
  return response.json().catch(() => ({}));
}

export async function litellmErrorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : 'HTTP ' + response.status;
  return message.split(String.fromCharCode(10))[0].replace(/^litellm\.\w+:\s*/, '').slice(0, 300);
}
