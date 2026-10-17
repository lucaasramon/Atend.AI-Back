/**
 * Datas de eventos recorrentes (horário de Brasília).
 *   weekly        — a cada `interval` semanas (1 = toda semana, 2 = quinzenal)
 *   monthly_day   — todo mês no mesmo dia (pula meses sem esse dia, ex.: 31)
 *   monthly_nth   — todo mês na mesma "N-ésima semana" (ex.: toda 1ª sexta; 5ª vira "última")
 */
import { DAY_MS, TZ_OFFSET, localDate } from "./reminders";

export type RepeatFreq = "weekly" | "monthly_day" | "monthly_nth";

export interface Repeat {
  freq: RepeatFreq;
  interval?: number;
  until: string; // YYYY-MM-DD (inclusive)
}

export const MAX_OCCURRENCES = 104;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Hora local HH:MM de um instante */
function localTime(d: Date): string {
  return d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function validateRepeat(r: any): string | null {
  if (!r) return null;
  if (!["weekly", "monthly_day", "monthly_nth"].includes(r.freq)) return "Tipo de repetição inválido";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.until || "")) return "Informe até quando repetir";
  if (r.interval !== undefined && !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 4)) return "Intervalo inválido";
  return null;
}

/**
 * Lista de [início, término] de cada ocorrência, incluindo a primeira.
 * Limita a 2 anos e MAX_OCCURRENCES ocorrências.
 */
export function occurrences(start: Date, end: Date | null, repeat: Repeat): { starts_at: Date; ends_at: Date | null }[] {
  const firstDay = localDate(start);
  const time = localTime(start);
  const duration = end ? end.getTime() - start.getTime() : null;
  const limit = new Date(start.getTime() + 731 * DAY_MS);
  const until = new Date(`${repeat.until}T23:59:59${TZ_OFFSET}`);
  const stop = until < limit ? until : limit;

  const days: string[] = [];
  const [y0, m0, d0] = firstDay.split("-").map(Number);

  if (repeat.freq === "weekly") {
    const step = 7 * (repeat.interval || 1) * DAY_MS;
    for (let t = Date.parse(`${firstDay}T12:00:00Z`); days.length < MAX_OCCURRENCES; t += step) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
  } else {
    const wd = weekdayOf(firstDay);
    const nth = Math.ceil(d0 / 7); // 1..5
    for (let i = 0; days.length < MAX_OCCURRENCES && i < 30; i++) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      if (repeat.freq === "monthly_day") {
        if (d0 <= daysInMonth(y, m)) days.push(ymd(y, m, d0));
      } else {
        // N-ésimo dia da semana do mês; se não existir (5ª), usa o último
        const firstWd = weekdayOf(ymd(y, m, 1));
        let day = 1 + ((wd - firstWd + 7) % 7) + (nth - 1) * 7;
        while (day > daysInMonth(y, m)) day -= 7;
        days.push(ymd(y, m, day));
      }
    }
  }

  return days
    .map((day) => new Date(`${day}T${time}:00${TZ_OFFSET}`))
    .filter((s) => s >= start && s <= stop)
    .map((s) => ({ starts_at: s, ends_at: duration !== null ? new Date(s.getTime() + duration) : null }));
}
