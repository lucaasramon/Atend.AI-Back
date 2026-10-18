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

// ---------- Repetição parametrizada (formulário novo) ----------
// O evento é definido pelos parâmetros da repetição, e não por um início/término livre.

export interface RepeatSpec {
  freq: RepeatFreq;
  start_date: string; // primeira data possível (YYYY-MM-DD)
  until: string; // última data possível (YYYY-MM-DD)
  start_time: string; // HH:MM
  end_time?: string | null; // HH:MM (antes do início = termina no dia seguinte)
  interval?: number; // semanal: 1 = toda semana, 2 = a cada 2 semanas
  weekdays?: number[]; // semanal: 0 = domingo ... 6 = sábado
  month_day?: number; // mensal por dia: 1..31 (meses mais curtos usam o último dia)
  nth?: number; // mensal por semana: 1..4, 5 = última
  weekday?: number; // mensal por semana: dia da semana
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** É o formato parametrizado (tem primeira data e horário)? */
export const isRepeatSpec = (r: any): r is RepeatSpec => !!r && typeof r.start_date === "string";

export function validateRepeatSpec(r: any): string | null {
  if (!["weekly", "monthly_day", "monthly_nth"].includes(r.freq)) return "Tipo de repetição inválido";
  if (!DATE_RE.test(r.start_date || "")) return "Informe a primeira data";
  if (!DATE_RE.test(r.until || "")) return "Informe até quando repetir";
  if (r.until < r.start_date) return "A data final deve ser depois da primeira data";
  if (!TIME_RE.test(r.start_time || "")) return "Informe o horário de início";
  if (r.end_time && !TIME_RE.test(r.end_time)) return "Horário de término inválido";
  if (r.freq === "weekly") {
    if (!Array.isArray(r.weekdays) || !r.weekdays.length || !r.weekdays.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return "Escolha pelo menos um dia da semana";
    }
    if (r.interval !== undefined && !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 4)) return "Intervalo inválido";
  }
  if (r.freq === "monthly_day" && !(Number.isInteger(r.month_day) && r.month_day >= 1 && r.month_day <= 31)) return "Escolha o dia do mês";
  if (r.freq === "monthly_nth") {
    if (!(Number.isInteger(r.nth) && r.nth >= 1 && r.nth <= 5)) return "Escolha a semana do mês";
    if (!(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) return "Escolha o dia da semana";
  }
  return null;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Datas (YYYY-MM-DD) da repetição, da primeira data até a data final (máx. 2 anos / 104 datas) */
export function repeatDates(r: RepeatSpec): string[] {
  const maxDay = addDays(r.start_date, 731);
  const last = r.until < maxDay ? r.until : maxDay;
  const out: string[] = [];

  if (r.freq === "weekly") {
    const weekStart = addDays(r.start_date, -weekdayOf(r.start_date)); // domingo da 1ª semana
    const days = Array.from(new Set(r.weekdays!)).sort();
    for (let w = 0; out.length < MAX_OCCURRENCES; w += r.interval || 1) {
      const sunday = addDays(weekStart, w * 7);
      if (sunday > last) break;
      for (const d of days) {
        const day = addDays(sunday, d);
        if (day >= r.start_date && day <= last && out.length < MAX_OCCURRENCES) out.push(day);
      }
    }
    return out;
  }

  const [y0, m0] = r.start_date.split("-").map(Number);
  for (let i = 0; out.length < MAX_OCCURRENCES && i < 30; i++) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    const dim = daysInMonth(y, m);
    let day: number;
    if (r.freq === "monthly_day") {
      day = Math.min(r.month_day!, dim);
    } else {
      const firstWd = weekdayOf(ymd(y, m, 1));
      const first = 1 + ((r.weekday! - firstWd + 7) % 7);
      day = r.nth === 5 ? first + Math.floor((dim - first) / 7) * 7 : first + (r.nth! - 1) * 7;
      if (day > dim) continue; // não existe nesse mês
    }
    const date = ymd(y, m, day);
    if (date > last) break;
    if (date >= r.start_date) out.push(date);
  }
  return out;
}

/** Início e término de cada data da repetição */
export function occurrencesFromSpec(r: RepeatSpec): { starts_at: Date; ends_at: Date | null }[] {
  return repeatDates(r).map((day) => {
    const starts = new Date(`${day}T${r.start_time}:00${TZ_OFFSET}`);
    if (!r.end_time) return { starts_at: starts, ends_at: null };
    let ends = new Date(`${day}T${r.end_time}:00${TZ_OFFSET}`);
    if (ends <= starts) ends = new Date(ends.getTime() + DAY_MS); // termina no dia seguinte
    return { starts_at: starts, ends_at: ends };
  });
}
