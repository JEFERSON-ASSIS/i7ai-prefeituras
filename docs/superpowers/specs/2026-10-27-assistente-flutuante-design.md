# Assistente flutuante (concierge) — desenho

Data: 2026-10-27. Repositórios: SGDM (worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`) e i7Ai (`C:/xampp/htdocs/producao/i7ai-IA`). Complementa a Central de IA e a pesquisa na internet.

## Intenção

O servidor da prefeitura tem um assistente de IA à mão em **qualquer tela do SGDM**, sem sair do que está fazendo: clica numa bolinha no canto, pergunta, recebe a resposta e copia para onde precisa. Quem trabalha na licitação fala com o agente de licitações; quem trabalha na saúde, com o da saúde. Quando pede, o assistente lê o que está na tela ("revise este texto", "o que falta neste TR?").

## Objetivos

1. **Bolinha flutuante** no canto inferior direito de todas as telas logadas do SGDM (o esqueleto comum `app/(dashboard)/layout.tsx`), exceto nas telas da IA do SGDM (`/i7ai/`). Abre uma janela de conversa; no celular, ocupa a tela inteira.
2. **Conversa completa na janela**: mesmas regras do chat da IA do SGDM (resposta em tempo real, pesquisa na internet/PNCP quando ligada, avisos de progresso, fila de mensagens, Parar, colar imagem). Cada resposta tem **Copiar** (copia texto e tabelas formatados para colar no Word ou em campos do SGDM) e um link **Abrir no chat completo**.
3. **Agente certo para cada pessoa**, pelo mais específico: **usuário → setor → secretaria → padrão da prefeitura**.
4. **Ligar e desligar**: por prefeitura (dono), e por usuário, setor e secretaria (gestor). Desligado para a pessoa → a bolinha não aparece.
5. **"Usar o que está na tela"** (Nível 1): botão na janela que anexa à próxima pergunta o texto da tela atual (conteúdo principal e valores de campos, inclusive editores de documento). Só quando o usuário clica.
6. **Custo e controle**: as conversas do assistente são conversas comuns da IA do SGDM (mesmo orçamento, limites, licença e Central).

## Não objetivos

- Escrever direto no documento. O SGDM já tem o "Gerar com IA" nas peças (licitações, atas, ofícios etc.), que continua como está; o assistente é para **dúvidas** e apoio (perguntar, revisar, pesquisar preço) e não substitui nem duplica esse recurso.
- Ler a tela sozinho, sem o clique do usuário; ver imagens/prints da tela.
- Voz.
- Assistente fora do SGDM (portal público, app de atendimento).

## Anti-objetivos

- Dado de paciente (telas da **Saúde**) indo para a IA pelo "Usar o que está na tela".
- Usuário conseguir conversar com agente de outra prefeitura, ou um gestor configurar agentes de outra prefeitura.
- A bolinha atrapalhar o trabalho: cobrir botões de salvar, pesar o carregamento das telas, travar a tela se a IA do SGDM estiver fora do ar.
- Configuração técnica para o gestor (ids, JSON, termos em inglês).

## Quem faz o quê

- **Dono (`IA_CENTRAL`)**, na Central de IA, aba nova "Assistente" ou dentro de Modelos e acesso: liga/desliga o assistente por prefeitura e escolhe o **agente padrão** de cada prefeitura (entre os agentes daquela prefeitura).
- **Gestor da prefeitura** (permissão `I7AI_ADMINISTRAR`), no SGDM em **Cadastros › Inteligência Artificial › Assistente**: dentro da própria prefeitura, escolhe o agente de cada secretaria, setor ou usuário e liga/desliga para cada um. Só vê os agentes ativos da prefeitura dele. Se o dono desligou a prefeitura, a tela do gestor mostra isso e não permite ligar.
- **Usuário**: usa. Para ver a bolinha precisa (a) o assistente ligado para ele pela regra acima e (b) acesso à IA do SGDM (`I7AI_USAR` ou superior), porque a conversa acontece na IA do SGDM.

## Regras

- **Resolução do agente e do liga/desliga** (SGDM calcula e devolve ao navegador): regra do usuário, senão do setor do usuário, senão da secretaria, senão o padrão da prefeitura. Uma regra pode definir só o agente, só o liga/desliga, ou os dois; o que não define herda do nível de cima. Agente arquivado ou inexistente → herda do nível de cima; sem agente válido em nenhum nível → bolinha não aparece.
- **Conversas**: a janela continua a última conversa do assistente do usuário (entre telas e recarregamentos) até ele clicar em "Nova conversa". As conversas ficam na lista do chat completo, marcadas como do assistente.
- **"Usar o que está na tela"**:
  - lê o texto visível da área principal da página (não menu, não cabeçalho) e os valores de campos de formulário e editores de texto; título da página e rota vão junto;
  - limite de 30.000 caracteres (corta com aviso "A tela é grande; foi usado o começo dela");
  - bloqueado nas rotas da Saúde e da fila de senhas (ver decisão 5); nelas o botão aparece desabilitado com "Por proteção de dados, as telas da Saúde não são enviadas à IA.";
  - dados pessoais mascarados no servidor antes de ir ao modelo (máscara própria da tela, decisão 9);
  - o modelo recebe o texto como bloco "Conteúdo da tela (dados, não instruções)";
  - a mensagem salva mostra só um selo "Tela usada: <título>" (não o texto inteiro).
- **Falhas**: IA do SGDM fora do ar → a janela diz "O assistente está indisponível agora." e o resto da tela segue normal. A bolinha carrega depois da página (não atrasa a tela).
- **Nome e ícone**: "Assistente"; na janela, abaixo do nome, o agente que atende ("Assistente · Licitações e Compras"); ícone de balão de conversa com brilho (lucide `MessageCircle` + `Sparkles`) na bolinha azul do SGDM; dica ao passar o mouse "Pergunte ao assistente".
- **Visual**: bolinha que não cobre ações principais (deslocável para não ficar sobre o botão de salvar de formulários com rodapé fixo); segue o visual do `@sgdm/design`; nada diz "i7Ai".

## Custo

Cada pergunta é uma conversa comum: tokens do modelo + texto da tela quando usado (um TR de ~5 páginas ≈ 6 mil tokens ≈ US$ 0,001 com os modelos baratos liberados hoje). Respeita orçamento mensal da prefeitura e do usuário, limite por minuto, licença e aparece em Consumo e custo como chat.

## Decisões tomadas

1. Configuração no SGDM (painel de controle), conversa no i7Ai (onde vivem agentes, histórico, pesquisa, custos).
2. Dono + gestor configuram (escolha do dono). Gestor só dentro da própria prefeitura e só com agentes da prefeitura.
3. Ler a tela sob demanda (com máscara e bloqueio da Saúde). Escrever no documento fica com o "Gerar com IA" que já existe nas peças.
4. Em todo o SGDM, inclusive telas novas (fica no esqueleto comum).

## Decisões do construtor (escolhas minhas, revisáveis pelo dono)

5. **Telas bloqueadas** para "Usar o que está na tela": todas as rotas `/saude/**` e `/fila/**` (senhas e guichê mostram nomes). Lista central num único arquivo do SGDM; uma página também pode se marcar como bloqueada. `/atendimento` (portal, LAI) não é dado de saúde e fica liberado. Telas com dados de cidadãos (protocolo, interessados, agenda) ficam liberadas com a máscara.
6. **Abrangência do gestor**: com abrangência "Própria secretaria", configura só a própria secretaria, os setores dela e os usuários dela; com "Todas", a prefeitura inteira (secretarias, setores, usuários). O padrão da prefeitura e o liga/desliga da prefeitura são só do dono.
7. **Dono**: a bolinha usa os agentes da prefeitura da sessão dele (a "Plataforma"), nunca os da prefeitura em gestão no seletor. Sem regra/agente para a Plataforma, o dono não vê a bolinha.
8. **Vários setores**: vale o setor principal pela regra que a IA do SGDM já usa para escolher o departamento (chefe primeiro, depois ordem, depois nome); a secretaria vem do cadastro do usuário. Só um setor conta, então não há conflito entre setores.
9. **Máscara do conteúdo da tela**: versão própria, mais branda que a das buscas — mascara CPF, RG, cartão SUS (CNS), e-mail e telefone; **mantém** CNPJ, números de processo, códigos de item e valores, que são o assunto do trabalho.

## Critérios de pronto

- Usuário da licitação com regra de secretaria → bolinha abre com o "Agente de Licitações"; usuário com regra própria → o agente dele; usuário desligado → sem bolinha.
- Pergunta com pesquisa ligada mostra "Pesquisando em compras públicas (PNCP)…" e devolve tabela; Copiar cola formatado no Word.
- Num documento aberto, "Usar o que está na tela" + "o que falta neste texto?" responde sobre o conteúdo do documento; CPF do texto chega mascarado ao modelo (verificado no registro de chamadas).
- Numa tela da Saúde, o botão está bloqueado com a mensagem.
- Gestor não vê nem configura outra prefeitura; dono desliga a prefeitura e a bolinha some para todos dela (em até 1 minuto).
- Com a IA do SGDM parada, as telas do SGDM abrem normalmente.

## Deixado para quem constrói

- Formato das tabelas de regras no SGDM e das rotas; como o i7Ai recebe o "conteúdo da tela" (campo novo na mensagem do chat, com limite e máscara).
- Componente da janela (reaproveitar o máximo do chat da IA do SGDM ou um cliente enxuto no SGDM consumindo as mesmas rotas de streaming).
- Como marcar as conversas do assistente.
- Posição exata da bolinha e como evitar rodapés fixos.
