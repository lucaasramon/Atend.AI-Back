/**
 * Lembretes de eventos no grupo do WhatsApp.
 * Roda 1x por dia (REMINDERS_TIME, horário de Brasília) e envia, para cada evento,
 * um aviso em cada antecedência configurada (reminders_offsets, em dias; 0 = no dia).
 */
import { query } from "../db";
import { sendText } from "./evolution";

const TZ = "America/Sao_Paulo";
const TZ_OFFSET = "-03:00"; // Brasil sem horário de verão desde 2019
const RUN_TIME = /^\d{2}:\d{2}$/.test(process.env.REMINDERS_TIME || "") ? process.env.REMINDERS_TIME! : "08:00";
const DAY_MS = 24 * 60 * 60_000;

export interface ReminderSettings {
  enabled: boolean;
  instance: string;
  groupJid: string;
  offsets: number[];
  template: string;
}

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
}

export async function getReminderSettings(): Promise<ReminderSettings> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM system_settings WHERE key LIKE 'reminders_%'"
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
  const offsets = (s.reminders_offsets || "")
    .split(",")
    .map((v) => parseInt(v.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);

  return {
    enabled: s.reminders_enabled === "true",
    instance: s.reminders_instance || "",
    groupJid: s.reminders_group_jid || "",
    offsets,
    template: s.reminders_template || "📅 Lembrete: {titulo} — {data} às {hora}. {quando}",
  };
}

/** Grupos que podem receber mensagens do robô (system_settings.allowed_groups) */
export async function getAllowedGroups(): Promise<string[]> {
  const rows = await query<{ value: string }>("SELECT value FROM system_settings WHERE key = 'allowed_groups'");
  return (rows[0]?.value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

/** Data local (Brasília) no formato YYYY-MM-DD */
function localDate(d: Date): string {
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
    .replace(/\{local\}/g, ev.location || "a definir")
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

  if (!cfg.enabled || !cfg.instance || !cfg.offsets.length) return result;

  const events = await query<EventRow & { group_jid: string | null; sent_offsets: number[] }>(
    `SELECT e.id, e.title, e.description, e.location, e.starts_at, e.group_jid,
            COALESCE(array_agg(r.offset_days) FILTER (WHERE r.offset_days IS NOT NULL), '{}') AS sent_offsets
       FROM events e
       LEFT JOIN event_reminders_sent r ON r.event_id = e.id
      WHERE e.starts_at > NOW()
        AND e.starts_at <= NOW() + make_interval(days => $1)
      GROUP BY e.id`,
    [cfg.offsets[0] + 1]
  );

  const allowed = await getAllowedGroups();
  const now = new Date();
  for (const ev of events) {
    // Grupo do evento; se não tiver, usa o grupo padrão
    const groupJid = ev.group_jid || cfg.groupJid;
    if (!groupJid) continue;
    if (!allowed.includes(groupJid)) {
      result.errors.push(`${ev.title}: grupo ${groupJid} não está em allowed_groups`);
      continue;
    }

    const daysUntil = daysBetween(now, new Date(ev.starts_at));
    const due = cfg.offsets.filter((off) => daysUntil <= off && !ev.sent_offsets.includes(off));
    if (!due.length) continue;

    const toSend = Math.min(...due);
    const toSkip = due.filter((off) => off !== toSend);

    // Reserva o envio antes de mandar (evita duplicidade se duas rodadas coincidirem)
    const claimed = await query(
      `INSERT INTO event_reminders_sent (event_id, offset_days, status)
       VALUES ($1, $2, 'sent') ON CONFLICT DO NOTHING RETURNING event_id`,
      [ev.id, toSend]
    );
    if (!claimed.length) continue;

    try {
      await sendText(cfg.instance, groupJid, renderMessage(cfg.template, ev, daysUntil));
      result.sent++;
    } catch (err: any) {
      // Libera a reserva para tentar de novo na próxima rodada
      await query("DELETE FROM event_reminders_sent WHERE event_id = $1 AND offset_days = $2", [ev.id, toSend]);
      result.errors.push(`${ev.title}: ${err.message}`);
      continue;
    }

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

/** Próximo horário de execução (hoje ou amanhã às RUN_TIME, Brasília) */
function nextRunAt(now: Date): Date {
  const today = new Date(`${localDate(now)}T${RUN_TIME}:00${TZ_OFFSET}`);
  return today > now ? today : new Date(today.getTime() + DAY_MS);
}

/** true se a rodada de hoje (RUN_TIME) já passou */
export function isPastTodayRun(now = new Date()): boolean {
  return now >= new Date(`${localDate(now)}T${RUN_TIME}:00${TZ_OFFSET}`);
}

const RETRY_MS = 5 * 60_000;
const MAX_RETRIES = 6;

async function tick(attempt = 0) {
  try {
    const r = await runReminders();
    console.log(`[reminders] rodada concluída: enviados=${r.sent} pulados=${r.skipped} erros=${r.errors.length}`, r.errors);
  } catch (err) {
    console.error("[reminders] falha na rodada:", err);
    // Falha de infraestrutura (ex.: banco reiniciando): tenta de novo em alguns minutos
    if (attempt < MAX_RETRIES) {
      console.log(`[reminders] nova tentativa em 5 min (${attempt + 1}/${MAX_RETRIES})`);
      setTimeout(() => tick(attempt + 1), RETRY_MS);
    }
  }
}

/**
 * Chamado ao criar/editar um evento: se a rodada de hoje já passou, roda agora
 * para que lembretes já vencidos (ex.: evento de hoje à tarde) não fiquem para amanhã.
 */
export function runRemindersIfPastToday() {
  if (!isPastTodayRun()) return;
  tick();
}

function scheduleNext() {
  const next = nextRunAt(new Date());
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, next.getTime() - Date.now());
  console.log(`[reminders] próxima rodada: ${next.toLocaleString("pt-BR", { timeZone: TZ })}`);
}

export function startReminderJob() {
  // Se o servidor subir depois do horário do dia, roda já (recupera envios perdidos; não duplica)
  if (isPastTodayRun()) setTimeout(tick, 10_000);
  scheduleNext();
}
