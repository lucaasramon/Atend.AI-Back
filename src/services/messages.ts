/**
 * Mensagens automáticas (todas pelo WhatsApp do robô): o catálogo e as regras do admin.
 *
 * Cada mensagem enviada sozinha pela plataforma está listada aqui, com quando é enviada e para quem.
 * O admin liga/desliga e, nas mensagens para pessoas escolhidas, troca quem recebe (tabela message_rules).
 * As que já tinham liga/desliga próprio (lembretes, resumos, confirmações, aniversários) continuam
 * usando a mesma chave de system_settings: a tela nova só mostra e altera essa chave.
 *
 * Ao criar um envio novo na plataforma: acrescente aqui e use messageEnabled() / messageRecipients().
 */
import { query, queryOne } from "../db";

export type MessageGroup = "agenda" | "escalas" | "midia" | "louvor" | "pessoas" | "acesso";

export interface MessageDef {
  key: string;
  group: MessageGroup;
  title: string;
  /** Quando é enviada (texto para o admin) */
  when: string;
  channel: "private" | "group" | "both";
  /** Quem recebe por padrão (texto) */
  audience: string;
  /** Pessoas que recebem por padrão: quando existe, o admin pode escolher outras */
  defaultRecipients?: () => Promise<string[]>;
  /** Não pode ser desligada (sem ela ninguém entra na plataforma) */
  essential?: boolean;
  /** Liga/desliga já existente em system_settings ("true" = só liga com "true"; "notFalse" = liga a menos que seja "false") */
  setting?: { key: string; on: "true" | "notFalse" };
  /** Onde ajustar o texto e o horário */
  configure?: { label: string; path: string };
  /** Exemplo do texto enviado */
  example: string;
  /** Observação curta (dependências, limites) */
  note?: string;
}

