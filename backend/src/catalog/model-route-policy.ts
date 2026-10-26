// OmniRoute also exposes personal subscriptions and free web proxies (antigravity/, cx/, auto/ ...).
// Municipal data may only reach routes backed by provider API keys under commercial terms.
export const DEFAULT_ALLOWED_ROUTE_PREFIXES = ['openai', 'anthropic', 'gemini', 'xai'];

export function allowedRoutePrefixes(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.OMNIROUTER_ALLOWED_PREFIXES?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_ROUTE_PREFIXES;
}

export const gatewayRoutingActive = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.OMNIROUTER_BASE_URL?.trim());

/** True when the slug may be sent through the central gateway. Prefix-less slugs are gateway combos and are refused. */
export function isAllowedRoute(slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  const value = slug?.trim().toLowerCase() || '';
  const separator = value.indexOf('/');
  return separator > 0 && allowedRoutePrefixes(env).includes(value.slice(0, separator));
}

export function routePolicyMessage(slug: string, env: NodeJS.ProcessEnv = process.env) {
  return `O modelo ${slug} não usa uma rota liberada para dados da prefeitura. Use modelos com os prefixos ${allowedRoutePrefixes(env).join(', ')} (chaves de API com termos comerciais).`;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Gateway base URL policy. HTTPS anywhere; plain HTTP only for localhost during
 * development, or for Docker service names listed in OMNIROUTER_INTERNAL_HOSTS
 * (for example a LiteLLM container on the same private compose network).
 */
export function gatewayBaseAllowed(base: URL, env: NodeJS.ProcessEnv = process.env, internalHostsVariable = 'OMNIROUTER_INTERNAL_HOSTS') {
  if (base.username || base.password || base.search || base.hash) return false;
  if (base.protocol === 'https:') return true;
  if (base.protocol !== 'http:') return false;
  if (env.NODE_ENV !== 'production' && LOCAL_HOSTS.includes(base.hostname)) return true;
  const internal = env[internalHostsVariable]?.split(',').map(item => item.trim().toLowerCase()).filter(item => /^[a-z0-9][a-z0-9_-]*$/.test(item)) || [];
  return internal.includes(base.hostname.toLowerCase());
}
