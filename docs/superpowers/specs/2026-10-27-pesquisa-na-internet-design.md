# Pesquisa na internet e em compras públicas — desenho

Data: 2026-10-27. Repositórios: i7Ai (`C:/xampp/htdocs/producao/i7ai-IA`) e SGDM (worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`). Complementa o desenho da Central de IA (`2026-10-26-central-de-ia-design.md`).

## Intenção

Qualquer servidor da prefeitura (licitação, controladoria, financeiro/contabilidade, gabinete, atendimento) pede uma pesquisa no chat, em português, como pediria a um colega — "consulta quanto outras prefeituras pagaram em merenda escolar", "qual o IPCA do mês", "tem decisão do TCE sobre aditivo de obra" — e a IA vai às fontes públicas e à internet e devolve a resposta pronta, com os links para conferir.

O usuário é leigo. Ele não cria ferramenta, não vê API, URL, domínio, chave, cron nem "etapas". Não existe configuração por assunto: o mesmo recurso serve para qualquer pedido. É o modelo do Microsoft Copilot, do ChatGPT Enterprise e da Tess AI: o administrador liga, o usuário só pede.

## Objetivos

1. **Pesquisa na internet embutida** em todos os agentes, sem vincular nada a agente nenhum.
2. **Compras públicas (PNCP) embutidas**: a IA consulta editais, atas e contratos de todo o país e os preços por item, e monta a resposta (para preço, uma tabela com órgão, município/UF, item, unidade, preço unitário, data e link; com média, mediana e menor quando houver 3+ preços).
3. **Interruptor na Central de IA (só o dono, `IA_CENTRAL`)**: "Pesquisa na internet" ligada/desligada por prefeitura, com um padrão para todas — mesmo padrão de alvo "todos / prefeitura" da aba Otimização. Desligada, a IA responde sem pesquisar e, se o usuário pedir, explica que a prefeitura não tem a pesquisa liberada.
4. **Fontes sempre visíveis**: toda resposta que usou pesquisa traz os links usados.
5. **Custo visível**: cada pesquisa é registrada e aparece na Central (Consumo e custo / Visão geral) por prefeitura, separada do custo do modelo.
6. Funciona igual no chat e nas automações (uma automação "Executar agente" com a instrução "pesquise…" também pesquisa).

## Não objetivos

- Navegar em sites como um robô (clicar, fazer login, resolver CAPTCHA, ler páginas montadas por JavaScript). A pesquisa usa resultados de busca e APIs públicas.
- Preço exato em tempo real de passagens, hotéis etc. (sites bloqueiam robôs). A resposta traz preços de referência e diz isso.
- Montar o documento formal de "pesquisa de preços" do processo (Lei 14.133 art. 23 / IN 65/2021) com assinatura e modelo oficial — fica para depois; agora a IA entrega a tabela e as fontes.
- Outras fontes dedicadas (TCE-MT, Tesouro/FPM, Diário Oficial AMM, BCB/IPCA) — o desenho deixa o encaixe pronto, mas a primeira entrega tem só PNCP + busca geral. O IPCA e afins chegam pela busca geral.
- Catálogo de "monitoramentos prontos" e criação de automação pelo chat — próximo passo, fora desta entrega.

## Anti-objetivos (falha mesmo que "funcione")

- O usuário precisar configurar algo, escolher ferramenta ou ver termos técnicos.
- Resposta com preço, número ou norma **sem fonte**, ou preço inventado. Se não encontrou, diz que não encontrou.
- Pesquisa vazar dados da prefeitura: a consulta enviada ao buscador não pode levar nome de servidor, CPF ou conteúdo de documento anexado sem necessidade (aplicar a máscara de dados pessoais já existente em `backend/src/sgdm/personal-data.ts` ao termo enviado ao Serper).
- Custo descontrolado: uma pergunta disparar dezenas de pesquisas.
- Quebrar o que já existe: ferramentas cadastradas por agente, MCP, automações, cache exato (pedidos com ferramentas nunca entram no cache exato — regra já vigente).

## Restrições

- Mesma pilha e padrões da Central de IA: i7Ai NestJS + Prisma + React/Vite com `@sgdm/design`; SGDM NestJS + Next.js; integração SGDM↔i7Ai pelas rotas `/integracoes/*` com a chave de integração, cache curto e "nunca bloqueia o chat" se o SGDM cair.
- O modelo chama ferramentas por *function calling* pelo LiteLLM (o mecanismo de `agent-tools.service.ts` / `omnirouter.service.ts`). Agente cujo modelo não suporta ferramentas (`supportsTools` falso) simplesmente não pesquisa.
- Nenhum texto visível diz "i7Ai" (regra da marca: "IA do SGDM").
- Chaves: a do Serper é da plataforma, cadastrada pelo dono na Central (junto das chaves da plataforma) e guardada cifrada como as demais; nunca exibida, nunca em log. O PNCP é público e não usa chave.
- Rede: chamadas de saída só para `google.serper.dev` e `pncp.gov.br`, com a mesma política de rede segura das ferramentas (`network-policy.ts`), tempo limite e tamanho máximo de resposta.
- Máquina de desenvolvimento de 16 GB: testes focados.
- Sem deploy até o dono liberar.

## Decisões tomadas

1. **Busca geral = Serper.dev** (resultados do Google em JSON). Escolha do dono por recomendação: funciona com qualquer modelo, custa ~US$ 1 por mil pesquisas (confirmar preço no plano), troca de provedor sem mexer em agentes. Não usar a pesquisa embutida da OpenAI/Gemini.
2. **Compras = API pública do PNCP**:
   - busca por palavra: `GET https://pncp.gov.br/api/search/?q=<termo>&tipos_documento=edital|ata|contrato&pagina=1&tam_pagina=N` (testado: devolve órgão, município, UF, modalidade, `orgao_cnpj`, `ano`, `numero_sequencial`, `item_url`);
   - itens e preços de uma compra: `GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/itens` (testado: `descricao`, `unidadeMedida`, `quantidade`, `valorUnitarioEstimado`); preço homologado em `.../itens/{numeroItem}/resultados`.
   - link público para o usuário: `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}` (e equivalente para atas/contratos).
3. **Ferramentas embutidas, não cadastradas**: "pesquisa na internet" e "compras públicas (PNCP)" são funções do sistema oferecidas ao modelo em todo agente quando a prefeitura tem a pesquisa ligada — não aparecem na tela Ferramentas e não ocupam o limite de 64 funções do agente de forma visível ao usuário.
4. **Interruptor** vive na Central (SGDM), como um item novo da configuração por alvo ("todos" / prefeitura), lido pelo i7Ai pela mesma rota e cache das otimizações. Padrão: **desligado** (o dono liga).
5. **Resposta**: as instruções de sistema ganham um bloco curto (só quando a pesquisa está ligada) dizendo quando pesquisar, que toda informação externa vem com link, nunca inventar preço, e o formato de tabela para preços.

## Decisões do construtor (marcadas como escolha minha, revisáveis pelo dono)

6. **Chave do Serper**: o SGDM guarda cifrada (mesmo utilitário das chaves das prefeituras, `crypto-secret.util`) numa configuração da plataforma; a tela só mostra o final mascarado e tem "Testar"; o i7Ai lê a chave por uma rota `/integracoes/i7ai/*` com a chave de integração (como lê a chave da prefeitura), guarda em memória por pouco tempo e nunca registra. Não passa pelo LiteLLM (ele não devolve a chave em texto).
7. **Preço**: a ferramenta de compras devolve, por item, o **preço estimado** e, quando a compra já teve resultado, o **preço contratado (homologado)**; a tabela mostra os dois e calcula média/mediana/menor sobre o contratado quando houver 3+, senão sobre o estimado, dizendo qual usou. A ferramenta faz a busca e o detalhamento **numa única chamada** (busca por palavra → até 5 compras → itens e resultados que casam com o termo), então conta como **uma** pesquisa.
8. **Orçamento de chamadas**: até 5 chamadas de pesquisa por resposta (busca geral e compras somadas), dentro do teto atual de 8 rodadas do OmniRouter. Pesquisas contam no limite por minuto **do usuário** que já existe; o teto da prefeitura continua sendo o orçamento mensal.
9. **Cache exato**: com a pesquisa ligada, os pedidos levam ferramentas e por isso deixam de usar o cache exato (regra vigente). Aceito: uma automação diária que pesquisa precisa de dado novo, não de resposta guardada. A Central avisa isso ao lado do interruptor.
10. **Fontes garantidas pelo servidor**: além da instrução, o i7Ai guarda os links que cada pesquisa devolveu e, se a resposta final não citar nenhum, acrescenta ao fim uma seção "Fontes" com eles (no chat com streaming, como último trecho; sem streaming, no texto). Não verifica preço por preço.
11. **Só pelo caminho do LiteLLM (OmniRouter)**, que é o de produção. Nos outros caminhos (gateway externo, OpenAI direto) a pesquisa fica desligada. Modelo sem suporte a ferramentas: as ferramentas embutidas não são enviadas e, se o usuário pedir pesquisa, a IA diz que o modelo deste agente não pesquisa e sugere outro.

## Limites de uso (decididos para não estourar custo)

- Até **5 pesquisas por resposta** (busca geral + compras somadas; cada busca de compras já inclui o detalhamento); ao atingir, a IA responde com o que tem.
- Compras: até 10 resultados por busca, dos quais até 5 compras detalhadas dentro da mesma chamada.
- Resposta de cada ferramenta cortada a um tamanho fixo antes de ir ao modelo (para não encher o contexto).
- Pesquisas contam no limite de chamadas por minuto do usuário já existente.

## Custo

- Cada pesquisa no Serper é registrada (prefeitura, usuário, agente, conversa, data) com o custo unitário configurado pelo dono na Central (padrão: US$ 0,001). PNCP custa zero, mas também é contado.
- A Central mostra "Pesquisas: N, US$ X" no período, por prefeitura, em Consumo e custo e na Visão geral. O custo dos tokens que o resultado ocupa já aparece no custo do modelo.

## O que o dono e o usuário fazem

- **Dono**: cria a conta no Serper, cadastra a chave em Central de IA › Modelos e acesso › Chaves da plataforma (provedor "Pesquisa na internet"), liga a pesquisa para todas ou por prefeitura.
- **Usuário**: pede no chat. Nada mais.

## Critérios de pronto

- No chat, com a pesquisa ligada para a Vera, "consulta quanto outras prefeituras pagaram em arroz para merenda escolar" devolve uma tabela com pelo menos 3 compras do PNCP, preços unitários, links que abrem no PNCP, média/mediana/menor.
- "Qual foi o IPCA de setembro" devolve o número com link de fonte (IBGE/BCB) vindo da busca.
- Com a pesquisa desligada, a mesma pergunta não pesquisa e a IA avisa que a pesquisa não está liberada para a prefeitura.
- A Central mostra as pesquisas e o custo do dia para a Vera.
- Nenhuma chave aparece em resposta, log ou auditoria; o termo enviado ao Serper sai mascarado.

## Deixado para quem constrói

- Nomes e descrições exatos das funções oferecidas ao modelo, o esquema dos argumentos e o texto do bloco de instruções.
- Onde guardar o registro de pesquisas no i7Ai (tabela nova ou extensão de `ai_usage`) e como a Central lê o total.
- Como cortar e resumir as respostas do PNCP para caber no contexto.
- Tratamento de erros (PNCP fora do ar, Serper sem saldo): a IA diz que a fonte não respondeu e segue com o que tem.