/** Administradores com WhatsApp */
async function admins(): Promise<string[]> {
  return (await query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND whatsapp IS NOT NULL")).map((r) => r.id);
}

/** Pessoas da área Mídia (ou líder dela) */
async function media(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u
      WHERE u.role IN ('admin', 'agenda', 'viewer')
        AND EXISTS (SELECT 1 FROM ministries m
                     WHERE m.is_media
                       AND (m.leader_id = u.id OR EXISTS (SELECT 1 FROM user_ministries um WHERE um.ministry_id = m.id AND um.user_id = u.id)))`
  );
  return rows.map((r) => r.id);
}

export const MESSAGES: MessageDef[] = [
  // ---------- Agenda ----------
  {
    key: "event_reminder",
    group: "agenda",
    title: "Lembrete de evento",
    when: "Todo dia às 08h, nos dias de antecedência configurados (ex.: 7, 3 e 1 dia antes e no dia).",
    channel: "group",
    audience: "Grupo principal (pastores), grupos dos ministérios do evento e o grupo extra do evento",
    setting: { key: "reminders_enabled", on: "true" },
    configure: { label: "Agenda → Lembretes", path: "/admin/agenda" },
    example: "📅 Lembrete: Culto de Domingo — 09/11 às 19:00. Faltam 3 dias",
  },
  {
    key: "summary_weekly",
    group: "agenda",
    title: "Resumo da semana",
    when: "Toda segunda-feira às 08h.",
    channel: "group",
    audience: "Grupo principal e grupos dos ministérios com evento na semana",
    setting: { key: "summary_weekly_enabled", on: "notFalse" },
    configure: { label: "Agenda → Lembretes", path: "/admin/agenda" },
    example: "🗓️ Agenda da semana\n• Dom 09/11 19:00 — Culto de Domingo\n• Qua 12/11 19:30 — Culto de Oração",
    note: "Só sai se o Lembrete de evento estiver ligado.",
  },
  {
    key: "summary_monthly",
    group: "agenda",
    title: "Resumo do mês",
    when: "Todo dia 1º às 08h.",
    channel: "group",
    audience: "Grupo principal e grupos dos ministérios com evento no mês",
    setting: { key: "summary_monthly_enabled", on: "notFalse" },
    configure: { label: "Agenda → Lembretes", path: "/admin/agenda" },
    example: "🗓️ Agenda de novembro\n• 09/11 — Culto de Domingo\n• 15/11 — Encontro de Casais",
    note: "Só sai se o Lembrete de evento estiver ligado.",
  },
  {
    key: "event_pending",
    group: "agenda",
    title: "Evento aguardando aprovação",
    when: "Quando alguém que não é admin cadastra, altera ou importa eventos.",
    channel: "private",
    audience: "Administradores",
    defaultRecipients: admins,
    configure: { label: "Aprovações", path: "/admin/aprovacoes" },
    example: "📝 Novo evento aguardando aprovação\n\nCulto de Jovens\n🗓️ sáb., 15/11, 19:30\n👤 Cadastrado por Milena\n\nAprovar ou recusar: …/admin/aprovacoes",
  },
  {
    key: "event_approved",
    group: "agenda",
    title: "Seu evento foi aprovado",
    when: "Quando um admin aprova o evento.",
    channel: "private",
    audience: "Quem cadastrou o evento",
    example: "✅ Seu evento Culto de Jovens (sáb., 15/11, 19:30) foi aprovado e já está na agenda.",
  },
  {
    key: "event_rejected",
    group: "agenda",
    title: "Seu evento não foi aprovado",
    when: "Quando um admin recusa o evento.",
    channel: "private",
    audience: "Quem cadastrou o evento",
    example: "❌ Seu evento Culto de Jovens (sáb., 15/11, 19:30) não foi aprovado.\nMotivo: conflito de horário",
  },
  {
    key: "ack_request",
    group: "agenda",
    title: "Confirmação de ciência",
    when: "Quando o evento é aprovado. Sem resposta no prazo, cobra o pastor responsável e depois os administradores.",
    channel: "private",
    audience: "Líder de cada ministério do evento → pastor responsável → administradores",
    setting: { key: "ack_enabled", on: "notFalse" },
    configure: { label: "Confirmações", path: "/admin/confirmacoes" },
    example: "📌 Olá, Milena! Há um evento do seu ministério na agenda. Confirme que viu:\n\n• 15/11 19:30 — Culto de Jovens (Jovens)\n\n✅ Confirmar: …",
  },
  // ---------- Escalas ----------
  {
    key: "roster_private",
    group: "escalas",
    title: "Checklist da escala",
    when: "Dias antes do evento (configurado), só nos eventos com “mensagem no privado” ligada.",
    channel: "private",
    audience: "Cada pessoa escalada",
    configure: { label: "Escalas", path: "/admin/escalas" },
    example: "🙌 Olá, Dácio! Você está escalado(a):\n\n📅 Culto de Domingo — domingo, 09/11 19:00\n🎯 Mídia · Câmera 1\n\n✅ Confirme sua presença aqui: …",
  },
  {
    key: "roster_group",
    group: "escalas",
    title: "Escala no grupo da área",
    when: "1 dia antes do evento, quando a escala foi marcada para ir ao grupo.",
    channel: "group",
    audience: "Grupo escolhido ao montar a escala",
    configure: { label: "Escalas", path: "/admin/escalas" },
    example: "👥 Escala — Louvor\n\n📅 Culto de Domingo — domingo, 09/11 19:00\n\n• Ana — Vocal\n• João — Teclado\n\nContamos com vocês! 🙏",
  },
  {
    key: "task_reminder",
    group: "escalas",
    title: "Lembrete de tarefa do evento",
    when: "Perto do prazo da tarefa, só nos eventos com “mensagem no privado” ligada.",
    channel: "private",
    audience: "Responsável pela tarefa",
    configure: { label: "Agenda", path: "/admin/agenda" },
    example: "📋 Olá, Milena! Você tem tarefa perto do prazo:\n\n☐ Comprar lanche — prazo hoje\n   Culto de Jovens (15/11)",
  },
  // ---------- Mídia ----------
  {
    key: "media_new",
    group: "midia",
    title: "Nova demanda da mídia",
    when: "Quando uma demanda é criada para uma pessoa.",
    channel: "private",
    audience: "Responsável pela demanda",
    configure: { label: "Mídia", path: "/admin/midia" },
    example: "🎬 Nova demanda da mídia para você: Arte do Culto de Jovens\nTipo: Arte · Prazo: 12/11 18:00",
  },
  {
    key: "media_due",
    group: "midia",
    title: "Demandas perto do prazo",
    when: "Todo dia às 08h, perto do prazo da demanda.",
    channel: "both",
    audience: "Responsável (demandas individuais) e grupo da Mídia (demandas do grupo)",
    configure: { label: "Mídia", path: "/admin/midia" },
    example: "🎬 Olá, Dácio! Demandas da mídia perto do prazo:\n\n☐ [Arte] Culto de Jovens — hoje 18:00",
  },
  {
    key: "pop_daily",
    group: "midia",
    title: "POP do dia",
    when: "Às 08h, no dia programado de cada POP.",
    channel: "group",
    audience: "Grupo do ministério do POP",
    configure: { label: "POPs", path: "/admin/pops" },
    example: "📋 POP: Abertura do templo\n☐ Ligar o som\n☐ Testar microfones",
  },
  // ---------- Louvor e telão ----------
  {
    key: "worship_changed",
    group: "louvor",
    title: "Mudança nas músicas do louvor",
    when: "Quando o louvor tira ou troca a ordem de músicas que já estão no Holyrics (2 minutos depois da última mudança).",
    channel: "private",
    audience: "Toda a equipe da Mídia",
    defaultRecipients: media,
    configure: { label: "Escalas → Músicas do louvor", path: "/admin/escalas" },
    example: "🎵 O louvor de Culto de Domingo (09/11, 19:00) mudou.\nNo Holyrics, ajuste a lista de mídia desse culto:\n\n❌ Tirar: Música X",
  },
  {
    key: "screen_request",
    group: "louvor",
    title: "Pedido para o telão",
    when: "Quando a sala infantil, o estacionamento ou o pastor pede algo para o telão.",
    channel: "private",
    audience: "Toda a equipe da Mídia (menos quem pediu)",
    defaultRecipients: media,
    configure: { label: "Telão (aprovar)", path: "/admin/telao" },
    example: "📺 Pedido para o telão (Sala infantil · Milena)\n“Criança 12 · Sala infantil”\nAprove ou recuse em até 5 minutos: …/admin/telao",
    note: "É só o reforço: o aviso principal aparece em tela cheia na plataforma para quem é da Mídia, mesmo com esta mensagem desligada.",
  },
  // ---------- Pessoas ----------
  {
    key: "birthday",
    group: "pessoas",
    title: "Parabéns de aniversário",
    when: "No dia do aniversário, a partir das 08h, com intervalo entre um envio e outro.",
    channel: "private",
    audience: "Cada aniversariante com WhatsApp no cadastro",
    setting: { key: "birthday_enabled", on: "notFalse" },
    configure: { label: "Cadastros → Aniversários", path: "/admin/cadastros" },
    example: "🎉 Feliz aniversário, Ana! A Igreja Cristã Despertar celebra a sua vida…",
  },
  // ---------- Acesso ----------
  {
    key: "access_link",
    group: "acesso",
    title: "Acesso à plataforma",
    when: "Quando o admin cadastra um usuário ou reenvia o acesso.",
    channel: "private",
    audience: "O novo usuário",
    essential: true,
    configure: { label: "Usuários", path: "/admin/usuarios" },
    example: "Olá, Ana! Seu acesso ao D.Sync: …/primeiro-acesso · login ana@email.com · senha temporária …",
  },
  {
    key: "password_reset",
    group: "acesso",
    title: "Esqueci minha senha",
    when: "Quando a pessoa pede para redefinir a senha na tela de login.",
    channel: "private",
    audience: "A própria pessoa",
    essential: true,
    example: "Olá, Ana! 🔐 Recebemos um pedido para redefinir a sua senha do D.Sync.\n🔗 Crie uma senha nova por este link (vale 30 minutos): …",
  },
];

export const messageDef = (key: string) => MESSAGES.find((m) => m.key === key);

interface Rule {
  enabled: boolean | null;
  custom_recipients: string[] | null;
}

const ruleOf = (key: string) => queryOne<Rule>("SELECT enabled, custom_recipients FROM message_rules WHERE key = $1", [key]);

/** A mensagem está ligada? (as essenciais sempre estão) */
export async function messageEnabled(key: string): Promise<boolean> {
  const def = messageDef(key);
  if (!def || def.essential) return true;
  if (def.setting) {
    const row = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = $1", [def.setting.key]);
    return def.setting.on === "true" ? row?.value === "true" : row?.value !== "false";
  }
  return (await ruleOf(key))?.enabled !== false;
}

/** Quem recebe: a lista escolhida pelo admin, ou o padrão da mensagem */
export async function messageRecipients(key: string, fallback?: string[]): Promise<string[]> {
  const rule = await ruleOf(key);
  if (rule?.custom_recipients) return rule.custom_recipients;
  if (fallback) return fallback;
  return (await messageDef(key)?.defaultRecipients?.()) || [];
}

export async function setMessageEnabled(key: string, enabled: boolean, userId: string) {
  const def = messageDef(key);
  if (!def || def.essential) return;
  if (def.setting) {
    await query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [def.setting.key, enabled ? "true" : "false"]
    );
    return;
  }
  await query(
    `INSERT INTO message_rules (key, enabled, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, enabled, userId]
  );
}

