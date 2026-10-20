/**
 * Parabéns automáticos: na rodada diária, manda no WhatsApp de cada aniversariante do dia
 * (pessoas de Cadastros com data de nascimento) uma mensagem em nome da igreja, com um versículo.
 * Entre um envio e outro espera um intervalo aleatório (birthday_gap_min..max minutos),
 * para o robô não disparar várias mensagens seguidas.
 */
import { query, queryOne } from "../db";
import { sendText } from "./evolution";
import { getReminderSettings, localDate } from "./reminders";

/** Não começa envios depois deste horário (ex.: servidor reiniciou à noite) */
const LAST_HOUR = 20;

export const VERSES = [
  "“Porque sou eu que conheço os planos que tenho para vocês, diz o Senhor, planos de fazê-los prosperar e não de causar dano, planos de dar a vocês esperança e um futuro.” (Jeremias 29:11)",
  "“Ensina-nos a contar os nossos dias, para que alcancemos coração sábio.” (Salmos 90:12)",
  "“Deleite-se no Senhor, e ele atenderá aos desejos do seu coração.” (Salmos 37:4)",
  "“Este é o dia que o Senhor fez; regozijemo-nos e alegremo-nos nele.” (Salmos 118:24)",
  "“Eu te louvo porque me fizeste de modo especial e admirável.” (Salmos 139:14)",
  "“As misericórdias do Senhor são a causa de não sermos consumidos, porque as suas misericórdias não têm fim; renovam-se cada manhã.” (Lamentações 3:22-23)",
  "“O Senhor é o meu pastor; nada me faltará.” (Salmos 23:1)",
];

export const DEFAULT_TEMPLATE = [
  "🎉 Feliz aniversário, {nome}! 🎂",
  "",
  "Hoje a {igreja} celebra a sua vida! Agradecemos a Deus por cada dia que Ele te deu e pelo privilégio de caminhar ao seu lado.",
  "",
  "📖 {versiculo}",
  "",
  "Que neste novo ano o Senhor renove as suas forças, encha o seu coração de paz e te surpreenda com a Sua graça. Você é muito especial para Deus e para nós!",
  "",
  "Com carinho,",
  "*{igreja}* 💙",
].join("\n");

export interface BirthdaySettings {
  enabled: boolean;
  church: string;
  gapMin: number;
  gapMax: number;
  template: string; // "" = padrão
  verse: string; // "" = sorteia um de VERSES; senão usa sempre este
}

export async function getBirthdaySettings(): Promise<BirthdaySettings> {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM system_settings WHERE key LIKE 'birthday_%'");
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
  const gapMin = Math.max(0, parseFloat(s.birthday_gap_min ?? "3") || 0);
  return {
    enabled: s.birthday_enabled !== "false",
    church: s.birthday_church || "Igreja Cristã Despertar",
    gapMin,
    gapMax: Math.max(gapMin, parseFloat(s.birthday_gap_max ?? "10") || 0),
    template: s.birthday_template || "",
    verse: s.birthday_verse || "",
  };
}

const randomVerse = () => VERSES[Math.floor(Math.random() * VERSES.length)];

export function renderBirthday(cfg: Pick<BirthdaySettings, "church" | "template" | "verse">, fullName: string, verse = cfg.verse || randomVerse()): string {
  const first = fullName.trim().split(/\s+/)[0] || fullName;
  return (cfg.template || DEFAULT_TEMPLATE)
    .replace(/\{nome\}/g, first)
    .replace(/\{igreja\}/g, cfg.church)
    .replace(/\{versiculo\}/g, verse)
    .trim();
}

interface BirthdayPerson {
  id: string;
  name: string;
  whatsapp: string;
  birth_date: string;
  sent_at: Date | null;
}

/**
 * Aniversariantes de hoje (horário de Brasília). Quem nasceu em 29/02 recebe no dia 28/02
 * nos anos que não são bissextos.
 */
export async function birthdaysToday(now = new Date()): Promise<BirthdayPerson[]> {
  const today = localDate(now); // YYYY-MM-DD
  const year = Number(today.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [today.slice(5)];
  if (!leap && today.slice(5) === "02-28") days.push("02-29");
  return query<BirthdayPerson>(
    `SELECT p.id, p.name, p.whatsapp, to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, b.sent_at
       FROM people p
       LEFT JOIN birthday_messages b ON b.person_id = p.id AND b.year = $2
      WHERE p.birth_date IS NOT NULL AND to_char(p.birth_date, 'MM-DD') = ANY($1)
      ORDER BY p.name`,
    [days, year]
  );
}

let running = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rodada diária. Retorna logo (os envios seguem em segundo plano, um a cada intervalo),
 * para não segurar as outras tarefas do agendador.
 */
export async function runBirthdays(now = new Date()) {
  const cfg = await getBirthdaySettings();
  if (!cfg.enabled) return { enabled: false };
  const hour = Number(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }));
  if (hour >= LAST_HOUR) return { skipped: `depois das ${LAST_HOUR}h` };
  if (running) return { skipped: "envio já em andamento" };

  const pending = (await birthdaysToday(now)).filter((p) => !p.sent_at);
  if (!pending.length) return { today: 0 };

  running = true;
  sendAll(pending, Number(localDate(now).slice(0, 4)))
    .catch((err) => console.error("[aniversários] falha:", err))
    .finally(() => {
      running = false;
    });
  return { pending: pending.length, gap_min: cfg.gapMin, gap_max: cfg.gapMax };
}

async function sendAll(people: BirthdayPerson[], year: number) {
  const { instance } = await getReminderSettings();
  if (!instance) throw new Error("robô sem instância configurada");
  for (let i = 0; i < people.length; i++) {
    const cfg = await getBirthdaySettings(); // relê: se desligarem no meio, para
    if (!cfg.enabled) return;
    if (i > 0) await sleep((cfg.gapMin + Math.random() * (cfg.gapMax - cfg.gapMin)) * 60_000);

    const p = people[i];
    // Marca antes de enviar: se outra rodada pegar a mesma pessoa, não duplica
    const claimed = await queryOne("INSERT INTO birthday_messages (person_id, year) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1", [p.id, year]);
    if (!claimed) continue;
    try {
      await sendText(instance, p.whatsapp, renderBirthday(cfg, p.name));
      await query("UPDATE birthday_messages SET sent_at = NOW() WHERE person_id = $1 AND year = $2", [p.id, year]);
      console.log(`[aniversários] parabéns enviado para ${p.name}`);
    } catch (err: any) {
      // Libera para tentar de novo na próxima rodada
      await query("DELETE FROM birthday_messages WHERE person_id = $1 AND year = $2", [p.id, year]).catch(() => {});
      console.error(`[aniversários] falha ao enviar para ${p.name}:`, err.message);
    }
  }
}

/** Envio em andamento agora? (para a tela mostrar "na fila") */
export const birthdaysRunning = () => running;
