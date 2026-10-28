export const HTTP_TYPES = ['REST_API', 'HTTP_REQUEST', 'WEBHOOK', 'N8N'];
export const TYPE_LABELS = {
  REST_API: 'Ler site ou API (GET/POST)',
  HTTP_REQUEST: 'Requisição HTTP',
  WEBHOOK: 'Webhook',
  N8N: 'n8n',
  MCP_SERVER: 'Servidor MCP',
  EXTERNAL_SEARCH: 'Pesquisa externa',
  INTERNAL_DATABASE: 'Banco interno'
};
export const TYPE_ORDER = ['REST_API', 'HTTP_REQUEST', 'WEBHOOK', 'N8N', 'MCP_SERVER', 'EXTERNAL_SEARCH', 'INTERNAL_DATABASE'];
export const BASIC_METHODS = [['GET', 'Ler página ou dados (GET)'], ['POST', 'Enviar dados (POST)']];
export const ADVANCED_METHODS = [['PUT', 'Atualizar dados (PUT)'], ['PATCH', 'Atualizar parte dos dados (PATCH)'], ['DELETE', 'Apagar dados (DELETE)']];
// O servidor aceita no máximo 30000 ms (tools.service.ts), por isso não há opção de 60 s.
export const TIMEOUTS = [[10000, '10 segundos'], [15000, '15 segundos'], [30000, '30 segundos']];
const KNOWN_KEYS = ['endpoint', 'url', 'method', 'headers', 'body', 'timeoutMs'];

export function defaultHttpForm() {
  return { url: '', method: 'GET', timeoutMs: 15000, headers: [], body: '' };
}
export function defaultConfig(type) {
  if (type === 'INTERNAL_DATABASE') return { resource: 'documents', maxResults: 10 };
  if (type === 'EXTERNAL_SEARCH') return { endpoint: '', queryParam: 'q', maxResults: 10, timeoutMs: 15000 };
  return { endpoint: '', method: 'GET', headers: {}, timeoutMs: 15000 };
}
export function hostOf(url) {
  try {
    const parsed = new URL(String(url).trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}
export function suggestDomains(url) {
  const host = hostOf(url);
  if (!host) return [];
  if (host.startsWith('www.') && host.length > 4) return [host.slice(4), host];
  return [host];
}
export function isValidUrl(url) {
  return Boolean(hostOf(url));
}
export function parseDomains(text) {
  return String(text || '').split(',').map(value => value.trim()).filter(Boolean);
}

/** Converte a configuração salva nos campos do formulário; devolve null se houver algo que o formulário não representa. */
export function configToForm(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (Object.keys(config).some(key => !KNOWN_KEYS.includes(key))) return null;
  const url = config.endpoint ?? config.url ?? '';
  const method = config.method ?? 'GET';
  const timeoutMs = config.timeoutMs ?? 15000;
  if (typeof url !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !Number.isInteger(timeoutMs)) return null;
  const headersObject = config.headers ?? {};
  if (!headersObject || typeof headersObject !== 'object' || Array.isArray(headersObject)) return null;
  if (Object.values(headersObject).some(value => typeof value !== 'string')) return null;
  if (typeof config.body === 'string') return null;
  return {
    url, method, timeoutMs,
    headers: Object.entries(headersObject).map(([key, value]) => ({ key, value })),
    body: config.body === undefined ? '' : JSON.stringify(config.body, null, 2)
  };
}
/** Monta a configuração enviada ao servidor. Lança Error com mensagem em português se algo estiver inválido. */
export function formToConfig(form, lenient = false) {
  const url = form.url.trim();
  if (!lenient && !isValidUrl(url)) throw new Error('Informe o endereço começando com https:// ou http://');
  const config = { endpoint: url, method: form.method, headers: {}, timeoutMs: Number(form.timeoutMs) };
  for (const { key, value } of form.headers) {
    const name = key.trim();
    if (!name) continue;
    config.headers[name] = value;
  }
  if (form.method !== 'GET' && form.body.trim()) {
    try {
      config.body = JSON.parse(form.body);
    } catch {
      if (lenient) return config;
      throw new Error('O conteúdo a enviar precisa estar em formato JSON válido.');
    }
  }
  return config;
}
