import { htmlToPage, isHtmlContentType, HTML_MAX_BYTES } from './html-text';
import { BadGatewayException, BadRequestException, ForbiddenException, GatewayTimeoutException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Only globally routable unicast IPv6 is accepted. This also rejects mapped
  // IPv4, link-local, ULA, multicast, translation and unspecified addresses.
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/.test(ip) && !/^2001:(?:0*db8:|0+:|:)/.test(ip) && !/^2002:/.test(ip);
  return false;
}

export function normalizeDomains(domains: string[]): string[] {
  if (!Array.isArray(domains) || !domains.length || domains.length > 100) throw new BadRequestException('Informe os domínios autorizados');
  return [...new Set(domains.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 253) throw new BadRequestException('Domínio inválido');
    const value = entry.trim().toLowerCase().replace(/\.$/, '');
    const wildcard = value.startsWith('*.');
    const hostname = wildcard ? value.slice(2) : value;
    if (!hostname || /[\s/@?#:]/.test(hostname) || (!isIP(hostname) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) || hostname.includes('..')) throw new BadRequestException('Use apenas nomes de domínio, sem URL, porta ou caminho');
    if (wildcard && (isIP(hostname) || !hostname.includes('.'))) throw new BadRequestException('Domínio curinga inválido');
    return (wildcard ? '*.' : '') + hostname;
  }))];
}

export function assertAllowedUrl(endpoint: string, allowedDomains: string[]): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new BadRequestException('URL da ferramenta inválida'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ForbiddenException('URL deve usar HTTP(S), sem credenciais nem fragmento');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!allowedDomains.some((domain) => domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host !== domain.slice(2) : host === domain)) throw new ForbiddenException('Domínio não autorizado para esta ferramenta');
  if (isIP(host) && !isPublicAddress(host) && !allowPrivateNetwork()) throw new ForbiddenException('Endereços privados ou locais não são autorizados');
  if (!allowPrivateNetwork() && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.'))) throw new ForbiddenException('Destino local não autorizado');
  return url;
}

function allowPrivateNetwork() {
  return process.env.NODE_ENV !== 'production' && process.env.TOOLS_ALLOW_PRIVATE_NETWORK === 'true';
}

export type SafeHttpResult = { statusCode: number; data: unknown; headers: Record<string, string | string[] | undefined> };
export async function safeHttpRequest(options: {
  endpoint: string; allowedDomains: string[]; method?: string; headers?: Record<string, string>;
  body?: unknown; timeoutMs?: number; signal?: AbortSignal; responseId?: number;
}): Promise<SafeHttpResult> {
  const url = assertAllowedUrl(options.endpoint, options.allowedDomains);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (options.signal?.aborted) throw new GatewayTimeoutException('Execução cancelada');
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 15000, 30000));
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }).catch(() => { throw new BadGatewayException('Não foi possível resolver o destino'); }),
    new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new GatewayTimeoutException('Tempo de resolução do destino excedido')), timeoutMs); }),
  ]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
  if (!addresses.length || (!allowPrivateNetwork() && addresses.some(({ address }) => !isPublicAddress(address)))) throw new ForbiddenException('Destino resolveu para um endereço privado ou não autorizado');
  if (options.signal?.aborted) throw new GatewayTimeoutException('Execução cancelada');
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body && Buffer.byteLength(body) > 1024 * 1024) throw new BadRequestException('Entrada da ferramenta excede 1 MB');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (error?: Error, result?: SafeHttpResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method ?? 'POST', headers: { 'content-type': 'application/json', ...options.headers },
      // Pin the address already checked above so DNS cannot rebind between the
      // policy check and the socket connection. Keep hostname for TLS/SNI.
      lookup: (_host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [addresses[0]] as any);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 502;
      if (statusCode >= 300 && statusCode < 400) { response.resume(); done(new ForbiddenException('Redirecionamentos de ferramentas não são autorizados')); return; }
      let content = ''; let bytes = 0;
      const isHtml = isHtmlContentType(response.headers['content-type']);
      const limit = isHtml ? HTML_MAX_BYTES : 1024 * 1024;
      response.setEncoding('utf8');
      const result = (data: unknown): SafeHttpResult => ({ statusCode, data, headers: response.headers });
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > limit) {
          if (!isHtml) { done(new BadGatewayException('Resposta da ferramenta excede 1 MB')); response.destroy(); return; }
          // HTML pages are cut at the cap instead of failing; the tail is irrelevant for reading.
          done(undefined, result(htmlToPage(content + chunk, url.toString(), statusCode))); response.destroy(); return;
        }
        content += chunk;
        if (options.responseId !== undefined && String(response.headers['content-type']).includes('text/event-stream')) {
          const frames = content.split(/\r?\n\r?\n/); content = frames.pop() ?? '';
          for (const frame of frames) {
            const payload = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!payload) continue;
            try {
              const message = JSON.parse(payload);
              if (message.id === options.responseId && (message.result !== undefined || message.error !== undefined)) { done(undefined, result(message)); response.destroy(); break; }
            } catch { done(new BadGatewayException('Resposta MCP inválida')); response.destroy(); }
          }
        }
      });
      response.on('end', () => {
        if (settled) return;
        let data: unknown = content;
        if (isHtml && content) { done(undefined, result(htmlToPage(content, url.toString(), statusCode))); return; }
        if (content) { try { data = JSON.parse(content); } catch { /* Plain HTTP text is supported. */ } }
        done(undefined, result(data));
      });
      response.on('error', () => done(new BadGatewayException('Falha ao receber resposta da ferramenta')));
    });
    const abort = () => { done(new GatewayTimeoutException('Execução cancelada')); req.destroy(); };
    timer = setTimeout(() => { done(new GatewayTimeoutException('Tempo de execução da ferramenta excedido')); req.destroy(); }, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    req.on('error', () => done(new BadGatewayException('Falha na conexão com a ferramenta')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
