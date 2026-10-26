# Execução local no Windows

Análise e preparação em 6 de outubro de 2026, a partir do commit `9912c6a`.

Pasta: `C:\xampp\htdocs\producao\i7ai-prefeituras`.

## Estrutura e requisitos

Este projeto usa frontend React/Vite e API NestJS. O banco é PostgreSQL com pgvector; Redis executa as filas e MinIO guarda os arquivos. Apache, PHP e MySQL do XAMPP não executam esses serviços.

Foram encontrados Git 2.52.0, Node.js 24.12.0, npm 11.6.2, Docker 29.2.1 e Compose 5.0.2. Docker estava ativo. A porta 5432 já estava ocupada; por isso, esta instalação usa infraestrutura própria com portas diferentes.

| Serviço | Endereço local |
| --- | --- |
| Frontend | http://127.0.0.1:5173 |
| Plataforma real local | http://127.0.0.1:5173/preview/local.html |
| Prévia com dados fictícios | http://127.0.0.1:5173/preview/sgdm.html |
| API | http://localhost:3000/api |
| Saúde da API | http://localhost:3000/api/health |
| PostgreSQL | 127.0.0.1:5435 |
| Redis | 127.0.0.1:6381 |
| MinIO S3 | http://127.0.0.1:9004 |
| Console MinIO | http://127.0.0.1:9005 |

`docker-compose.local.yml` contém containers e volumes próprios deste projeto. O `.env` local aponta para essas portas e possui um segredo JWT gerado nesta instalação. Preserve esse arquivo. As credenciais de infraestrutura são as de desenvolvimento do exemplo original. O bucket privado `i7ai-documents` foi criado.

## Iniciar novamente

No PowerShell, inicie a infraestrutura:

```powershell
Set-Location 'C:\xampp\htdocs\producao\i7ai-prefeituras'
docker compose -p i7ai-prefeituras-local -f docker-compose.local.yml up -d
```

Em um terminal, inicie a API:

```powershell
Set-Location 'C:\xampp\htdocs\producao\i7ai-prefeituras\backend'
npm.cmd run dev
```

Em outro terminal, inicie o frontend:

```powershell
Set-Location 'C:\xampp\htdocs\producao\i7ai-prefeituras'
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Use esses comandos quando as portas 3000 e 5173 estiverem livres. A prévia visual usa dados fictícios e desabilita alterações e chamadas de IA.

Para entrar na plataforma real local, gere uma sessão temporária do usuário ativo:

```powershell
Set-Location 'C:\xampp\htdocs\producao\i7ai-prefeituras'
npm.cmd run local:session
```

Depois abra `http://127.0.0.1:5173/preview/local.html`. Essa tela usa a API, o banco e os provedores reais configurados no `.env`. A sessão expira em oito horas; repita o comando para renovar. O arquivo com o JWT fica somente em `output/preview-server/`, ignorado pelo Git, e o gerador recusa execução em produção. Se houver mais de um usuário ativo, configure `LOCAL_PREVIEW_USER_EMAIL` no `.env` para selecionar a identidade local.

Para parar somente os containers desta instalação, preservando os volumes:

```powershell
docker compose -p i7ai-prefeituras-local -f docker-compose.local.yml stop
```

## O que depende de configuração adicional

1. **Acesso aos dados reais:** o projeto não possui login próprio. O SGDM deve fornecer um JWT HS256 com `sub` e `tenantId` correspondentes aos IDs de usuário e prefeitura deste banco. A assinatura deve coincidir com `SGDM_JWT_SECRET` ou `JWT_SECRET`. O contexto é recebido em `window.__SGDM_CONTEXT__`. A integração real com o host e a renovação da sessão ainda precisam ser preparadas. Não utilize a senha citada no SQL antigo como se fosse um login atual.
2. **Chat com IA:** configure `OMNIROUTER_BASE_URL` e `OMNIROUTER_API_KEY` somente no backend, ou um dos adaptadores alternativos descritos no README. Confirme e cadastre os modelos habilitados na sua conta e crie/ative os agentes. O seed demonstrativo cria prefeitura, administrador, permissões, departamentos, licença e um modelo básico; não reproduz o banco nem os agentes da máquina da autora.
3. **Pesquisa semântica:** exige configuração de embeddings; sem isso, a busca nas bases usa termos literais. Ter uma chave OmniRouter não configura embeddings automaticamente.
4. **Integrações externas:** ferramentas, MCP, webhooks e n8n precisam de endpoints e segredos específicos. Documentos e históricos da instalação original não acompanham o Git.

Os relatórios existentes no repositório descrevem verificações em outro ambiente. A presença desses relatórios não comprova chamadas reais de IA nesta máquina. Nenhuma chamada paga foi necessária para preparar a instalação.

## Instalação e atualização de dependências

Os pacotes usam lockfiles próprios para frontend e backend. Para reinstalar quando necessário:

```powershell
Set-Location 'C:\xampp\htdocs\producao\i7ai-prefeituras'
npm.cmd ci --include=optional
Set-Location backend
npm.cmd ci --include=optional
npm.cmd run prisma:generate
$databaseLine = Get-Content '..\.env' -Encoding UTF8 | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$env:DATABASE_URL = $databaseLine.Substring('DATABASE_URL='.Length).Trim('"')
npm.cmd run prisma:deploy
npm.cmd run prisma:seed
```

O backend carrega o `.env` da raiz ao iniciar, mas a CLI do Prisma precisa receber `DATABASE_URL` no processo conforme o exemplo. As migrations exigem PostgreSQL com a extensão pgvector. O cliente Prisma e as migrations são etapas distintas: gerar o cliente não cria tabelas. O seed é apenas para desenvolvimento.