/** null = volta para quem recebe por padrão */
export async function setMessageRecipients(key: string, ids: string[] | null, userId: string) {
  await query(
    `INSERT INTO message_rules (key, custom_recipients, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET custom_recipients = EXCLUDED.custom_recipients, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, ids, userId]
  );
}

/** Situação de todas as mensagens, para a tela do admin */
export async function messagesOverview() {
  const [rules, users] = await Promise.all([
    query<Rule & { key: string; updated_at: string; updated_by_name: string | null }>(
      `SELECT r.key, r.enabled, r.custom_recipients, r.updated_at, u.full_name AS updated_by_name
         FROM message_rules r LEFT JOIN users u ON u.id = r.updated_by`
    ),
    query<{ id: string; full_name: string | null; email: string; whatsapp: string | null }>("SELECT id, full_name, email, whatsapp FROM users"),
  ]);
  const person = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? { id, name: u.full_name || u.email, has_whatsapp: !!u.whatsapp } : null;
  };
  const out = [];
  for (const def of MESSAGES) {
    const rule = rules.find((r) => r.key === def.key);
    const editable = !!def.defaultRecipients;
    const defaults = editable ? await def.defaultRecipients!() : [];
    const custom = rule?.custom_recipients || null;
    out.push({
      key: def.key,
      group: def.group,
      title: def.title,
      when: def.when,
      channel: def.channel,
      audience: def.audience,
      example: def.example,
      note: def.note || null,
      essential: !!def.essential,
      configure: def.configure || null,
      enabled: await messageEnabled(def.key),
      recipients_editable: editable,
      default_recipients: defaults.map(person).filter(Boolean),
      custom_recipients: custom ? custom.map(person).filter(Boolean) : null,
      updated_at: rule?.updated_at || null,
      updated_by_name: rule?.updated_by_name || null,
    });
  }
  return out;
}
