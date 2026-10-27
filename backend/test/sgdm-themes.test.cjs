const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const { SgdmThemesController } = require('../dist/sgdm/sgdm-themes.controller');
const { SgdmThemesService } = require('../dist/sgdm/sgdm-themes.service');

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '11111111-1111-4111-8111-222222222222';
const U1 = 'u1'; const U2 = 'u2';
const saved = process.env.SGDM_INTEGRATION_KEY;
test.afterEach(() => saved === undefined ? delete process.env.SGDM_INTEGRATION_KEY : process.env.SGDM_INTEGRATION_KEY = saved);

const row = (theme, userId, tenantId, createdAt, themeVersion = 1) => ({ theme, userId, tenantId, createdAt: new Date(createdAt), themeVersion });
const ROWS = [
  row('licitacoes', U1, T1, '2026-10-02T12:00:00Z'), row('licitacoes', U1, T1, '2026-10-03T12:00:00Z'), row('licitacoes', U2, T1, '2026-10-31T23:59:00Z'),
  row('saude', U1, T1, '2026-10-05T12:00:00Z'), row('saude', U1, T1, '2026-11-01T00:00:00Z'),
  row(null, U1, T1, '2026-10-06T12:00:00Z', 0),
];

// Fake database: interprets the Prisma.Sql values (from, to, optional tenant) over in-memory rows.
function build(rows = ROWS) {
  const prisma = {
    $queryRaw: async query => {
      const [from, to] = query.values;
      const tenant = query.values.find(value => typeof value === 'string');
      const inScope = rows.filter(r => r.createdAt >= from && r.createdAt < to && (!tenant || r.tenantId === tenant));
      if (/GROUP BY/.test(query.sql)) {
        const groups = new Map();
        for (const r of inScope.filter(r => r.themeVersion >= 1 && r.theme)) {
          const g = groups.get(r.theme) ?? { theme: r.theme, n: 0, u: new Set(), t: new Set() };
          g.n++; g.u.add(r.userId); g.t.add(r.tenantId); groups.set(r.theme, g);
        }
        return [...groups.values()].map(g => ({ theme: g.theme, conversas: BigInt(g.n), usuarios: BigInt(g.u.size), prefeituras: BigInt(g.t.size) }));
      }
      return [{ total: BigInt(inScope.filter(r => r.themeVersion < 1 || !r.theme).length) }];
    },
  };
  return new SgdmThemesController(new SgdmThemesService(prisma));
}
const auth = key => ({ headers: { authorization: 'Bearer ' + key } });
const q = (extra = {}) => ({ inicio: '2026-10-01', fim: '2026-10-31', ...extra });

test('without a configured key the route does not exist (404); wrong key is 401', async () => {
  delete process.env.SGDM_INTEGRATION_KEY;
  await assert.rejects(build().themes(auth('x'), q()), NotFoundException);
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().themes(auth('wrong'), q()), UnauthorizedException);
  await assert.rejects(build().themes({ headers: {} }, q()), UnauthorizedException);
});

test('invalid period or tenantId is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const c = build();
  await assert.rejects(c.themes(auth('secret'), { inicio: '2025-01-01', fim: '2026-01-02' }), BadRequestException); // 367 days
  await c.themes(auth('secret'), { inicio: '2025-01-01', fim: '2025-12-31' }); // 365 days ok
  await assert.rejects(c.themes(auth('secret'), { inicio: '2026-10-31', fim: '2026-10-01' }), BadRequestException);
  await assert.rejects(c.themes(auth('secret'), { inicio: '2026-02-30', fim: '2026-03-01' }), BadRequestException);
  await assert.rejects(c.themes(auth('secret'), {}), BadRequestException);
  await assert.rejects(c.themes(auth('secret'), q({ tenantId: 'nope' })), BadRequestException);
});

test('counts conversations, users and prefeituras per theme inside the inclusive period', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const result = await build().themes(auth('secret'), q());
  assert.deepEqual(result.periodo, { inicio: '2026-10-01', fim: '2026-10-31' });
  assert.deepEqual(result.temas, [
    { tema: 'licitacoes', rotulo: 'Licitações e contratos', conversas: 3, usuarios: 2, prefeituras: 1 },
    { tema: 'saude', rotulo: 'Saúde', conversas: 1, usuarios: 1, prefeituras: 1 },
  ]);
  assert.equal(result.semTema, 1);
  const text = JSON.stringify(result);
  for (const word of ['title', 'content', 'messages']) assert.equal(text.includes(word), false);
});

test('tenantId of another prefeitura yields no themes', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const result = await build().themes(auth('secret'), q({ tenantId: T2 }));
  assert.deepEqual(result.temas, []);
  assert.equal(result.semTema, 0);
});
