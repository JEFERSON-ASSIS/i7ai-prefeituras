import { FetchLike, requestJson } from './research-text';

export type ResultadoWeb = { titulo: string; link: string; trecho: string };

export async function searchWeb(
  query: string,
  key: string,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch as FetchLike,
): Promise<{ resultados: ResultadoWeb[] }> {
  const response = await requestJson(
    fetchFn,
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 8 }),
    },
    signal,
  );
  if (response.status === 401 || response.status === 403) throw new Error('SERPER_RECUSOU');
  if (!response.ok) throw new Error('SERPER_FALHOU');
  const organic = Array.isArray(response.data?.organic) ? response.data.organic : [];
  return {
    resultados: organic
      .filter((item: any) => item && typeof item.link === 'string')
      .slice(0, 8)
      .map((item: any) => ({
        titulo: String(item.title ?? ''),
        link: String(item.link),
        trecho: String(item.snippet ?? ''),
      })),
  };
}
