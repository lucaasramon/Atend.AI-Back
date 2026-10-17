/**
 * POPs (procedimentos operacionais padrão) por ministério.
 * No dia da recorrência, cria a execução do dia e envia o checklist no grupo do ministério.
 */
import { query, queryOne } from "../db";
import { getReminderSettings, localDate, sendToGroups } from "./reminders";
import { appUrl } from "./notify";

interface PopRow {
  id: string;
  title: string;
  description: string | null;
  steps: string[];
  link: string | null;
  recurrence: "none" | "weekly" | "monthly";
  weekday: number | null;
  month_day: number | null;
  ministry_name: string | null;
  group_jid: string | null;
}

const POP_SELECT = `
  SELECT p.*, m.name AS ministry_name, m.group_jid
    FROM pops p LEFT JOIN ministries m ON m.id = p.ministry_id`;

export function renderPop(pop: PopRow): string {
  return [
    `📋 *POP: ${pop.title}*${pop.ministry_name ? `\n_Ministério: ${pop.ministry_name}_` : ""}`,
    pop.description ? `\n${pop.description}` : "",
    "",
    ...pop.steps.map((s) => `☐ ${s}`),
    pop.link ? `\n📎 ${pop.link}` : "",
    `\nMarque o que foi feito: ${appUrl()}/admin/pops`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** O POP está programado para este dia? */
export function isPopDay(pop: Pick<PopRow, "recurrence" | "weekday" | "month_day">, day: string): boolean {
  const date = new Date(`${day}T12:00:00Z`);
  if (pop.recurrence === "weekly") return pop.weekday === date.getUTCDay();
  if (pop.recurrence === "monthly" && pop.month_day) {
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    // Dia 31 em mês de 30 dias: roda no último dia
    return date.getUTCDate() === Math.min(pop.month_day, last);
  }
  return false;
}

/** Cria (se ainda não existe) a execução do dia e envia no grupo do ministério */
export async function startPopRun(popId: string, day: string, force = false) {
  const pop = await queryOne<PopRow>(`${POP_SELECT} WHERE p.id = $1`, [popId]);
  if (!pop) throw new Error("POP não encontrado");

  await query("INSERT INTO pop_runs (pop_id, run_date) VALUES ($1, $2) ON CONFLICT DO NOTHING", [popId, day]);
  const run = await queryOne<{ id: string; sent: boolean }>(
    "SELECT id, sent FROM pop_runs WHERE pop_id = $1 AND run_date = $2",
    [popId, day]
  );
  if (run!.sent && !force) return { pop: pop.title, run_id: run!.id, status: "já enviado" };
  if (!pop.group_jid) return { pop: pop.title, run_id: run!.id, status: "sem grupo do ministério" };

  const { instance } = await getReminderSettings();
  const r = await sendToGroups(instance, [pop.group_jid], renderPop(pop), `POP ${pop.title}`);
  if (r.sent) await query("UPDATE pop_runs SET sent = true WHERE id = $1", [run!.id]);
  return { pop: pop.title, run_id: run!.id, status: r.sent ? "enviado" : "falhou", errors: r.errors };
}

/** Rodada diária: inicia os POPs programados para hoje */
export async function runPops(now = new Date()) {
  const today = localDate(now);
  const pops = await query<PopRow>(`${POP_SELECT} WHERE p.active = true AND p.recurrence <> 'none'`);
  const out = [];
  for (const pop of pops) {
    if (isPopDay(pop, today)) out.push(await startPopRun(pop.id, today));
  }
  return out;
}
