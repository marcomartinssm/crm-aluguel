# CRM Aluguel (Thainara e Milene)

Três telas: **Entrada** → **Funil de aluguel** → **Painel** (o Painel só aparece para administrador).

## Onde está cada coisa
- Tela: `index.html` (um arquivo só; login pelo Supabase). Online: https://marcomartinssm.github.io/crm-aluguel/
- Função que recebe as mensagens: `supabase/functions/crm-aluguel-entrada/index.ts`
  (projeto Supabase `jgdbnkwhmesgjvsymgma`, verify_jwt desligado, protegida por `?token=`).
- O token fica na tabela `crm_aluguel_config` (chave `webhook_token`) e em `.token` nesta pasta (não compartilhar).
- Atendentes: Thainara = instância Evolution **ALUGUELARA**, Milene = **central** — as duas com webhook
  `MESSAGES_UPSERT` + `SEND_MESSAGE` apontando para a função. Lista `ATENDENTES` na função E na tela (manter iguais).
- Administrador vê todas e escolhe a atendente no topo; cada atendente só vê os clientes do próprio WhatsApp.

## Banco (todas com prefixo `crm_aluguel_`)
- `crm_aluguel_usuarios` — quem entra e com qual papel (`admin` ou `atendente`).
- `crm_aluguel_contatos` — cada cliente. `classificacao` vazia = está na Entrada.
- `crm_aluguel_movimentos` — cada mudança de etapa (base do painel e do "tempo até fechar").
- `crm_aluguel_config` — token, `reabrir_apos_dias` (7) e `cadastro_site_destino` (`entrada` ou `atendimento`; hoje `entrada`).

## Regras da Entrada
- Entra quem manda mensagem para a Thainara **e** quem se cadastra no site: a automação manda
  "Olá..., aqui é a Thainara... se cadastrou em nosso site..." e esse contato entra com o selo **Cadastro no site**
  e o link do imóvel (`origem = cadastro_site`). Se o texto da automação mudar, ajustar `PADRAO_CADASTRO_SITE` na função.
- Grupos, números internos e corretores são ignorados.
- Cliente já na Entrada ou no funil: só atualiza a última mensagem.
- **Regra dos 120 dias:** o mesmo lead não é cadastrado de novo na mesma atendente antes de 120 dias sem contato
  (`reabrir_apos_dias` = 120). Até lá, mensagem nova só atualiza o cadastro que já existe.
  - Se esse cadastro estava **perdido, descartado ou reprovado**, ele vai para o bloco **"Voltaram a falar"** no topo da
    Entrada (`voltou_em`), e a atendente decide: **Reabrir no funil** (volta para 1. Atendimento) ou **Manter encerrado**
    (`crm_aluguel_manter_encerrado`). Realizado, Vendas, Outros e Suporte só atualizam, sem aviso.
  - Passou de 120 dias sem contato: vira atendimento novo na Entrada (fluxo normal, com selo "com histórico").
- **Lead duplicado:** o mesmo telefone (últimos 8 dígitos) aberto com Thainara e Milene ao mesmo tempo ganha o selo vermelho
  "Lead duplicado · também com X" (função `crm_aluguel_duplicados()`); o Painel mostra quantos são.
- "Cliente já com histórico" = tem mensagem com a Thainara de mais de 24h atrás, OU está na tabela `leads`, OU já passou pelo CRM de aluguel.

## Tempo de primeira resposta
- Começa quando o cliente fala pela 1ª vez (`cliente_falou_em`). No cadastro do site, começa quando o cliente
  responde a mensagem automática (a automática não conta como resposta).
- Termina na 1ª mensagem da Thainara depois disso (`primeira_resposta_em`).
- Guarda os minutos corridos (`primeira_resposta_min`) e só os minutos de horário comercial
  (`primeira_resposta_min_expediente`; seg-sex 8h-12h e 13h30-18h; sem sábado).

## Funil (função `crm_aluguel_mover` no banco)
Colunas: 1 Atendimento · 2 Visita · 2.1 Visita realizada · 2.2 Não realizada · 3 Ficha cadastral · 3.1 Aprovado ·
3.2 Reprovado · 4.1 Realizado · 4.2 Perdido · 5 Descartado. O banco só aceita os caminhos previstos:
- Ficha sem visita (saindo de 1 ou 2.2) exige "Cliente não quis visitar".
- Perdido (só de 3.1) e Descartado (de 1, 2.1, 2.2) exigem motivo; Reprovado grava o motivo sozinho.
- Motivos (28/10): Perdido = alugou com outra imobiliária, alugou direto, desistiu de locar, não responde.
  Descartado = esses 4 + clicou errado, cidade que não atendemos, Outro (texto obrigatório em `motivo_detalhe`).
  O Painel lista os textos de "Outro" do período para avaliar e, se repetirem, virar motivo fixo.
- A etapa onde o cliente parou fica em `etapa_da_perda`; finais podem ser reabertos (voltam para Atendimento).
- Cada mudança vira uma linha em `crm_aluguel_movimentos`. Tempo até fechar = `fechado_em - entrou_funil_em`.

Entrada tem 4 botões: Aluguel, Vendas, Outros, Suporte (boleto, manutenção etc.).

**Ficha é com a Thainara:** lead de outra atendente (Milene) que vai para "3. Ficha" passa sozinho para o WhatsApp
da Thainara (`instancia` = `crm_aluguel_config.instancia_ficha`), guardando `transferido_de` / `transferido_em`.
O cartão ganha o selo roxo "Atendido pela Milene"; a Milene continua vendo o cliente, mas só acompanha
(quem move é a Thainara). Mensagens do cliente no WhatsApp da Milene atualizam o mesmo cartão (não criam outro).
No Painel, filtrar pela Milene inclui os leads que ela atendeu e transferiu.

