/**
 * Lembrete das tarefas de checklist: o responsável (usuário com WhatsApp) recebe
 * no privado as tarefas pendentes que vencem em 2 dias e no dia do prazo.
 */
import { query } from "../db";
import { TZ, localDate } from "./reminders";
import { appUrl, sendDirect } from "./notify";

const REMIND_DAYS_BEFORE = [2, 0];

interface DueTask {
  id: string;
  title: string;
  due_date: string;
  event_title: string;
  starts_at: Date;
  assignee_id: string;
  whatsapp: string | null;
  full_name: string | null;
}

export async function runTaskReminders(now = new Date()) {
  const today = localDate(now);
  const tasks = await query<DueTask>(
    `SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, e.title AS event_title, e.starts_at,
            t.assignee_id, u.whatsapp, u.full_name
       FROM event_tasks t
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.assignee_id
      WHERE t.done = false
        AND e.status = 'approved'
        AND e.notify_private -- lembrete no privado só se o evento pedir
        AND t.due_date - $1::date = ANY($2::int[])
        AND (t.reminded_on IS NULL OR t.reminded_on < $1::date)`,
    [today, REMIND_DAYS_BEFORE]
  );

  // Uma mensagem por pessoa com todas as tarefas dela
  const byUser = new Map<string, DueTask[]>();
  for (const t of tasks) byUser.set(t.assignee_id, [...(byUser.get(t.assignee_id) || []), t]);

  let sent = 0;
  for (const list of byUser.values()) {
    const first = list[0];
    const name = (first.full_name || "").split(" ")[0];
    const lines = list.map((t) => {
      const when = t.due_date === today ? "*hoje*" : new Date(`${t.due_date}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
      const ev = new Date(t.starts_at).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
      return `☐ ${t.title} — prazo ${when}\n   _${t.event_title} (${ev})_`;
    });
    const text = [
      `📋 Olá${name ? `, ${name}` : ""}! Você tem tarefa${list.length > 1 ? "s" : ""} perto do prazo:`,
      "",
      ...lines,
      "",
      `Marque como feito em: ${appUrl()}/admin/agenda`,
    ].join("\n");
    if (await sendDirect(first.whatsapp, text)) {
      sent++;
      await query("UPDATE event_tasks SET reminded_on = $1 WHERE id = ANY($2)", [today, list.map((t) => t.id)]);
    }
  }
  return { people: sent, tasks: tasks.length };
}
