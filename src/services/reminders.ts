/**
 * Lembretes de eventos no WhatsApp.
 * Para cada evento, envia um aviso em cada antecedência (em dias; 0 = no dia):
 * as do próprio evento (events.reminder_offsets) ou o padrão (reminders_offsets).
 */
import { query } from "../db";
import { sendText } from "./evolution";
import { EVENT_COLUMNS, EventLocation, EventMinistry, locationLabel } from "./eventData";

export const TZ = "America/Sao_Paulo";
export const TZ_OFFSET = "-03:00"; // Brasil sem horário de verão desde 2019
export const RUN_TIME = /^\d{2}:\d{2}$/.test(process.env.REMINDERS_TIME || "") ? process.env.REMINDERS_TIME! : "08:00";
export const DAY_MS = 24 * 60 * 60_000;

export interface ReminderSettings {
  enabled: boolean;
  instance: string;
  groupJid: string;
  offsets: number[];
  template: string;
}

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  group_jid?: string | null;
  reminder_offsets?: number[] | null;
  ministries?: EventMinistry[];
  locations?: EventLocation[];
}

/** "30, 7,0" → [30, 7, 0] (maior para menor, sem repetidos) */
export function parseOffsets(v: string | number[] | null | undefined): number[] {
  const list = Array.isArray(v) ? v : (v || "").split(",").map((x) => parseInt(x.trim()));
  return Array.from(new Set(list.filter((n) => Number.isFinite(n) && n >= 0 && n <= 366))).sort((a, b) => b - a);
}

export async function getReminderSettings(): Promise<ReminderSettings> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM system_settings WHERE key LIKE 'reminders_%'"
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
  return {
    enabled: s.reminders_enabled === "true",
    instance: s.reminders_instance || "",
    groupJid: s.reminders_group_jid || "",
    offsets: parseOffsets(s.reminders_offsets),
    template: s.reminders_template || "📅 Lembrete: {titulo} — {data} às {hora}. {quando}",
  };
}

/** Antecedências do evento: as próprias, se tiver; senão o padrão */
export function eventOffsets(ev: Pick<EventRow, "reminder_offsets">, cfg: ReminderSettings): number[] {
  const own = parseOffsets(ev.reminder_offsets);
  return own.length ? own : cfg.offsets;
}

/** Grupos que podem receber mensagens do robô (system_settings.allowed_groups) */
export async function getAllowedGroups(): Promise<string[]> {
  const rows = await query<{ value: string }>("SELECT value FROM system_settings WHERE key = 'allowed_groups'");
  return (rows[0]?.value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Grupos que recebem os avisos de um evento:
 * grupo principal (pastores) + grupos dos ministérios do evento + grupo extra do evento
 */
export function eventTargets(ev: EventRow, cfg: ReminderSettings): string[] {
  const groups = [cfg.groupJid, ...(ev.ministries || []).map((m) => m.group_jid), ev.group_jid];
  return Array.from(new Set(groups.filter(Boolean))) as string[];
}

/**
 * Envia o texto para cada grupo permitido.
 * Retorna quantos receberam e os erros (grupo bloqueado ou falha de envio).
 */
export async function sendToGroups(
  instance: string,
  groups: string[],
  text: string,
  label: string
): Promise<{ sent: number; errors: string[] }> {
  const allowed = await getAllowedGroups();
  const out = { sent: 0, errors: [] as string[] };
  for (const g of groups) {
    if (!allowed.includes(g)) {
      out.errors.push(`${label}: grupo ${g} não está liberado`);
      continue;
    }
    try {
      await sendText(instance, g, text);
      out.sent++;
    } catch (err: any) {
      out.errors.push(`${label}: ${err.message}`);
    }
  }
  return out;
}

/** Data local (Brasília) no formato YYYY-MM-DD */
export function localDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Quantos dias de calendário (Brasília) faltam de `from` até `to` */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.parse(localDate(to)) - Date.parse(localDate(from))) / DAY_MS);
}

/** 0 → "É hoje!", 1 → "Falta 1 dia.", 7 → "Faltam 7 dias." */
export function formatWhen(days: number): string {
  if (days <= 0) return "É hoje!";
  if (days === 1) return "Falta 1 dia.";
  return `Faltam ${days} dias.`;
}

export function renderMessage(template: string, ev: EventRow, daysUntil: number): string {
  const start = new Date(ev.starts_at);
  const data = start.toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = start.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

  return template
    .replace(/\{titulo\}/g, ev.title)
    .replace(/\{data\}/g, data)
    .replace(/\{hora\}/g, hora)
    .replace(/\{local\}/g, locationLabel(ev) || "a definir")
    .replace(/\{descricao\}/g, ev.description || "")
    .replace(/\{quando\}/g, formatWhen(daysUntil))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Momento em que o lembrete de `offsetDays` será enviado para um evento */
export function reminderSendAt(startsAt: Date, offsetDays: number): Date {
  const day = new Date(Date.parse(localDate(startsAt)) - offsetDays * DAY_MS).toISOString().slice(0, 10);
  return new Date(`${day}T${RUN_TIME}:00${TZ_OFFSET}`);
}

/**
 * Executa uma rodada: envia os lembretes vencidos e ainda não enviados.
 * Se várias antecedências já venceram (evento cadastrado em cima da hora ou servidor
 * fora do ar), envia uma única mensagem e marca as demais como "skipped".
 */
export async function runReminders(): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const result = { sent: 0, skipped: 0, errors: [] as string[] };
  const cfg = await getReminderSettings();

  if (!cfg.enabled || !cfg.instance) return result;

  const events = await query<EventRow & { sent_offsets: number[] }>(
    `SELECT ${EVENT_COLUMNS},
            COALESCE((SELECT array_agg(r.offset_days) FROM event_reminders_sent r WHERE r.event_id = e.id), '{}') AS sent_offsets
       FROM events e
      WHERE e.starts_at > NOW() AND e.status = 'approved'`
  );

  const now = new Date();
  for (const ev of events) {
    const daysUntil = daysBetween(now, new Date(ev.starts_at));
    const due = eventOffsets(ev, cfg).filter((off) => daysUntil <= off && !ev.sent_offsets.includes(off));
    if (!due.length) continue;

    const targets = eventTargets(ev, cfg);
    if (!targets.length) continue;

    const toSend = Math.min(...due);
    const toSkip = due.filter((off) => off !== toSend);

    // Reserva o envio antes de mandar (evita duplicidade se duas rodadas coincidirem)
    const claimed = await query(
      `INSERT INTO event_reminders_sent (event_id, offset_days, status)
       VALUES ($1, $2, 'sent') ON CONFLICT DO NOTHING RETURNING event_id`,
      [ev.id, toSend]
    );
    if (!claimed.length) continue;

    const r = await sendToGroups(cfg.instance, targets, renderMessage(cfg.template, ev, daysUntil), ev.title);
    result.errors.push(...r.errors);
    if (!r.sent) {
      // Nenhum grupo recebeu: libera a reserva para tentar de novo na próxima rodada
      await query("DELETE FROM event_reminders_sent WHERE event_id = $1 AND offset_days = $2", [ev.id, toSend]);
      continue;
    }
    result.sent++;

    for (const off of toSkip) {
      await query(
        `INSERT INTO event_reminders_sent (event_id, offset_days, status)
         VALUES ($1, $2, 'skipped') ON CONFLICT DO NOTHING`,
        [ev.id, off]
      );
      result.skipped++;
    }
  }

  return result;
}
