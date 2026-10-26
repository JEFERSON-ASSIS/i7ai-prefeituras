# LiteLLM como gateway de IA

O LiteLLM Proxy substitui o OmniRoute. Ele recebe as chamadas do backend no contrato OpenAI `/v1/chat/completions` e as repassa para OpenAI, Anthropic (Claude) e, se configurado, Gemini, usando chaves de API comerciais da própria operação.

O backend continua usando as variáveis `OMNIROUTER_*`; só o endereço muda.

```
Navegador → frontend → backend ──(rede Docker "ai", HTTP interno)──→ litellm ──HTTPS──→ OpenAI / Anthropic
                                                                        │
                                                         banco "litellm" (chaves criptografadas)
```

**Mudança em produção:** `docker-compose.production.yml` agora exige `LITELLM_IMAGE`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` e `LITELLM_DATABASE_URL`, e o backend só inicia com o LiteLLM saudável.

## Chaves dos provedores (tela do SUPER_ADMIN)

As chaves da OpenAI, da Anthropic e do Gemini são cadastradas em **Modelos › Chaves dos provedores de IA**, visível só para `SUPER_ADMIN`.

- A chave é enviada uma vez ao LiteLLM, que a guarda criptografada no banco `litellm` com `LITELLM_SALT_KEY`. O i7Ai não grava a chave no próprio banco, em logs ou na auditoria. A auditoria registra só quem salvou ou removeu e o provedor.
- Depois de salva, a tela mostra só o início e o fim mascarados (`sk****88`).
- **Testar** envia uma pergunta de poucos tokens por um modelo daquele provedor publicado no gateway e mostra a resposta ou o erro do provedor.
- Salvar, trocar e remover valem na hora, sem reiniciar. Com `STORE_MODEL_IN_DB=True`, as chaves continuam valendo depois de reiniciar o contêiner.
- **Nunca altere `LITELLM_SALT_KEY`** depois de salvar chaves; elas deixariam de ser lidas.

A API usada é `/credentials` do LiteLLM, marcada como BETA na versão testada (1.106.4). Ao atualizar a imagem, rode `node --test test/provider-credentials.test.cjs` no backend e teste a tela antes de publicar.

A permissão é verificada pelo perfil `SUPER_ADMIN` calculado na autenticação. Se os perfis passarem a vir do token do SGDM, a tela segue essa regra sem mudanças.

`OPENAI_API_KEY` no ambiente do backend continua servindo só para os embeddings, quando `EMBEDDING_API_KEY` estiver vazia.

## Precisa de URL pública ou Cloudflare?

Não, quando o LiteLLM roda na mesma VPS e no mesmo `docker-compose.production.yml`. O backend o acessa por `http://litellm:4000/v1`, e o serviço não publica nenhuma porta. HTTP nessa rede é aceito só para nomes listados em `OMNIROUTER_INTERNAL_HOSTS` (nomes de serviço Docker, sem ponto). Qualquer outro endereço continua exigindo HTTPS.

Um subdomínio no Cloudflare só é necessário se o LiteLLM ficar em outro servidor. Nesse caso, use HTTPS, `OMNIROUTER_BASE_URL=https://ia.seudominio.com.br/v1` e deixe `OMNIROUTER_INTERNAL_HOSTS` vazio.

## Modelos

Os modelos ficam em [deploy/litellm/config.yaml](../deploy/litellm/config.yaml). Cada `model_name` deve ser igual ao slug cadastrado em **Modelos** no i7Ai e usar um prefixo liberado (`openai/`, `anthropic/`, `gemini/`, `xai/`). Cada modelo aponta para a credencial do provedor (`litellm_credential_name: openai`, `anthropic` ou `gemini`).

Rotas do OmniRoute como `antigravity/...` e `cx/...` não existem no LiteLLM. Troque o modelo dos agentes que as usam.

| Slug | Uso |
| --- | --- |
| `openai/gpt-4o-mini` | Padrão barato: conversa, resumos, planilhas, visão |
| `anthropic/claude-haiku-5-5` | Claude rápido e barato |
| `anthropic/claude-sonnet-5-5` | Documentos longos e análise (licitações, ETP, TR) |

Não há fallback automático entre modelos. O i7Ai registra custo e provedor pelo modelo escolhido, e um fallback mandaria dados para outro provedor com o preço errado.

Depois de alterar o arquivo, reinicie: `docker compose -f docker-compose.production.yml restart litellm`.

## Local (Windows)

Esta máquina usa `docker-compose.local.yml` (Postgres 5435, Redis 6381, MinIO 9004, LiteLLM 4000).

1. No `.env` da raiz: `OMNIROUTER_BASE_URL="http://localhost:4000/v1"` e `OMNIROUTER_API_KEY` igual a `LITELLM_MASTER_KEY`.
2. `docker compose -p i7ai-prefeituras-local -f docker-compose.local.yml up -d`
3. Inicie a API e o frontend e abra `http://127.0.0.1:5173/preview/local.html` (depois de `npm run local:session`).
4. Em **Modelos**, cadastre a chave da OpenAI e clique em **Testar**.

## VPS (produção)

1. Copie o projeto atualizado para a VPS.
2. No `.env` de produção (modelo em [deploy/.env.production.example](../deploy/.env.production.example)):
   - `LITELLM_IMAGE`: o exemplo traz o digest da versão testada. Para atualizar, escolha uma versão em https://github.com/BerriAI/litellm/releases e fixe-a; não use `latest`.
   - `LITELLM_MASTER_KEY`: gere com `echo sk-$(openssl rand -hex 32)`.
   - `LITELLM_SALT_KEY`: gere da mesma forma e guarde uma cópia segura.
   - `LITELLM_DATABASE_URL=postgresql://USUARIO:SENHA@postgres:5432/litellm`, com o mesmo usuário e senha do Postgres. O banco `litellm` é criado automaticamente.
   - `OMNIROUTER_API_KEY` com o mesmo valor de `LITELLM_MASTER_KEY`.
   - `OMNIROUTER_BASE_URL=http://litellm:4000/v1` e `OMNIROUTER_INTERNAL_HOSTS=litellm`.
3. Suba: `docker compose -f docker-compose.production.yml --env-file .env up -d --build`.
4. Cadastre os modelos no catálogo do i7Ai com o script existente, que consulta `/v1/models` do gateway (inclui a janela de contexto):
   ```sh
   docker compose -f docker-compose.production.yml exec backend node scripts/configure-omniroute.cjs --models=anthropic/claude-sonnet-5-5,openai/gpt-4o-mini,anthropic/claude-haiku-5-5
   # Confira a saída e repita com --apply.
   ```
   Depois ajuste em **Modelos** visão, ferramentas e preços (USD por milhão de tokens). Sem preço, o custo aparece como não configurado.
5. Entre como `SUPER_ADMIN`, cadastre as chaves em **Modelos** e use **Testar**.
6. Faça uma conversa real com cada modelo, com e sem streaming, e um envio de imagem com GPT-4o Mini.

## Próximas etapas de redução de custo

1. Ler tokens em cache no consumo e cadastrar preço de entrada em cache.
2. Dividir o prompt de sistema em parte fixa e trechos dos documentos, com `cache_control` para o Claude.
3. Resumir o histórico antigo com um modelo barato.
4. Imagens com `detail: 'low'` quando não for preciso ler detalhes.
5. Chaves virtuais do LiteLLM por prefeitura, com teto de gasto.
