/**
 * Escalas: cada membro escalado recebe no WhatsApp o checklist (POP) da sua área
 * antes do culto/evento, com um link (sem login) para marcar os itens.
 */
import crypto from "crypto";
import { query, queryOne } from "../db";
import { TZ, getReminderSettings, localDate, sendToGroups } from "./reminders";
import { appUrl, sendDirect } from "./notify";

export const hashRosterToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const placeholderHash = () => hashRosterToken(crypto.randomBytes(24).toString("hex"));

interface EntryDetails {
  id: string;
  checked: number[];
  member_name: string;
  whatsapp: string | null;
  area: string | null;
  task: string | null;
  ministry: string;
  event_title: string;
  starts_at: Date;
  location: string | null;
  steps: string[] | null;
  pop_title: string | null;
}

const ENTRY_SELECT = `
  SELECT r.id, r.checked, r.task, mb.name AS member_name, mb.whatsapp, a.name AS area, m.name AS ministry,
         e.title AS event_title, e.starts_at, e.location, p.steps, p.title AS pop_title
    FROM roster_entries r
    JOIN members mb ON mb.id = r.member_id
    JOIN ministries m ON m.id = r.ministry_id
    JOIN events e ON e.id = r.event_id
    LEFT JOIN service_areas a ON a.id = r.area_id
    LEFT JOIN pops p ON p.id = a.pop_id`;

/** "Louvor · Vocal" (função escrita na escala, ou a função de serviço cadastrada) */
const roleLine = (d: Pick<EntryDetails, "ministry" | "task" | "area">) => [d.ministry, d.task || d.area].filter(Boolean).join(" · ");

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
    `🎯 ${roleLine(d)}`,
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

/** Quantos dias antes do evento a escala de cada área vai para o grupo escolhido */
export const ROSTER_GROUP_DAYS = 1;

/** Texto da escala de uma área no evento, para o grupo */
export async function rosterGroupText(eventId: string, ministryId: string): Promise<string | null> {
  const rows = await query<{ member: string; task: string | null; area: string | null; ministry: string; title: string; starts_at: Date; location: string | null; places: string | null }>(
    `SELECT mb.name AS member, r.task, a.name AS area, m.name AS ministry, e.title, e.starts_at, e.location,
            (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM event_locations el JOIN locations l ON l.id = el.location_id
              WHERE el.event_id = e.id) AS places
       FROM roster_entries r
       JOIN members mb ON mb.id = r.member_id
       JOIN ministries m ON m.id = r.ministry_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN service_areas a ON a.id = r.area_id
      WHERE r.event_id = $1 AND r.ministry_id = $2
      ORDER BY COALESCE(r.task, a.name, ''), mb.name`,
    [eventId, ministryId]
  );
  if (!rows.length) return null;
  const e = rows[0];
  const when = new Date(e.starts_at).toLocaleString("pt-BR", {
    timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return [
    `👥 *Escala — ${e.ministry}*`,
    "",
    `📅 *${e.title}* — ${when}`,
    ...(e.places || e.location ? [`📍 ${[e.places, e.location].filter(Boolean).join(" — ")}`] : []),
    "",
    ...rows.map((r) => `• ${r.member}${r.task || r.area ? ` — ${r.task || r.area}` : ""}`),
    "",
    "Contamos com vocês! 🙏",
  ].join("\n");
}

/** Rodada diária: manda a escala de cada área ao grupo escolhido, ROSTER_GROUP_DAYS antes do evento */
export async function runRosterGroups(now = new Date()) {
  const due = await query<{ event_id: string; ministry_id: string; group_jid: string }>(
    `SELECT g.event_id, g.ministry_id, g.group_jid FROM roster_groups g JOIN events e ON e.id = g.event_id
      WHERE g.sent_at IS NULL AND e.status = 'approved' AND e.starts_at > NOW()
        AND (e.starts_at AT TIME ZONE 'America/Sao_Paulo')::date - $1::date <= $2`,
    [localDate(now), ROSTER_GROUP_DAYS]
  );
  const out = { pending: due.length, sent: 0, errors: [] as string[] };
  if (!due.length) return out;
  const { instance } = await getReminderSettings();
  for (const g of due) {
    const text = await rosterGroupText(g.event_id, g.ministry_id);
    if (!text) continue;
    const r = await sendToGroups(instance, [g.group_jid], text, "escala no grupo");
    out.errors.push(...r.errors);
    if (r.sent) {
      out.sent++;
      await query("UPDATE roster_groups SET sent_at = NOW() WHERE event_id = $1 AND ministry_id = $2", [g.event_id, g.ministry_id]);
    }
  }
  return out;
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
    area: d.task || d.area || "",
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
