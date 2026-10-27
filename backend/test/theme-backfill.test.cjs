const test = require('node:test'); const assert = require('node:assert/strict'); require('reflect-metadata');
const { ThemeBackfillService, themeBackfillInterval } = require('../dist/sgdm/theme-backfill.service');
const { THEME_VERSION } = require('../dist/sgdm/themes');

function memoryPrisma(count) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: String(index).padStart(6, '0'), title: index % 2 ? 'Edital do pregão SECRETO-' + index : 'Ofício ao gabinete SECRETO-' + index, theme: null, themeVersion: 0, agent: { name: 'Assistente' } }));
  const calls = { findMany: [], updateMany: [] };
  const prisma = { conversation: {
    findMany: async args => {
      calls.findMany.push(args);
      assert.deepEqual(Object.keys(args.select).sort(), ['agent', 'id', 'title']);
      return rows.filter(row => row.themeVersion < args.where.themeVersion.lt).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take).map(({ id, title, agent }) => ({ id, title, agent }));
    },
    updateMany: async args => {
      calls.updateMany.push(args);
      let changed = 0;
      for (const row of rows) if (args.where.id.in.includes(row.id) && row.themeVersion < args.where.themeVersion.lt) { Object.assign(row, args.data); changed++; }
      return { count: changed };
    },
  } };
  return { prisma, rows, calls };
}

function capture(service) {
  const lines = [];
  service.logger = { log: message => lines.push(String(message)), error: message => lines.push(String(message)) };
  return lines;
}

test('one round classifies 1,200 conversations in batches of 500, one updateMany per theme and batch', async () => {
  const { prisma, rows, calls } = memoryPrisma(1200);
  const service = new ThemeBackfillService(prisma); const lines = capture(service);
  assert.deepEqual(await service.run(), { updated: 1200, batches: 3 });
  assert.ok(rows.every(row => row.themeVersion === THEME_VERSION && row.theme));
  assert.equal(rows[1].theme, 'licitacoes'); assert.equal(rows[0].theme, 'documentos');
  assert.ok(calls.findMany.every(args => args.take === 500));
  assert.ok(calls.findMany.every(args => args.where.themeVersion.lt === THEME_VERSION && args.orderBy.createdAt === 'desc'));
  assert.equal(calls.updateMany.length, 6);
  assert.equal(lines.length, 1);
  assert.ok(lines.every(line => !/SECRETO|Edital|Ofício/.test(line)));
  // Idempotent: nothing left to do.
  assert.deepEqual(await service.run(), { updated: 0, batches: 0 });
});

test('10,001 conversations: first round does 10,000, the second the rest', async () => {
  const { prisma, rows } = memoryPrisma(10001);
  const service = new ThemeBackfillService(prisma); const lines = capture(service);
  assert.deepEqual(await service.run(), { updated: 10000, batches: 20 });
  assert.equal(rows.filter(row => row.themeVersion === 0).length, 1);
  assert.deepEqual(await service.run(), { updated: 1, batches: 1 });
  assert.ok(rows.every(row => row.themeVersion === THEME_VERSION));
  assert.ok(lines.every(line => !/SECRETO|Edital|Ofício|pregão/.test(line)));
});

test('interval: default 10 minutes, 0 turns it off', () => {
  assert.equal(themeBackfillInterval(undefined), 600000);
  assert.equal(themeBackfillInterval('0'), 0);
  assert.equal(themeBackfillInterval('120000'), 120000);
  assert.equal(themeBackfillInterval('abc'), 600000);
});
