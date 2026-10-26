import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const publish = read('.github/workflows/docker-publish.yml');
const deploy = read('.github/workflows/deploy-vps.yml');
const script = read('portainer/deploy-vps.sh');
const readme = read('portainer/README.md');

test('workflows têm estrutura mínima (name, on, jobs)', () => {
  for (const [nome, src] of [['publish', publish], ['deploy', deploy]]) {
    assert.match(src, /^name: .+/m, nome);
    assert.match(src, /^on:/m, nome);
    assert.match(src, /^jobs:/m, nome);
    assert.doesNotMatch(src, /\t/, `${nome}: YAML não aceita tabs`);
  }
});

test('docker-publish publica backend e frontend no GHCR', () => {
  assert.match(publish, /name: Docker Publish/);
  assert.match(publish, /branches: \[main\]/);
  assert.match(publish, /ghcr\.io\/jeferson-assis\/i7ai-backend/);
  assert.match(publish, /ghcr\.io\/jeferson-assis\/i7ai-frontend/);
  assert.match(publish, /build-backend:/);
  assert.match(publish, /build-frontend:/);
  assert.match(publish, /context: \.\/backend\s+file: backend\/Dockerfile/);
  assert.match(publish, /context: \.\s+file: Dockerfile/);
  assert.equal((publish.match(/provenance: false/g) || []).length, 2);
  for (const img of ['BACKEND_IMAGE', 'FRONTEND_IMAGE']) {
    for (const tag of ['latest', '${{ github.sha }}', 'main']) {
      assert.ok(publish.includes(`\${{ env.${img} }}:${tag}`), `${img}:${tag}`);
    }
  }
  assert.doesNotMatch(publish, /build-args/);
  assert.match(publish, /packages: write/);
});

test('deploy-vps dispara após Docker Publish e atualiza as duas imagens', () => {
  assert.match(deploy, /workflows: \['Docker Publish'\]/);
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /VPS_HOST/);
  assert.match(deploy, /VPS_USER/);
  assert.match(deploy, /VPS_SSH_KEY/);
  assert.match(deploy, /VPS_STACK_NAME \|\| 'i7ai-plataforma'/);
  assert.match(deploy, /ghcr\.io\/jeferson-assis\/i7ai-backend:main/);
  assert.match(deploy, /ghcr\.io\/jeferson-assis\/i7ai-frontend:main/);
  assert.match(deploy, /set -e/);
  assert.match(deploy, /--with-registry-auth/);
  assert.match(deploy, /--detach=false/);
  assert.match(deploy, /docker stack services/);
});

test('deploy atualiza o backend (migrations) antes do frontend', () => {
  const b = deploy.indexOf('atualizar "${STACK_NAME}_i7ai-backend"');
  const f = deploy.indexOf('atualizar "${STACK_NAME}_i7ai-frontend"');
  assert.ok(b > 0 && f > 0 && b < f);
});

test('nunca referencia a stack i7ai (site de marketing)', () => {
  for (const src of [deploy, script]) {
    assert.doesNotMatch(src, /i7ai_backend|i7ai_frontend/);
    assert.doesNotMatch(src, /['"]i7ai['"]/);
  }
});

test('portainer/deploy-vps.sh espelha o deploy', () => {
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /set -e/);
  assert.match(script, /VPS_STACK_NAME:-i7ai-plataforma/);
  assert.match(script, /--with-registry-auth/);
  const b = script.indexOf('${STACK_NAME}_i7ai-backend');
  const f = script.indexOf('${STACK_NAME}_i7ai-frontend');
  assert.ok(b > 0 && f > 0 && b < f);
});

test('README documenta secrets e pacotes públicos', () => {
  assert.match(readme, /Atualizações automáticas \(GitHub Actions\)/);
  for (const s of ['VPS_HOST', 'VPS_USER', 'VPS_SSH_KEY', 'VPS_PORT', 'VPS_STACK_NAME']) assert.ok(readme.includes(s), s);
  assert.match(readme, /públicos/);
  assert.match(readme, /docker login ghcr\.io/);
});

test('limpeza de imagens antigas: após o frontend, restrita às imagens do i7Ai, tolerante a falha', () => {
  const f = deploy.indexOf('atualizar "${STACK_NAME}_i7ai-frontend"');
  const c = deploy.indexOf('--- limpeza ---');
  assert.ok(c > f, 'limpeza depois da atualização do frontend');
  const limpeza = deploy.slice(c, deploy.indexOf('--- estado final ---'));
  assert.match(limpeza, /ghcr\.io\/jeferson-assis\/i7ai-backend/);
  assert.match(limpeza, /ghcr\.io\/jeferson-assis\/i7ai-frontend/);
  assert.match(limpeza, /docker rmi/);
  assert.match(limpeza, /docker ps/);
  assert.match(limpeza, /\|\| true/);
  assert.doesNotMatch(deploy, /image prune|system prune/);
  assert.doesNotMatch(limpeza, /sgdm|ghcr\.io\/jeferson-assis\/\*/);
});
