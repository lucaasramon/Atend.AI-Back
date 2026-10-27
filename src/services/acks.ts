/**
 * Confirmação de visualização com escalonamento.
 * Evento aprovado com ministérios → o líder de cada ministério confirma que viu (link no WhatsApp).
 * Sem confirmação no prazo (ack_hours): avisa o pastor responsável; depois, os administradores.
 * Uma confirmação em qualquer nível encerra a cadeia daquele evento + ministério.
 */
import crypto from "crypto";
import { query, queryOne } from "../db";
import { TZ } from "./reminders";
import { adminIds, appUrl, sendDirect } from "./notify";

export const hashAckToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

const LEVEL_LABEL: Record<number, string> = { 1: "líder", 2: "pastor responsável", 3: "administrador" };

async function settings(): Promise<{ enabled: boolean; hours: number }> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM system_settings WHERE key IN ('ack_enabled', 'ack_hours')"
  );
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const hours = parseInt(get("ack_hours") || "48");
  return { enabled: get("ack_enabled") !== "false", hours: Number.isFinite(hours) && hours > 0 ? hours : 48 };
}

interface NewAck {
  event_id: string;
  ministry_id: string;
  level: number;
  user_id: string;
}

/** Cria as confirmações e retorna o token (em texto) de cada uma */
async function createAcks(list: NewAck[], hours: number): Promise<(NewAck & { id: string; token: string })[]> {
  const out = [];
  for (const a of list) {
    const token = crypto.randomBytes(24).toString("hex");
    const row = await queryOne<{ id: string }>(
      `INSERT INTO acknowledgements (event_id, ministry_id, level, user_id, token_hash, deadline)
       VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(hours => $6)) RETURNING id`,
      [a.event_id, a.ministry_id, a.level, a.user_id, hashAckToken(token), hours]
    );
    out.push({ ...a, id: row!.id, token });
  }
  return out;
}

/** Uma mensagem por pessoa com todos os eventos que ela precisa confirmar */
async function sendAckMessages(acks: (NewAck & { id: string; token: string })[], hours: number, escalation: boolean) {
  const byUser = new Map<string, typeof acks>();
  for (const a of acks) byUser.set(a.user_id, [...(byUser.get(a.user_id) || []), a]);

  for (const [userId, list] of byUser) {
    const user = await queryOne<{ full_name: string | null; whatsapp: string | null }>(
      "SELECT full_name, whatsapp FROM users WHERE id = $1",
      [userId]
    );
    const details = await query<{ title: string; starts_at: Date; ministry: string; leader: string | null }>(
      `SELECT e.title, e.starts_at, m.name AS ministry, l.full_name AS leader
         FROM acknowledgements a
         JOIN events e ON e.id = a.event_id
         JOIN ministries m ON m.id = a.ministry_id
         LEFT JOIN users l ON l.id = m.leader_id
        WHERE a.id = ANY($1) ORDER BY e.starts_at`,
      [list.map((a) => a.id)]
    );
    const name = (user?.full_name || "").split(" ")[0];
    const lines = details.map((d) => {
      const when = new Date(d.starts_at).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `• ${when} — *${d.title}* (${d.ministry})`;
    });
    const level = list[0].level;
    const header = escalation
      ? `⚠️ Olá${name ? `, ${name}` : ""}! ${level === 2 ? `O líder${details[0]?.leader ? ` ${details[0].leader}` : ""}` : "O líder e o pastor responsável"} ainda não confirmou que viu ${list.length > 1 ? "estes eventos" : "este evento"}. Como ${LEVEL_LABEL[level]}, confirme você:`
      : `📌 Olá${name ? `, ${name}` : ""}! ${list.length > 1 ? `Há ${list.length} eventos` : "Há um evento"} do seu ministério na agenda. Confirme que viu:`;
    const text = [header, "", ...lines, "", `✅ Confirmar: ${appUrl()}/confirmar?token=${list[0].token}`, `Prazo: ${hours}h`].join("\n");

    if (await sendDirect(user?.whatsapp, text)) {
      await query("UPDATE acknowledgements SET sent = true WHERE id = ANY($1)", [list.map((a) => a.id)]);
    }
  }
}

/**
 * Chamado quando eventos são aprovados (ou criados já aprovados por um admin).
 * Em séries, só a primeira data pede confirmação (para não enviar uma mensagem por semana).
 */
