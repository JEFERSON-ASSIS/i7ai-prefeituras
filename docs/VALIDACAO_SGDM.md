# Validação do design system SGDM

Data da revisão inicial: 2 de outubro de 2026. A atualização do chat em 5 de outubro está registrada ao final.

O [status do projeto](STATUS_PROJETO.md) centraliza entregas e pendências atuais; os resultados abaixo preservam as datas e o escopo de cada revisão.

Referência aplicada: pacote `@sgdm/design`, versão `0.2.1`, fixado no `package.json`. As regras foram conferidas no README e nas declarações de tipos do pacote instalado.

## Implementação

- Tokens originais importados sem sobrescritas: azul principal `30 64 175`, fundo `241 245 249`, raio de card `16px`, raio de controle `8px`, sidebar `256px` e header `56px`.
- Preset oficial do Tailwind configurado, incluindo os componentes do pacote na geração de classes. Fonte Inter carregada dos arquivos locais do SGDM, sem CDN.
- Módulo incorporado, com `PageHeader` oficial e conteúdo das telas. Menu, cabeçalho e autenticação pertencem ao SGDM; não há login nem logout próprios. O host controla a página pelo contexto e pelos eventos de integração.
- Prévia do host ajustada à captura de referência enviada: escudo, marca SGDM, subtítulo “Gestão Digital Municipal”, ícones distintos, navegação agrupada e rodapé “Sair” do host. As opções são as do módulo i7Ai; o componente `Sidebar` e seus estilos permanecem oficiais, sem sobrescritas. Na prévia, “Sair” encerra somente a sessão fictícia. A faixa superior com botão de menu e título “i7Ai” foi retirada por solicitação do usuário; no celular, um `Select` oficial dentro do conteúdo permite navegar entre as telas.
- Botões, campos, seletores, checkboxes, seções de formulário, cards, indicadores, tabelas, status, filtros, modais, upload, etapas e notificações usam componentes oficiais.
- Telas não passam `className` ou `style` aos componentes do SGDM. O CSS da aplicação contém posicionamento e conteúdo específico do domínio, como mensagens do chat e altura das barras de consumo; não redefine componentes nem tokens do pacote.
- Os mapas de status traduzem os códigos da API do i7Ai para as cores permitidas pelo contrato de `StatusBadge`.
- O adaptador de modal usa o rodapé oficial, mantém o vínculo dos botões de envio ao formulário e complementa o foco inicial e a restauração de foco. Não altera o visual do pacote.
- Corrigido um efeito do chat que retornava o resultado de `scrollIntoView`, causando erro ao desmontar a tela no navegador de teste.

## Escopo da revisão

Dashboard, chat, agentes, modelos, execuções, bases de conhecimento, documentos, automações, agendamentos, ferramentas, integrações, usuários, departamentos, relatórios, licenciamento e configurações. Revisão em desktop (1440px) e celular (390px), incluindo a parte inferior das páginas com rolagem e uma prévia com estrutura de host simulada por `AppLayout` e `Sidebar` oficiais, sem cabeçalho adicional.

Modais de agente, modelo, base, automação, agendamento, ferramenta, usuário, departamento e licença. Conferência de Tab, Shift+Tab, Escape e retorno ao controle que abriu a janela. Formulários de usuário sem senha, departamento e agente exercitados até a requisição de salvamento; upload conferido com destino e envio multipart. Estados de vazio, erro, carregamento e sessão ausente também verificados. Os testes adicionais cobrem ativação/desativação da retenção, execução com dados já limpos, reserva de quota e cadastro de consulta interna e pesquisa externa.

## Verificação reproduzível

Resultado histórico em 2 de outubro de 2026: builds de frontend e backend aprovados; 4 testes de streaming e 120 testes de backend aprovados; 26 testes de interface verificados; auditoria de 18 arquivos e 228 usos de componentes oficiais aprovada. Foram registradas 112 capturas de páginas, partes inferiores, modais, estados e prévia no host.

