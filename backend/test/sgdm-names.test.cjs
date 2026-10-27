const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const { SgdmNamesController } = require('../dist/sgdm/sgdm-names.controller');
const { SgdmNamesService } = require('../dist/sgdm/sgdm-names.service');

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '11111111-1111-4111-8111-222222222222';
const C1 = '22222222-2222-4222-8222-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '22222222-2222-4222-8222-333333333333';
const saved = process.env.SGDM_INTEGRATION_KEY;
test.afterEach(() => saved === undefined ? delete process.env.SGDM_INTEGRATION_KEY : process.env.SGDM_INTEGRATION_KEY = saved);

function build() {
  const queries = [];
  const prisma = {
    agent: { findMany: async args => { queries.push(['agent', args]); return [{ id: A1, name: 'Agente Jurídico' }].filter(row => args.where.id.in.includes(row.id)); } },
    conversation: { findMany: async args => { queries.push(['conversation', args]); return [
      { id: C1, title: 'Parecer', theme: 'juridico', themeVersion: 1, agent: { name: 'Agente Jurídico' } },
      { id: C2, title: null, theme: null, themeVersion: 1, agent: { name: 'Agente Jurídico' } },
      { id: C3, title: 'CPF 123.456.789-00 licitação', theme: null, themeVersion: 0, agent: { name: 'Geral' } },
    ].filter(row => args.where.id.in.includes(row.id)); } },
  };
  return { controller: new SgdmNamesController(new SgdmNamesService(prisma)), queries };
}
const auth = key => ({ headers: { authorization: 'Bearer ' + key } });

test('without a configured key the route does not exist (404)', async () => {
  delete process.env.SGDM_INTEGRATION_KEY;
  await assert.rejects(build().controller.names(auth('x'), {}), NotFoundException);
});

test('wrong, missing or malformed bearer is 401', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller } = build();
  await assert.rejects(controller.names(auth('wrong'), {}), UnauthorizedException);
  await assert.rejects(controller.names({ headers: {} }, {}), UnauthorizedException);
  await assert.rejects(controller.names({ headers: { authorization: 'secret' } }, {}), UnauthorizedException);
});

test('more than 200 ids, non-uuid ids or a bad body is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller } = build();
  const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  await assert.rejects(controller.names(auth('secret'), { agentes: many }), BadRequestException);
  await assert.rejects(controller.names(auth('secret'), { conversas: many }), BadRequestException);
  await assert.rejects(controller.names(auth('secret'), { agentes: ['nao-uuid'] }), BadRequestException);
  await assert.rejects(controller.names(auth('secret'), { agentes: 'x' }), BadRequestException);
  await assert.rejects(controller.names(auth('secret'), null), BadRequestException);
  assert.deepEqual(await controller.names(auth('secret'), { agentes: many.slice(0, 200) }), { agentes: {}, conversas: {}, temas: {} });
});

test('known ids return names and titles; unknown ids are absent; no message text is selected', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller, queries } = build();
  const result = await controller.names(auth('secret'), { agentes: [A1, A2], conversas: [C1, C2, '33333333-3333-4333-8333-333333333333'] });
  assert.deepEqual(result, {
    agentes: { [A1]: 'Agente Jurídico' },
    conversas: { [C1]: 'Parecer', [C2]: null },
    temas: { [C1]: { id: 'juridico', rotulo: 'Pareceres e questões jurídicas' }, [C2]: { id: 'juridico', rotulo: 'Pareceres e questões jurídicas' } },
  });
  for (const [, args] of queries) assert.deepEqual(Object.keys(args.select).sort(), args.select.name ? ['id', 'name'] : ['agent', 'id', 'theme', 'themeVersion', 'title']);
});

test('titles are masked and a stale theme is classified on the fly without writing', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller, queries } = build();
  const result = await controller.names(auth('secret'), { conversas: [C3] });
  assert.equal(result.conversas[C3].includes('123.456.789-00'), false);
  assert.match(result.conversas[C3], /\[CPF\]/);
  assert.deepEqual(result.temas[C3], { id: 'licitacoes', rotulo: 'Licitações e contratos' });
  assert.deepEqual(queries.map(([kind]) => kind), ['conversation']);
});