export async function onEventsApproved(eventIds: string[]) {
  if (!eventIds.length) return;
  const cfg = await settings();
  if (!cfg.enabled) return;

  const rows = await query<{ event_id: string; ministry_id: string; leader_id: string | null; pastor_id: string | null }>(
    `SELECT DISTINCT ON (COALESCE(e.series_id, e.id), m.id)
            e.id AS event_id, m.id AS ministry_id, m.leader_id, m.pastor_id
       FROM events e
       JOIN event_ministries em ON em.event_id = e.id
       JOIN ministries m ON m.id = em.ministry_id
      WHERE e.id = ANY($1) AND e.status = 'approved' AND e.starts_at > NOW()
        AND e.notify_private -- só eventos marcados para avisar no privado
        AND NOT EXISTS (SELECT 1 FROM acknowledgements a WHERE a.event_id = e.id AND a.ministry_id = m.id)
      ORDER BY COALESCE(e.series_id, e.id), m.id, e.starts_at`,
    [eventIds]
  );

  // Começa no líder; sem líder, no pastor; sem nenhum dos dois, não há a quem pedir
  const list: NewAck[] = rows
    .map((r) => ({
      event_id: r.event_id,
      ministry_id: r.ministry_id,
      level: r.leader_id ? 1 : 2,
      user_id: (r.leader_id || r.pastor_id)!,
    }))
    .filter((a) => a.user_id);

  await sendAckMessages(await createAcks(list, cfg.hours), cfg.hours, false);
}

/** Rodada horária: escala as confirmações vencidas para o próximo nível */
export async function runEscalations() {
  const cfg = await settings();
  if (!cfg.enabled) return { escalated: 0 };

  const overdue = await query<{ id: string; event_id: string; ministry_id: string; level: number; pastor_id: string | null; leader_id: string | null }>(
    `SELECT a.id, a.event_id, a.ministry_id, a.level, m.pastor_id, m.leader_id
       FROM acknowledgements a
       JOIN ministries m ON m.id = a.ministry_id
       JOIN events e ON e.id = a.event_id
      WHERE a.confirmed_at IS NULL AND a.escalated = false AND a.deadline < NOW()
        AND e.starts_at > NOW() AND e.status = 'approved' AND e.notify_private
        -- ninguém da cadeia confirmou
        AND NOT EXISTS (SELECT 1 FROM acknowledgements c
                         WHERE c.event_id = a.event_id AND c.ministry_id = a.ministry_id AND c.confirmed_at IS NOT NULL)`
  );

  const next: NewAck[] = [];
  for (const a of overdue) {
    await query("UPDATE acknowledgements SET escalated = true WHERE id = $1", [a.id]);
    if (a.level === 1 && a.pastor_id && a.pastor_id !== a.leader_id) {
      next.push({ event_id: a.event_id, ministry_id: a.ministry_id, level: 2, user_id: a.pastor_id });
    } else if (a.level <= 2) {
      // Sem pastor (ou já era o pastor): vai para os administradores
      for (const id of await adminIds()) next.push({ event_id: a.event_id, ministry_id: a.ministry_id, level: 3, user_id: id });
    }
    // Nível 3 vencido: fica registrado como não confirmado no painel
  }

  // Agrupa por nível para a mensagem sair com o texto certo
  for (const level of [2, 3]) {
    const items = next.filter((n) => n.level === level);
    if (items.length) await sendAckMessages(await createAcks(items, cfg.hours), cfg.hours, true);
  }
  return { escalated: overdue.length, created: next.length };
}

/** Pendências da pessoa dona do token (para a tela de confirmação) */
export async function ackInfo(token: string) {
  const owner = await queryOne<{ user_id: string; full_name: string | null }>(
    `SELECT a.user_id, u.full_name FROM acknowledgements a JOIN users u ON u.id = a.user_id WHERE a.token_hash = $1`,
    [hashAckToken(token)]
  );
  if (!owner) return null;
  const pending = await query(
    `SELECT a.id, e.title, e.starts_at, m.name AS ministry, a.level, a.deadline
       FROM acknowledgements a
       JOIN events e ON e.id = a.event_id
       JOIN ministries m ON m.id = a.ministry_id
      WHERE a.user_id = $1 AND a.confirmed_at IS NULL AND e.starts_at > NOW()
        AND NOT EXISTS (SELECT 1 FROM acknowledgements c
                         WHERE c.event_id = a.event_id AND c.ministry_id = a.ministry_id AND c.confirmed_at IS NOT NULL)
      ORDER BY e.starts_at`,
    [owner.user_id]
  );
  return { name: owner.full_name, pending };
}

/** Confirma todas as pendências da pessoa dona do token */
export async function confirmAcks(token: string): Promise<number | null> {
  const owner = await queryOne<{ user_id: string }>("SELECT user_id FROM acknowledgements WHERE token_hash = $1", [hashAckToken(token)]);
  if (!owner) return null;
  const rows = await query(
    "UPDATE acknowledgements SET confirmed_at = NOW() WHERE user_id = $1 AND confirmed_at IS NULL RETURNING id",
    [owner.user_id]
  );
  return rows.length;
}
