import { FetchLike, requestJson, searchWords, stripAccents } from './research-text';

export type ItemCompra = {
  descricao: string;
  unidade: string;
  quantidade: number;
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
  itens: ItemCompra[];
};

const PNCP = 'https://pncp.gov.br';
const MAX_COMPRAS = 5;
const MAX_ITENS_POR_COMPRA = 10;
const GET = { method: 'GET', headers: { Accept: 'application/json' } };

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function identify(hit: any): { cnpj: string; ano: string; seq: string } | null {
  const fromUrl = /\/compras\/(\d+)\/(\d+)\/(\d+)/.exec(String(hit?.item_url ?? ''));
  if (fromUrl) return { cnpj: fromUrl[1], ano: fromUrl[2], seq: fromUrl[3] };
  const cnpj = String(hit?.orgao_cnpj ?? '');
  const ano = String(hit?.ano ?? '');
  const seq = String(hit?.numero_sequencial ?? '');
  return /^\d+$/.test(cnpj) && /^\d+$/.test(ano) && /^\d+$/.test(seq) ? { cnpj, ano, seq } : null;
}

async function detail(hit: any, words: string[], signal: AbortSignal | undefined, fetchFn: FetchLike): Promise<CompraPncp | null> {
  const id = identify(hit);
  if (!id) return null;
  const base = `${PNCP}/api/pncp/v1/orgaos/${id.cnpj}/compras/${id.ano}/${id.seq}/itens`;
  const list = await requestJson(fetchFn, `${base}?pagina=1&tamanhoPagina=50`, GET, signal);
  if (!list.ok || !Array.isArray(list.data)) return null;
  const kept = list.data
    .filter((item: any) => {
      if (!words.length) return true;
      const description = stripAccents(String(item?.descricao ?? ''));
      return words.some((word) => description.includes(word));
    })
    .slice(0, MAX_ITENS_POR_COMPRA);
  const itens: ItemCompra[] = await Promise.all(
    kept.map(async (item: any) => {
      let precoContratado: number | null = null;
      if (item.temResultado) {
        try {
          const result = await requestJson(fetchFn, `${base}/${item.numeroItem}/resultados`, GET, signal);
          if (result.ok && Array.isArray(result.data)) precoContratado = num(result.data[0]?.valorUnitarioHomologado);
        } catch {
          precoContratado = null;
        }
      }
      return {
        descricao: String(item.descricao ?? '').slice(0, 200),
        unidade: String(item.unidadeMedida ?? ''),
        quantidade: num(item.quantidade) ?? 0,
        precoEstimado: num(item.valorUnitarioEstimado),
        precoContratado,
      };
    }),
  );
  return {
    orgao: String(hit.orgao_nome ?? hit.unidade_nome ?? ''),
    municipio: String(hit.municipio_nome ?? ''),
    uf: String(hit.uf ?? ''),
    modalidade: String(hit.modalidade_licitacao_nome ?? ''),
    data: String(hit.data_publicacao_pncp ?? hit.createdAt ?? '').slice(0, 10),
    link: `${PNCP}/app/editais/${id.cnpj}/${id.ano}/${id.seq}`,
    itens,
  };
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
  const details = await Promise.all(hits.map((hit) => detail(hit, words, signal, fetchFn).catch(() => null)));
  return { compras: details.filter((c): c is CompraPncp => c !== null) };
}
