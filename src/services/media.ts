/**
 * Demandas da Mídia: lembrete 2 dias antes e no dia do prazo.
 * Individual → WhatsApp do responsável. Do grupo → grupo do ministério de Mídia.
 */
import { query } from "../db";
import { TZ, getReminderSettings, localDate, sendToGroups } from "./reminders";
import { appUrl, sendDirect } from "./notify";

export const MEDIA_TYPES: Record<string, string> = {
  captacao: "Captação",
  gravacao: "Gravação",
  post: "Post",
  arte: "Arte",
  video: "Vídeo",
  transmissao: "Transmissão",
  outro: "Outro",
};

/** Demandas sugeridas ao gerar a partir de um evento (horas relativas ao início) */
export const EVENT_MEDIA_PLAN = [
  { type: "arte", title: "Arte de divulgação", hours: -21 * 24 },
  { type: "post", title: "Posts de divulgação", hours: -14 * 24 },
  { type: "post", title: "Lembrete nos stories", hours: -24 },
  { type: "captacao", title: "Captação de fotos", hours: 0 },
  { type: "gravacao", title: "Gravação", hours: 0 },
  { type: "video", title: "Edição e entrega do vídeo", hours: 3 * 24 },
];

const REMIND_DAYS_BEFORE = [2, 0];

interface Due {
  id: string;
  title: string;
  type: string;
  due_at: Date;
  is_group: boolean;
  assignee_id: string | null;
  whatsapp: string | null;
  full_name: string | null;
  event_title: string | null;
}

const line = (d: Due, today: string) => {
  const day = localDate(new Date(d.due_at));
  const when = day === today ? "*hoje*" : new Date(d.due_at).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  const hour = new Date(d.due_at).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `☐ [${MEDIA_TYPES[d.type] || d.type}] ${d.title} — ${when} ${hour}${d.event_title ? `\n   _${d.event_title}_` : ""}`;
};

export async function runMediaReminders(now = new Date()) {
  const today = localDate(now);
  const due = await query<Due>(
    `SELECT d.id, d.title, d.type, d.due_at, d.is_group, d.assignee_id, u.whatsapp, u.full_name, e.title AS event_title
       FROM media_demands d
       LEFT JOIN users u ON u.id = d.assignee_id
       LEFT JOIN events e ON e.id = d.event_id
      WHERE d.status <> 'done'
        AND (d.due_at AT TIME ZONE 'America/Sao_Paulo')::date - $1::date = ANY($2::int[])
        AND (d.reminded_on IS NULL OR d.reminded_on < $1::date)
      ORDER BY d.due_at`,
    [today, REMIND_DAYS_BEFORE]
  );
  const done: string[] = [];

  // Individuais: uma mensagem por pessoa
  const byUser = new Map<string, Due[]>();
  for (const d of due.filter((x) => !x.is_group && x.assignee_id && x.whatsapp)) {
    byUser.set(d.assignee_id!, [...(byUser.get(d.assignee_id!) || []), d]);
  }
  for (const list of byUser.values()) {
    const name = (list[0].full_name || "").split(" ")[0];
    const text = [
      `🎬 Olá${name ? `, ${name}` : ""}! Demandas da mídia perto do prazo:`,
      "",
      ...list.map((d) => line(d, today)),
      "",
      `Detalhes: ${appUrl()}/admin/midia`,
    ].join("\n");
    if (await sendDirect(list[0].whatsapp, text)) done.push(...list.map((d) => d.id));
  }

  // Do grupo: no grupo do ministério de Mídia
  const group = due.filter((d) => d.is_group);
  if (group.length) {
    const groups = (await query<{ group_jid: string }>("SELECT group_jid FROM ministries WHERE is_media AND group_jid IS NOT NULL")).map((g) => g.group_jid);
    if (groups.length) {
      const { instance } = await getReminderSettings();
      const text = ["🎬 *Demandas da mídia perto do prazo*", "", ...group.map((d) => line(d, today)), "", `Detalhes: ${appUrl()}/admin/midia`].join("\n");
      const r = await sendToGroups(instance, groups, text, "demandas da mídia");
      if (r.sent) done.push(...group.map((d) => d.id));
    }
  }

  if (done.length) await query("UPDATE media_demands SET reminded_on = $1 WHERE id = ANY($2)", [today, done]);
  return { demands: due.length, reminded: done.length };
}
