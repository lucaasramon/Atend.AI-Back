/**
 * Agendador das tarefas automáticas.
 * Tarefas diárias rodam 1x por dia (REMINDERS_TIME, horário de Brasília);
 * cada uma é independente e idempotente (pode rodar de novo sem duplicar envios).
 */
import { RUN_TIME, TZ, TZ_OFFSET, localDate, runReminders } from "./reminders";
import { runSummaries } from "./summaries";
import { runTaskReminders } from "./tasks";
import { runPops } from "./pops";
import { runMediaReminders } from "./media";
import { runEscalations } from "./acks";
import { runRosterGroups, runRosterNotifications } from "./roster";

const DAY_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_RETRIES = 6;

type Job = { name: string; run: () => Promise<unknown> };

// Ordem de execução da rodada diária
const DAILY_JOBS: Job[] = [
  { name: "lembretes", run: runReminders },
  { name: "resumos", run: runSummaries },
  { name: "tarefas", run: runTaskReminders },
  { name: "pops", run: runPops },
  { name: "mídia", run: runMediaReminders },
  { name: "escalas", run: runRosterNotifications },
  { name: "escalas nos grupos", run: runRosterGroups },
];

const HOUR_MS = 60 * 60_000;

/** true se a rodada de hoje (RUN_TIME) já passou */
export function isPastTodayRun(now = new Date()): boolean {
  return now >= new Date(`${localDate(now)}T${RUN_TIME}:00${TZ_OFFSET}`);
}

/** Roda todas as tarefas; se alguma falhar por infraestrutura, tenta de novo em 5 min */
async function tick(attempt = 0) {
  let failed = false;
  for (const job of DAILY_JOBS) {
    try {
      const r = await job.run();
      console.log(`[agendador] ${job.name}:`, JSON.stringify(r));
    } catch (err) {
      failed = true;
      console.error(`[agendador] falha em ${job.name}:`, err);
    }
  }
  if (failed && attempt < MAX_RETRIES) {
    console.log(`[agendador] nova tentativa em 5 min (${attempt + 1}/${MAX_RETRIES})`);
    setTimeout(() => tick(attempt + 1), RETRY_MS);
  }
}

/**
 * Chamado ao criar/editar um evento: se a rodada de hoje já passou, roda agora
 * para que lembretes já vencidos (ex.: evento de hoje à tarde) não fiquem para amanhã.
 */
export function runRemindersIfPastToday() {
  if (!isPastTodayRun()) return;
  runReminders()
    .then((r) => console.log("[agendador] lembretes (evento salvo):", JSON.stringify(r)))
    .catch((err) => console.error("[agendador] falha nos lembretes (evento salvo):", err));
}

function nextRunAt(now: Date): Date {
  const today = new Date(`${localDate(now)}T${RUN_TIME}:00${TZ_OFFSET}`);
  return today > now ? today : new Date(today.getTime() + DAY_MS);
}

// Começa num momento aleatório dentro desta janela (ex.: entre 08:00 e 08:10), para não ser sempre o mesmo segundo
const JITTER_MS = (parseFloat(process.env.REMINDERS_JITTER_MIN || "10") || 0) * 60_000;

function scheduleNext() {
  const next = new Date(nextRunAt(new Date()).getTime() + Math.random() * JITTER_MS);
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, next.getTime() - Date.now());
  console.log(`[agendador] próxima rodada: ${next.toLocaleString("pt-BR", { timeZone: TZ })}`);
}

/** Escalonamento das confirmações: confere a cada hora os prazos vencidos */
function startHourly() {
  setInterval(() => {
    runEscalations()
      .then((r) => r.escalated && console.log("[agendador] confirmações:", JSON.stringify(r)))
      .catch((err) => console.error("[agendador] falha no escalonamento:", err));
  }, HOUR_MS);
}

export function startScheduler() {
  startHourly();
  // Se o servidor subir depois do horário do dia, roda já (recupera envios perdidos; não duplica)
  if (isPastTodayRun()) setTimeout(() => tick(), 10_000);
  scheduleNext();
}