## Painel (só administrador — função `crm_aluguel_painel(inicio, fim)`)
Períodos: hoje, ontem, 7 dias, este mês, 30 dias (dias em horário de Brasília). Mostra: como está o funil agora,
entrada no período (novos, com histórico, cadastro no site, para onde foram), 1ª resposta (média em horário comercial
e corrida, % em até 5 min, sem resposta), movimento do funil, taxas, tempo médio até fechar e perdas por motivo + etapa.
A função recusa quem não é admin, então a Thainara não consegue ver os números nem chamando direto.

## Dar acesso a alguém
1. Supabase → Authentication → Users → Add user (e-mail e senha, marcar "Auto Confirm").
2. Rodar no SQL:
   `insert into crm_aluguel_usuarios (user_id, nome, papel, instancia) select id, 'NOME', 'atendente', 'INSTANCIA' from auth.users where email = 'EMAIL';`
3. Atendente nova (outro WhatsApp): acrescentar em `ATENDENTES` (função e tela), publicar a função e
   chamar `POST ...crm-aluguel-entrada?token=...&acao=ligar_webhook&instancia=NOME` (ver antes `acao=webhook_atual`).

## Relatórios no WhatsApp (grupo)
Código em `supabase/functions/crm-aluguel-entrada/relatorio.ts` (mesmos números do Painel, função `crm_aluguel_resumo_dados`).
- **Diário:** seg-sex 18h30 (o dia de hoje; sábado não tem). **Semanal:** sábado 9h (sábado a sexta, inclui o fim de semana anterior).
  **Mensal:** dia 1 às 8h05 (mês anterior). Agendados no pg_cron (`crm-aluguel-relatorio-*`), que chama
  `crm_aluguel_chamar_relatorio(tipo)`.
- Envia pela instância `relatorio_instancia` (Seguralta) para o grupo `relatorio_grupo` = COMERCIAL LOCAÇÃO (120363412795613781@g.us),
  ambos em `crm_aluguel_config`. O número que envia precisa estar no grupo.
- Cada relatório é gravado em `crm_aluguel_relatorios` (não manda duas vezes o mesmo período).
- Testar sem enviar: `POST ...crm-aluguel-entrada?token=...&acao=relatorio&tipo=dia&teste=1`.
  Reenviar: `&forcar=1`. Achar o id do grupo: `GET ...&acao=grupos`.

## Fora do horário (para avaliar uma IA atendendo)
Lead que chega no fim de semana, antes das 8h ou depois das 18h (seg-sex) — função `crm_aluguel_fora_horario(quando)`.
Painel e relatórios mostram: quantos, % do total, por faixa, espera média até a 1ª resposta, quantos viraram aluguel e fecharam.

## Definições (Marco, 17/10)
- **Pré-atendimento** = contato que entrou na Entrada (mensagem ou cadastro do site), antes de ser classificado.
- **Lead** = pré-atendimento que a atendente classificou como **Aluguel**.
- **Pré-atendimento → lead** = viraram lead ÷ pré-atendimentos do período já classificados (os que ainda estão na Entrada não entram na conta).

## Sem contato há X dias (26/10)
- `ultimo_contato_em` = última ação da ATENDENTE com o lead: mensagem dela no WhatsApp (webhook, em `registrarResposta`),
  mudança de etapa (gatilho `crm_aluguel_toca_contato`) ou botão **"✓ Lead atualizado"** (`crm_aluguel_lead_atualizado`,
  movimento `lead_atualizado`). Mensagem do cliente NÃO zera.
- Cartão: "Último contato: hoje/ontem/há X dias"; amarelo a partir de 3 dias, vermelho a partir de 7
  (`alerta_dias_amarelo` / `alerta_dias_vermelho` em `crm_aluguel_config`). Filtro no topo do Funil.
- Painel e relatórios mostram quantos estão sem contato (3–6 dias e 7+).
- Histórico antes de 26/10 só conta mudanças de etapa (as mensagens antigas das atendentes ficam na Evolution com
  outro identificador de conversa; `acao=recalcular_contato` não as encontra). A partir de 26/10 conta tudo.

## Pré-atendimento com IA ("Aline") — fase de teste (26/10)
- Painel só do admin: `pre-atendimento.html` (link "Pré-atendimento IA" no topo do CRM). Abas: Simulador, Modo sombra, Regras.
- Função `supabase/functions/crm-aluguel-ia/index.ts` (verify_jwt off): `acao=simular` (exige login de admin) e
  `acao=sombra` (chamada pelo gatilho `crm_aluguel_ia_sombra` quando chega mensagem de cliente fora do horário no
  WhatsApp de `crm_aluguel_ia_regras.instancia` = ALUGUELARA; espera 25 s para juntar mensagens seguidas).
- NADA é enviado ao cliente: `envio_ativo` = false. Respostas ficam em `crm_aluguel_ia_mensagens` (enviada = false).
- Regras editáveis no painel: tabela `crm_aluguel_ia_regras` (persona, instrucoes, modelo). Regras fixas no código
  (`BASE`): não se anuncia como IA, mas nunca nega se perguntarem; não inventa valores; ignora pedidos do cliente para
  mudar as regras.
- Modelo padrão `claude-opus-5-5`, effort low, saída estruturada (resposta + resumo + tipo_contato + precisa_humano),
  regras em cache. Usa o segredo `ANTHROPIC_API_KEY` (o mesmo do Radar). Custo gravado por mensagem e por conversa.