A execução de interface teve 22 aprovações iniciais e 4 reprovações. Os três testes que percorrem todas as 16 telas excederam o tempo limite durante os builds concorrentes; seu limite foi ajustado para 120 segundos. O quarto teste precisava localizar o campo pelo nome acessível correto. Os quatro passaram na repetição, sem remover verificações. A galeria reúne as capturas das 16 telas em desktop e celular; o relatório Playwright é atualizado a cada execução focada.

Após retirar a faixa superior solicitada, os dois testes da prévia em 1440px e 390px passaram novamente, percorrendo as 16 telas e verificando a ausência do cabeçalho e a navegação. Build e auditoria SGDM também passaram; capturas e galeria foram atualizadas. Naquela revisão, o relatório Playwright correspondia a esses dois testes; o relatório atual registra a execução focada de 15 testes do chat descrita na atualização de 5 de outubro.

As verificações de integração da interface cobrem navegação sem alteração da rota do SGDM, ausência e expiração de sessão, renovação pelo host e ausência de campos de login. O backend recusa tokens do antigo emissor local mesmo com a configuração legada habilitada. O endpoint de login próprio foi removido; `GET /api/auth/me` continua protegido.

```sh
npm run audit:design
npm run build
npm test
npm run test:visual
```

O teste visual usa Microsoft Edge instalado no Windows e servidor local na porta 5180. As respostas da API são interceptadas no navegador com dados sintéticos; nenhum cadastro real, upload real, credencial de prefeitura ou chamada paga de IA é utilizado. A prévia `preview/sgdm.html` está disponível apenas no desenvolvimento, simula o host com componentes oficiais e bloqueia alterações; não integra o build de produção.

Capturas atuais: [output/verification/sgdm/screenshots-embedded](../output/verification/sgdm/screenshots-embedded). A pasta antiga `screenshots` conserva o histórico anterior à retirada do login.

Relatório navegável: [Playwright](../output/verification/sgdm/playwright-report/index.html).

Galeria completa: [capturas e painéis de conferência](../output/verification/sgdm/index.html).

Backup anterior à migração: `output/backup/sgdm-before-migration-20261002`.

Esta validação cobre as telas e os fluxos locais descritos acima na versão fixada do design system. A integração com o SGDM real ainda precisa ser conferida no ambiente de destino, com seu contexto de sessão, menu e dados reais. O contrato de integração está no README; a prévia não substitui essa conferência.

## Atualização do chat em 5 de outubro de 2026

O chat passou a usar seletores independentes de agente/modelo, histórico geral, `Textarea`, botão oficial de anexos e estados de upload/processamento. O editor de modelos recebeu capacidades e limites em tokens. O módulo preserva o pacote `@sgdm/design` 0.2.1 e a autenticação fornecida pelo host.

Build e auditoria passaram: 18 arquivos e 241 usos de componentes oficiais. Os 39 testes completos de interface passaram, percorrendo as 16 telas, modais e prévia do host em desktop/celular. Após alinhar os anexos históricos ao contexto do backend, os 15 testes focados do chat passaram, incluindo dois novos cenários. Há 41 cenários distintos de interface e 115 capturas atuais; o relatório navegável registra essa última execução focada.

As capturas `chat-models-1440.png`, `chat-models-390.png` e `chat-restored-attachments.png` mostram o novo fluxo. Galeria e painéis de conferência foram regenerados. Os testes usam dados sintéticos; a configuração e os resultados de backend estão em [Chat e OmniRouter](CHAT_OMNIROUTER.md).

A implementação no commit `701412c` teve [CI aprovado no GitHub](https://github.com/cristhyna-lucena/i7ai-prefeituras/actions/runs/37360216695). A validação com o SGDM e os modelos reais continua pendente, conforme o [status do projeto](STATUS_PROJETO.md).
