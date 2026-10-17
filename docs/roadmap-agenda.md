# Agenda da Igreja e Robô D.Sync — Entrega do roadmap

> Situação em 17/10/2026: **os 12 itens foram implementados** (backend v1.9.0).
> Para valer em produção é preciso **Implantar o backend e o frontend** no Easypanel.
> O banco já está atualizado (migrations 008 a 012 aplicadas).

---

## O que cada item virou

| # | Item | Onde fica no sistema | Status |
|---|---|---|---|
| 1 | Calendário anual | **Calendário → Ano** (12 meses); **Agenda → Importar** (planilha CSV); repetição de eventos (semanal, quinzenal, mensal); categorias com cor | ✅ |
| 2 | Lembretes 30, 21, 14, 10, 7, 3 e 1 dia | Já é o padrão, mais o "É hoje!". Cada evento pode ter os seus em **Lembretes personalizados** | ✅ |
| 3 | Checklist de demandas do evento | Botão ☑ em cada evento na **Agenda**: responsável, prazo, modelos (**Agenda → Modelos**). O responsável recebe lembrete 2 dias antes e no dia | ✅ |
| 4 | Resumo mensal e semanal | Dia 1º (mês) e segunda-feira (semana), às 08:00. Liga/desliga e prévia em **Agenda → Configurar** | ✅ |
| 5 | Validação de datas pelos admins | Evento de quem não é admin fica **aguardando aprovação**; admins avisados no WhatsApp; tela **Aprovações** | ✅ |
| 6 | Grupo principal + grupos filtrados | Grupo principal (pastores) recebe tudo; cada **Ministério** com grupo recebe só os seus eventos (lembretes e resumos) | ✅ |
| 7 | POPs por grupo | Tela **POPs**: passos, anexo (link), repetição semanal/mensal e envio no grupo do ministério | ✅ |
| 8 | Calendário da Mídia | Tela **Mídia**: demandas do grupo e individuais, briefing, anexos, status e pacote gerado a partir do evento | ✅ |
| 9 | Confirmação com escalonamento | Líder confirma pelo link do WhatsApp; sem confirmação em 48h → pastor responsável → admins. Painel **Confirmações** | ✅ |
| 10 | Alerta de conflitos | Aviso no formulário do evento: mesmo horário, mesmo local ou mesmo ministério | ✅ |
| 11 | Disponibilidade de locais | Tela **Locais**: grade da semana (livre/ocupado) e cadastro dos espaços | ✅ |
| 12 | Checklist de POP por membro escalado | Tela **Escalas**: membros (sem login), áreas com POP, escala por culto. Na véspera, cada escalado recebe o seu checklist e marca pelo celular | ✅ |

---

## Decisões que adotei (todas ajustáveis)

| Decisão | Padrão adotado | Onde mudar |
|---|---|---|
| Aviso "É hoje!" | Mantido junto com 30, 21, 14, 10, 7, 3 e 1 dia | Agenda → Configurar |
| Aprovação de datas | **Basta 1 admin** aprovar. Eventos criados por admin já entram aprovados | `approval_required` nas configurações |
| Prazo de confirmação | **48h** em cada nível (líder → pastor → admins) | Confirmações → prazo |
| Série de eventos | Só a primeira data pede confirmação ao líder (evita uma mensagem por semana) | — |
| Resumos sem eventos | Não são enviados (evita mensagem vazia) | — |
| Escalas | Checklist enviado **1 dia antes** do evento | `roster_days_before` |
| Horário das rotinas | Todo dia às **08:00** (Brasília); escalonamento verificado a cada hora | `REMINDERS_TIME` no Easypanel |

---

## Para começar a usar (ordem sugerida)

1. **Implantar** backend e frontend no Easypanel. Conferir no log: `Backend v1.9.0`.
2. **Usuários**: cadastrar o **Pr. Marcelo** e o **Dácio** como Administradores, e preencher o **WhatsApp da conta do Lucas** (editar usuário). Sem WhatsApp, o admin não recebe os pedidos de aprovação.
3. **Locais**: cadastrar Templo, Sala das Crianças etc.
4. **Ministérios**: criar cada um com o grupo do WhatsApp, líder e pastor responsável (os dois precisam ser usuários com WhatsApp). Marcar o de **Mídia**. O robô D.Sync precisa estar dentro de cada grupo.
5. **Agenda → Importar**: baixar o modelo, preencher o calendário anual e importar.
6. **POPs** e **Escalas**: cadastrar os POPs, as áreas de cada ministério e os membros que servem.

---

## Pontos de atenção

- **Número do robô:** com mais grupos e mensagens individuais, o volume do D.Sync aumenta. Vale ter um chip dedicado só para ele, para reduzir o risco de bloqueio pelo WhatsApp.
- **Anexos** (POPs e Mídia) são links (Google Drive, PDF publicado), não upload de arquivos.
- **Membros escalados** não têm login: o link do checklist no WhatsApp é o acesso deles, e cada reenvio gera um link novo.
