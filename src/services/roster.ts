/**
 * Escalas: cada membro escalado recebe no WhatsApp o checklist (POP) da sua área
 * antes do culto/evento, com um link (sem login) para marcar os itens.
 */
import crypto from "crypto";
import { query, queryOne } from "../db";
import { TZ, localDate } from "./reminders";
import { appUrl, sendDirect } from "./notify";

export const hashRosterToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const placeholderHash = () => hashRosterToken(crypto.randomBytes(24).toString("hex"));

interface EntryDetails {
  id: string;
  checked: number[];
  member_name: string;
  whatsapp: string | null;
  area: string;
  ministry: string;
  event_title: string;
  starts_at: Date;
  location: string | null;
  steps: string[] | null;
  pop_title: string | null;
}

const ENTRY_SELECT = `
  SELECT r.id, r.checked, mb.name AS member_name, mb.whatsapp, a.name AS area, m.name AS ministry,
         e.title AS event_title, e.starts_at, e.location, p.steps, p.title AS pop_title
    FROM roster_entries r
    JOIN members mb ON mb.id = r.member_id
    JOIN service_areas a ON a.id = r.area_id
    JOIN ministries m ON m.id = a.ministry_id
    JOIN events e ON e.id = r.event_id
    LEFT JOIN pops p ON p.id = a.pop_id`;

/** Gera um link novo e envia o checklist ao membro */
export async function sendRosterEntry(entryId: string): Promise<boolean> {
  const d = await queryOne<EntryDetails>(`${ENTRY_SELECT} WHERE r.id = $1`, [entryId]);
  if (!d?.whatsapp) return false;

  const token = crypto.randomBytes(24).toString("hex");
  await query("UPDATE roster_entries SET token_hash = $1 WHERE id = $2", [hashRosterToken(token), entryId]);

  const when = new Date(d.starts_at).toLocaleString("pt-BR", {
    timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const first = d.member_name.split(" ")[0];
  const steps = d.steps || [];
  const text = [
    `🙌 Olá, ${first}! Você está escalado(a):`,
    "",
    `📅 *${d.event_title}* — ${when}`,
    `🎯 ${d.ministry} · ${d.area}`,
    ...(steps.length ? ["", `📋 *Seu checklist${d.pop_title ? ` (${d.pop_title})` : ""}:*`, ...steps.map((s) => `☐ ${s}`)] : []),
    "",
    `✅ ${steps.length ? "Marque os itens" : "Confirme sua presença"} aqui: ${appUrl()}/checklist?token=${token}`,
  ].join("\n");

  if (!(await sendDirect(d.whatsapp, text))) return false;
  await query("UPDATE roster_entries SET sent_at = NOW() WHERE id = $1", [entryId]);
  return true;
}

/** Rodada diária: envia o checklist aos escalados dos próximos eventos (roster_days_before) */
export async function runRosterNotifications(now = new Date()) {
  const row = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'roster_days_before'");
  const daysBefore = Math.max(0, parseInt(row?.value || "1") || 0);
  const pending = await query<{ id: string }>(
    `SELECT r.id FROM roster_entries r JOIN events e ON e.id = r.event_id
      WHERE r.sent_at IS NULL AND e.status = 'approved' AND e.starts_at > NOW()
        AND (e.starts_at AT TIME ZONE 'America/Sao_Paulo')::date - $1::date <= $2`,
    [localDate(now), daysBefore]
  );
  let sent = 0;
  for (const p of pending) if (await sendRosterEntry(p.id)) sent++;
  return { pending: pending.length, sent };
}

/** Checklist do membro dono do token (tela pública) */
export async function rosterInfo(token: string) {
  const d = await queryOne<EntryDetails>(`${ENTRY_SELECT} WHERE r.token_hash = $1`, [hashRosterToken(token)]);
  if (!d) return null;
  return {
    member: d.member_name,
    event: d.event_title,
    starts_at: d.starts_at,
    location: d.location,
    ministry: d.ministry,
    area: d.area,
    pop_title: d.pop_title,
    steps: d.steps || [],
    checked: d.checked,
  };
}

export async function updateRosterChecklist(token: string, checked: number[]) {
  return queryOne<{ checked: number[] }>(
    "UPDATE roster_entries SET checked = $1, updated_at = NOW() WHERE token_hash = $2 RETURNING checked",
    [JSON.stringify(Array.from(new Set(checked))), hashRosterToken(token)]
  );
}
