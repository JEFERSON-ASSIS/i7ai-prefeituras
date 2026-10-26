const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');

const projectRoot = path.resolve(__dirname, '../..');

function assertDevelopment(environment) {
  if (environment === 'production') throw new Error('A sessão temporária está disponível somente no desenvolvimento.');
}

function serializeContext(value) {
  const context = {
    accessToken: value.accessToken,
    tenantName: value.tenantName,
    organizationName: value.organizationName,
    modulePage: value.modulePage,
    navigationManagedByHost: value.navigationManagedByHost,
  };
  const json = JSON.stringify(context).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return 'window.__SGDM_CONTEXT__ = ' + json + ';\n';
}

async function createLocalSession() {
  assertDevelopment(process.env.NODE_ENV);
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Crie o .env da raiz antes de gerar a sessão local.');
  process.loadEnvFile(envPath);

  const secret = process.env.SGDM_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Configure SGDM_JWT_SECRET ou JWT_SECRET no .env.');

  const prisma = new PrismaClient();
  try {
    const email = process.env.LOCAL_PREVIEW_USER_EMAIL?.trim();
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE', tenant: { status: 'ACTIVE' }, ...(email ? { email } : {}) },
      select: { id: true, tenantId: true, name: true, email: true, tenant: { select: { name: true } } },
      take: 2,
    });
    if (users.length !== 1) {
      throw new Error('Defina LOCAL_PREVIEW_USER_EMAIL no .env para escolher um único usuário ativo.');
    }

    const user = users[0];
    const jwt = new JwtService({ secret });
    const accessToken = jwt.sign({ sub: user.id, tenantId: user.tenantId, email: user.email }, {
      algorithm: 'HS256',
      expiresIn: '8h',
      ...(process.env.SGDM_JWT_ISSUER ? { issuer: process.env.SGDM_JWT_ISSUER } : {}),
      ...(process.env.SGDM_JWT_AUDIENCE ? { audience: process.env.SGDM_JWT_AUDIENCE } : {}),
    });
    const outputDirectory = path.join(projectRoot, 'output', 'preview-server');
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'session.js'), serializeContext({
      accessToken,
      tenantName: user.tenant.name,
      organizationName: 'SGDM',
      modulePage: 'dashboard',
      navigationManagedByHost: true,
    }), 'utf8');
    console.log('Sessão local temporária criada para ' + user.name + '.');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { assertDevelopment, serializeContext };
if (require.main === module) createLocalSession().catch(error => { console.error(error.message); process.exitCode = 1; });
