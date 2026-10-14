# CRM Aluguel (Thainara)

Três telas: **Entrada** → **Funil de aluguel** → **Painel** (o Painel só aparece para administrador).

## Onde está cada coisa
- Tela: `index.html` (um arquivo só; login pelo Supabase). Online: https://marcomartinssm.github.io/crm-aluguel/
- Função que recebe as mensagens: `supabase/functions/crm-aluguel-entrada/index.ts`
  (projeto Supabase `jgdbnkwhmesgjvsymgma`, verify_jwt desligado, protegida por `?token=`).
- O token fica na tabela `crm_aluguel_config` (chave `webhook_token`) e em `.token` nesta pasta (não compartilhar).
- WhatsApp da Thainara = instância Evolution **ALUGUELARA**, com webhook `MESSAGES_UPSERT` + `SEND_MESSAGE` apontando para a função.

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
- Cliente resolvido (Vendas/Outros/final do funil) que volta a escrever **depois de 7 dias**: entra de novo na Entrada.
- "Cliente já com histórico" = tem mensagem com a Thainara de mais de 24h atrás, OU está na tabela `leads`, OU já passou pelo CRM de aluguel.

## Tempo de primeira resposta
- Começa quando o cliente fala pela 1ª vez (`cliente_falou_em`). No cadastro do site, começa quando o cliente
  responde a mensagem automática (a automática não conta como resposta).
- Termina na 1ª mensagem da Thainara depois disso (`primeira_resposta_em`).
- Guarda os minutos corridos (`primeira_resposta_min`) e só os minutos de horário comercial
  (`primeira_resposta_min_expediente`; seg-sex 8h-12h e 13h30-18h, sáb 8h-12h — mesmo horário do Radar).

## Funil (função `crm_aluguel_mover` no banco)
Colunas: 1 Atendimento · 2 Visita · 2.1 Visita realizada · 2.2 Não realizada · 3 Ficha cadastral · 3.1 Aprovado ·
3.2 Reprovado · 4.1 Realizado · 4.2 Perdido · 5 Descartado. O banco só aceita os caminhos previstos:
- Ficha sem visita (saindo de 1 ou 2.2) exige "Cliente não quis visitar".
- Perdido (só de 3.1) e Descartado (de 1, 2.1, 2.2) exigem motivo; Reprovado grava o motivo sozinho.
- A etapa onde o cliente parou fica em `etapa_da_perda`; finais podem ser reabertos (voltam para Atendimento).
- Cada mudança vira uma linha em `crm_aluguel_movimentos`. Tempo até fechar = `fechado_em - entrou_funil_em`.

Entrada tem 4 botões: Aluguel, Vendas, Outros, Suporte (boleto, manutenção etc.).

## Painel (só administrador — função `crm_aluguel_painel(inicio, fim)`)
Períodos: hoje, ontem, 7 dias, este mês, 30 dias (dias em horário de Brasília). Mostra: como está o funil agora,
entrada no período (novos, com histórico, cadastro no site, para onde foram), 1ª resposta (média em horário comercial
e corrida, % em até 5 min, sem resposta), movimento do funil, taxas, tempo médio até fechar e perdas por motivo + etapa.
A função recusa quem não é admin, então a Thainara não consegue ver os números nem chamando direto.

## Dar acesso a alguém
1. Supabase → Authentication → Users → Add user (e-mail e senha, marcar "Auto Confirm").
2. Rodar no SQL:
   `insert into crm_aluguel_usuarios (user_id, nome, papel, instancia) select id, 'Thainara', 'atendente', 'ALUGUELARA' from auth.users where email = 'EMAIL';`
