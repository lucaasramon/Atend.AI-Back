/**
 * Resumos automáticos da agenda no WhatsApp:
 *  - mensal: no dia 1º, com os eventos do mês
 *  - semanal: na segunda-feira, com os eventos da semana (segunda a domingo)
 */
import { query } from "../db";
import { DAY_MS, TZ, TZ_OFFSET, getReminderSettings, localDate, sendToGroups } from "./reminders";
import { EVENT_COLUMNS, EventLocation, EventMinistry, locationLabel } from "./eventData";

export type SummaryKind = "monthly" | "weekly";

interface SummaryEvent {
  id: string;
  title: string;
  location: string | null;
  starts_at: Date;
  ministries?: EventMinistry[];
  locations?: EventLocation[];
}

const atLocal = (day: string, time = "00:00") => new Date(`${day}T${time}:00${TZ_OFFSET}`);
const weekday = (day: string) => atLocal(day, "12:00").getUTCDay(); // 0 = domingo

/** Período do resumo que contém o dia informado (data local YYYY-MM-DD) */
export function summaryPeriod(kind: SummaryKind, day: string): { key: string; start: Date; end: Date; title: string } {
  if (kind === "monthly") {
    const [y, m] = day.split("-").map(Number);
    const start = atLocal(`${y}-${String(m).padStart(2, "0")}-01`);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const monthName = start.toLocaleDateString("pt-BR", { timeZone: TZ, month: "long", year: "numeric" });
    return { key: `${y}-${String(m).padStart(2, "0")}`, start, end: atLocal(next), title: `🗓️ *Agenda de ${monthName}*` };
  }
  // Semana de segunda a domingo
  const offsetToMonday = (weekday(day) + 6) % 7;
  const monday = localDate(new Date(atLocal(day, "12:00").getTime() - offsetToMonday * DAY_MS));
  const start = atLocal(monday);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  const fmt = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  return { key: monday, start, end, title: `🗓️ *Agenda da semana* (${fmt(start)} a ${fmt(new Date(end.getTime() - DAY_MS))})` };
}

/** Texto do resumo; null se não houver eventos no período */
export function renderSummary(title: string, events: SummaryEvent[]): string | null {
  if (!events.length) return null;
  const lines: string[] = [title, ""];
  let lastDay = "";
  for (const ev of events) {
    const d = new Date(ev.starts_at);
    const day = d.toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
    if (day !== lastDay) {
      if (lastDay) lines.push("");
      lines.push(`*${day.charAt(0).toUpperCase()}${day.slice(1).replace(".", "")}*`);
      lastDay = day;
    }
    const hora = d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    const where = locationLabel(ev);
    lines.push(`• ${hora} — ${ev.title}${where ? ` · ${where}` : ""}`);
  }
  return lines.join("\n");
}

async function eventsBetween(start: Date, end: Date): Promise<SummaryEvent[]> {
  return query<SummaryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM events e
      WHERE e.starts_at >= $1 AND e.starts_at < $2 AND e.status = 'approved'
      ORDER BY e.starts_at`,
    [start, end]
  );
}

/** Prévia do resumo (para a tela de configuração) */
export async function previewSummary(kind: SummaryKind, day = localDate(new Date())) {
  const p = summaryPeriod(kind, day);
  const text = renderSummary(p.title, await eventsBetween(p.start, p.end));
  return { kind, period: p.key, text };
}

async function sendSummary(kind: SummaryKind, day: string, instance: string, mainGroup: string) {
  const p = summaryPeriod(kind, day);
  const claimed = await query(
    "INSERT INTO summaries_sent (kind, period) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING kind",
    [kind, p.key]
  );
  if (!claimed.length) return { kind, period: p.key, status: "já enviado" };

  const events = await eventsBetween(p.start, p.end);
  const text = renderSummary(p.title, events);
  if (!text) return { kind, period: p.key, status: "sem eventos" };

  // Grupo principal: resumo completo
  const r = await sendToGroups(instance, [mainGroup], text, `resumo ${kind}`);
  if (!r.sent) {
    // Ninguém recebeu: libera para a próxima tentativa
    await query("DELETE FROM summaries_sent WHERE kind = $1 AND period = $2", [kind, p.key]);
    throw new Error(r.errors.join("; ") || "resumo não enviado");
  }

  // Cada ministério com grupo próprio: só os eventos dele
  const byGroup = new Map<string, { name: string; events: SummaryEvent[] }>();
  for (const ev of events) {
    for (const m of ev.ministries || []) {
      if (!m.group_jid || m.group_jid === mainGroup) continue;
      const entry = byGroup.get(m.group_jid) || { name: m.name, events: [] };
      if (!entry.events.includes(ev)) entry.events.push(ev); // dois ministérios no mesmo grupo
      byGroup.set(m.group_jid, entry);
    }
  }
  let ministries = 0;
  for (const [group, { name, events: list }] of byGroup) {
    const t = renderSummary(`${p.title}
_Ministério: ${name}_`, list);
    const mr = await sendToGroups(instance, [group], t!, `resumo ${kind} ${name}`);
    ministries += mr.sent;
    r.errors.push(...mr.errors);
  }
  return { kind, period: p.key, status: "enviado", ministries, errors: r.errors };
}

/** Rodada diária: manda o resumo mensal no dia 1º e o semanal na segunda-feira */
export async function runSummaries(now = new Date()) {
  const cfg = await getReminderSettings();
  if (!cfg.enabled || !cfg.instance || !cfg.groupJid) return [];

  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM system_settings WHERE key IN ('summary_monthly_enabled', 'summary_weekly_enabled')"
  );
  const on = (k: string) => rows.find((r) => r.key === k)?.value !== "false";

  const today = localDate(now);
  const out = [];
  if (on("summary_monthly_enabled") && today.endsWith("-01")) {
    out.push(await sendSummary("monthly", today, cfg.instance, cfg.groupJid));
  }
  if (on("summary_weekly_enabled") && weekday(today) === 1) {
    out.push(await sendSummary("weekly", today, cfg.instance, cfg.groupJid));
  }
  return out;
}
