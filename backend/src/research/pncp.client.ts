import { FetchLike, requestJson, searchWords, stripAccents } from './research-text';

export type ItemCompra = {
  descricao: string;
  unidade: string;
  quantidade: number | null;
  precoEstimado: number | null;
  precoContratado: number | null;
};
export type CompraPncp = {
  orgao: string;
  municipio: string;
  uf: string;
  modalidade: string;
  data: string;
  link: string;
  objeto?: string;
  itens: ItemCompra[];
  valorTotal?: number | null;
};

const PNCP = 'https://pncp.gov.br';
const MAX_COMPRAS = 5;
const MAX_ITENS_POR_COMPRA = 10;
const RESULT_POOL = 3;
const MAX_RESULT_CALLS = 20;
const GET = { method: 'GET', headers: { Accept: 'application/json' } };

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

type Ref = { kind: 'edital' | 'ata' | 'contrato'; cnpj: string; ano: string; seq: string; seqAta?: string };

function identify(hit: any, tipo: string): Ref | null {
  const url = String(hit?.item_url ?? '');
  if (tipo === 'ata') {
    const m = /\/atas\/(\d+)\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    return m ? { kind: 'ata', cnpj: m[1], ano: m[2], seq: m[3], seqAta: m[4] } : null;
  }
  if (tipo === 'contrato') {
    const m = /\/contratos\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    return m ? { kind: 'contrato', cnpj: m[1], ano: m[2], seq: m[3] } : null;
  }
  const m = /\/compras\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  return m ? { kind: 'edital', cnpj: m[1], ano: m[2], seq: m[3] } : null;
}

function linkOf(id: Ref): string {
  if (id.kind === 'ata') return `${PNCP}/app/atas/${id.cnpj}/${id.ano}/${id.seq}/${id.seqAta}`;
  if (id.kind === 'contrato') return `${PNCP}/app/contratos/${id.cnpj}/${id.ano}/${id.seq}`;
  return `${PNCP}/app/editais/${id.cnpj}/${id.ano}/${id.seq}`;
}

/** Shared by one searchPurchases call: at most 3 /resultados in flight and 20 in total. */
type ResultBudget = { used: number; active: number; waiting: (() => void)[] };

async function resultPrice(url: string, signal: AbortSignal | undefined, fetchFn: FetchLike, budget: ResultBudget): Promise<number | null> {
  if (budget.used >= MAX_RESULT_CALLS) return null;
  budget.used++;
  while (budget.active >= RESULT_POOL) await new Promise<void>((resolve) => budget.waiting.push(resolve));
  budget.active++;
  try {
    const result = await requestJson(fetchFn, url, GET, signal);
    return result.ok && Array.isArray(result.data) ? num(result.data[0]?.valorUnitarioHomologado) : null;
  } catch {
    return null;
  } finally {
    budget.active--;
    budget.waiting.shift()?.();
  }
}

async function detail(hit: any, tipo: string, words: string[], signal: AbortSignal | undefined, fetchFn: FetchLike, budget: ResultBudget): Promise<CompraPncp | null> {
  const id = identify(hit, tipo);
  if (!id) return null;
  const head = {
    orgao: String(hit.orgao_nome ?? hit.unidade_nome ?? ''),
    municipio: String(hit.municipio_nome ?? ''),
    uf: String(hit.uf ?? ''),
    modalidade: String(hit.modalidade_licitacao_nome ?? ''),
    data: String(hit.data_publicacao_pncp ?? hit.createdAt ?? '').slice(0, 10),
    link: linkOf(id),
  };
  if (id.kind === 'contrato') {
    const total = Number(hit.valor_global);
    const objeto = String(hit.description ?? '').slice(0, 300);
    return { ...head, objeto, valorTotal: hit.valor_global !== null && hit.valor_global !== '' && Number.isFinite(total) ? total : null, itens: [] };
  }
  const base = `${PNCP}/api/pncp/v1/orgaos/${id.cnpj}/compras/${id.ano}/${id.seq}/itens`;
  const list = await requestJson(fetchFn, `${base}?pagina=1&tamanhoPagina=50`, GET, signal);
  if (!list.ok || !Array.isArray(list.data)) return null;
  const kept = list.data
    .filter((item: any) => {
      if (!item) return false;
      if (!words.length) return true;
      const description = stripAccents(String(item?.descricao ?? ''));
      return words.some((word) => description.includes(word));
    })
    .slice(0, MAX_ITENS_POR_COMPRA);
  const itens: ItemCompra[] = await Promise.all(
    kept.map(async (item: any) => {
      const precoContratado = item?.temResultado ? await resultPrice(`${base}/${item.numeroItem}/resultados`, signal, fetchFn, budget) : null;
      return {
        descricao: String(item.descricao ?? '').slice(0, 200),
        unidade: String(item.unidadeMedida ?? ''),
        quantidade: num(item.quantidade),
        precoEstimado: num(item.valorUnitarioEstimado),
        precoContratado,
      };
    }),
  );
  return { ...head, itens };
}

export async function searchPurchases(
  input: { termo: string; tipo?: 'edital' | 'ata' | 'contrato'; uf?: string },
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch as FetchLike,
): Promise<{ compras: CompraPncp[] }> {
  const tipo = input.tipo ?? 'edital';
  const params = new URLSearchParams({ q: input.termo, tipos_documento: tipo, pagina: '1', tam_pagina: '10' });
  const uf = (input.uf ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(uf)) params.set('ufs', uf);
  const search = await requestJson(fetchFn, `${PNCP}/api/search/?${params.toString().replace(/\+/g, '%20')}`, GET, signal);
  if (!search.ok) throw new Error('PNCP_FALHOU');
  const hits: any[] = Array.isArray(search.data?.items) ? search.data.items.slice(0, MAX_COMPRAS) : [];
  const words = searchWords(input.termo);
  const budget: ResultBudget = { used: 0, active: 0, waiting: [] };
  const details = await Promise.all(hits.map((hit) => detail(hit, tipo, words, signal, fetchFn, budget).catch(() => null)));
  return { compras: details.filter((c): c is CompraPncp => c !== null) };
}
