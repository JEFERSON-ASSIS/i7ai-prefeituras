const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { searchWeb } = require('../dist/research/serper.client');
const { searchPurchases } = require('../dist/research/pncp.client');
const { clip } = require('../dist/research/research-text');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'research', name), 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Serper envia POST com chave e corpo esperados e devolve até 8 resultados', async () => {
  const calls = [];
  const organic = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, link: `https://x.test/${i}`, snippet: `S${i}` }));
  const fetchFn = async (url, init) => { calls.push({ url, init }); return json({ organic }); };
  const out = await searchWeb('preço do arroz', 'chave-1', undefined, fetchFn);
  assert.equal(calls[0].url, 'https://google.serper.dev/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-KEY'], 'chave-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { q: 'preço do arroz', gl: 'br', hl: 'pt-br', num: 8 });
  assert.equal(out.resultados.length, 8);
  assert.deepEqual(out.resultados[0], { titulo: 'T0', link: 'https://x.test/0', trecho: 'S0' });
});

test('Serper 403 vira SERPER_RECUSOU', async () => {
  await assert.rejects(searchWeb('x', 'k', undefined, async () => json({}, 403)), /SERPER_RECUSOU/);
});

test('timeout de 10 s e sinal do chamador são combinados', async () => {
  let seen;
  const controller = new AbortController();
  await searchWeb('x', 'k', controller.signal, async (_u, init) => { seen = init.signal; return json({ organic: [] }); });
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, false);
  controller.abort();
  assert.equal(seen.aborted, true);
  // sem sinal do chamador ainda há o tempo limite
  let own;
  await searchWeb('x', 'k', undefined, async (_u, init) => { own = init.signal; return json({ organic: [] }); });
  assert.ok(own instanceof AbortSignal);
});

function pncpFetch({ failItens = [], calls = [] } = {}) {
  const search = fixture('pncp-search.json');
  const itens = fixture('pncp-itens.json');
  itens.push({ numeroItem: 2, descricao: 'AÇÚCAR CRISTAL', unidadeMedida: 'KG', quantidade: 10, valorUnitarioEstimado: 4, temResultado: false });
  const resultados = fixture('pncp-resultados.json');
  return async (url) => {
    calls.push(url);
    if (url.includes('/api/search/')) return json(search);
    if (failItens.some((id) => url.includes(`/compras/2025/${id}/itens`))) return json({}, 500);
    if (/\/itens\/\d+\/resultados$/.test(url)) return json(resultados);
    if (url.includes('/itens?')) return json(itens);
    return json({}, 404);
  };
}

test('PNCP filtra por palavra do termo, traz preço contratado e monta o link', async () => {
  const calls = [];
  const out = await searchPurchases({ termo: 'arroz merenda' }, undefined, pncpFetch({ calls }));
  assert.equal(out.compras.length, 2);
  const [first] = out.compras;
  assert.equal(first.link, 'https://pncp.gov.br/app/editais/46643474000152/2024/25');
  assert.equal(first.uf, 'SP');
  assert.equal(first.data, '2024-06-07');
  assert.equal(first.itens.length, 1);
  assert.match(first.itens[0].descricao, /^Arroz tipo 01/);
  assert.equal(first.itens[0].precoEstimado, 28.63);
  assert.equal(first.itens[0].precoContratado, 26.45);
  assert.ok(calls[0].includes('tipos_documento=edital'));
  assert.ok(calls[0].includes('q=arroz+merenda') || calls[0].includes('q=arroz%20merenda'));
  assert.ok(!calls[0].includes('ufs='));
});

test('PNCP envia ufs=MT quando uf é MT', async () => {
  const calls = [];
  await searchPurchases({ termo: 'arroz', uf: 'mt', tipo: 'ata' }, undefined, pncpFetch({ calls }));
  assert.ok(calls[0].includes('ufs=MT'));
  assert.ok(calls[0].includes('tipos_documento=ata'));
});

test('compra cujo /itens dá 500 é pulada e as demais voltam', async () => {
  const out = await searchPurchases({ termo: 'arroz' }, undefined, pncpFetch({ failItens: [1216] }));
  assert.equal(out.compras.length, 1);
  assert.equal(out.compras[0].link, 'https://pncp.gov.br/app/editais/46643474000152/2024/25');
});

test('falha na busca do PNCP lança erro para a ferramenta tratar', async () => {
  await assert.rejects(searchPurchases({ termo: 'arroz' }, undefined, async () => json({}, 503)), /PNCP_FALHOU/);
});

test('clip corta em 12000 por padrão e marca', () => {
  const out = clip('a'.repeat(20000));
  assert.equal(out.length, 12000);
  assert.ok(out.endsWith('…(cortado)'));
  assert.ok(clip({ a: 'b'.repeat(20000) }, 100).endsWith('…(cortado)'));
  assert.equal(clip({ a: 1 }), '{"a":1}');
});

test('ata: lê itens da compra do item_url e linka a ata', async () => {
  const calls = [];
  const itens = [{ numeroItem: 1, descricao: 'Arroz polido', unidadeMedida: 'KG', quantidade: null, valorUnitarioEstimado: null, temResultado: false }, null];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/api/search/')) return json(fixture('pncp-search-ata.json'));
    return json(itens);
  };
  const out = await searchPurchases({ termo: 'arroz', tipo: 'ata' }, undefined, fetchFn);
  assert.ok(calls.some((u) => u.includes('/orgaos/51885242000140/compras/2024/483/itens?')));
  assert.equal(out.compras[0].link, 'https://pncp.gov.br/app/atas/51885242000140/2024/483/1');
  assert.equal(out.compras[0].itens[0].quantidade, null);
  assert.equal(out.compras[0].itens[0].precoEstimado, null);
  assert.equal(out.compras[0].itens[0].precoContratado, null);
});

test('contrato: sem itens, com objeto e valor global', async () => {
  const calls = [];
  const out = await searchPurchases({ termo: 'arroz', tipo: 'contrato' }, undefined, async (url) => { calls.push(url); return json(fixture('pncp-search-contrato.json')); });
  assert.equal(calls.length, 1);
  const [c] = out.compras;
  assert.deepEqual(c.itens, []);
  assert.equal(c.valorTotal, 417240);
  assert.match(c.objeto, /ARROZ/);
  assert.equal(c.link, 'https://pncp.gov.br/app/contratos/76417005001743/2024/214');
});

test('hit sem item_url compatível é pulado', async () => {
  const hit = { ...fixture('pncp-search.json').items[0], item_url: '/outra/coisa', ano: '2024', numero_sequencial: '25' };
  const out = await searchPurchases({ termo: 'arroz' }, undefined, async () => json({ items: [hit] }));
  assert.deepEqual(out.compras, []);
});

test('corpo que não é JSON vira erro', async () => {
  const bad = async () => new Response('<html>', { status: 200 });
  await assert.rejects(searchWeb('x', 'k', undefined, bad), /SERPER_FALHOU/);
  await assert.rejects(searchPurchases({ termo: 'arroz' }, undefined, bad), /PNCP_FALHOU/);
});
