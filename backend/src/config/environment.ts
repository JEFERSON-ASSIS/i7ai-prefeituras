import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
// Node 24 loads local configuration before modules read process.env.
const envPath = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')].find(path => existsSync(path));
if (envPath) process.loadEnvFile(envPath);
if (process.env.NODE_ENV === 'production') {
  // Validate every configured signing secret, not only the first one found; reject public placeholders.
  const secrets = [process.env.SGDM_JWT_SECRET, process.env.JWT_SECRET].filter((value): value is string => value !== undefined && value !== '');
  if (!secrets.length || secrets.some(secret => secret.length < 32 || /^(change|local-development|troque|copie)/i.test(secret))) throw new Error('Configure um segredo JWT de produção com pelo menos 32 caracteres.');
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL || !process.env.S3_ENDPOINT) throw new Error('Configuração de banco, filas e armazenamento incompleta.');
}
