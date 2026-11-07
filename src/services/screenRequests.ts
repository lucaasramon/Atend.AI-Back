/**
 * Pedidos para o telão: nada vai para o Holyrics sem alguém da Mídia aprovar.
 *  - kid:    chamada do responsável pela criança (código)      → aviso do telão
 *  - car:    placa de carro                                    → aviso do telão
 *  - phrase: frase da pregação                                 → apresentação rápida
 * Quem aprova: qualquer pessoa da área Mídia (ministries.is_media), inclusive o líder.
 * O aviso principal é na própria plataforma (tela cheia, som, notificação); o WhatsApp é reforço.
 */
import { query, queryOne } from "../db";
import { holyrics } from "./holyrics";
import { refreshScreenAlert } from "./screenAlert";
import { appUrl, notifyUsers } from "./notify";
import { messageEnabled, messageRecipients } from "./messages";

/** Pedido sem resposta depois disso expira */
export const REQUEST_TTL_MIN = 5;

export type RequestKind = "kid" | "car" | "phrase";

export interface ScreenRequest {
  id: string;
  kind: RequestKind;
  screen_text: string;
  ref_id: string | null;
  payload: any;
  requested_by: string | null;
  requested_at: string;
  status: string;
  error: string | null;
}

/** Pessoas da Mídia (área marcada como Mídia, ou líder dela) */
export async function mediaUserIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u
      WHERE u.role IN ('admin', 'agenda', 'viewer')
        AND EXISTS (SELECT 1 FROM ministries m
                     WHERE m.is_media
                       AND (m.leader_id = u.id OR EXISTS (SELECT 1 FROM user_ministries um WHERE um.ministry_id = m.id AND um.user_id = u.id)))`
  );
  return rows.map((r) => r.id);
}

export async function hasMediaAccess(userId: string, role: string): Promise<boolean> {
  if (!["admin", "agenda", "viewer"].includes(role)) return false;
  return (await mediaUserIds()).includes(userId);
}

/** Pedidos velhos sem resposta viram "expirado" */
export async function expireOld() {
  await query(
    `UPDATE screen_requests SET status = 'expired', decided_at = NOW()
      WHERE status = 'pending' AND requested_at < NOW() - make_interval(mins => $1)`,
    [REQUEST_TTL_MIN]
  );
}

const KIND_LABEL: Record<RequestKind, string> = { kid: "Sala infantil", car: "Estacionamento", phrase: "Pregação" };

/** Cria o pedido (ou devolve o que já está esperando para a mesma coisa) e avisa a Mídia */
export async function createRequest(r: { kind: RequestKind; text: string; refId?: string | null; payload?: object; userId: string }) {
  await expireOld();
  const same = await queryOne<ScreenRequest>(
    `SELECT * FROM screen_requests
      WHERE status = 'pending' AND kind = $1 AND screen_text = $2 AND ref_id IS NOT DISTINCT FROM $3
      ORDER BY requested_at DESC LIMIT 1`,
    [r.kind, r.text, r.refId || null]
  );
  if (same) return same;
  const row = await queryOne<ScreenRequest>(
    `INSERT INTO screen_requests (kind, screen_text, ref_id, payload, requested_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [r.kind, r.text, r.refId || null, JSON.stringify(r.payload || {}), r.userId]
  );
  // Reforço no WhatsApp (a fila do WhatsApp é lenta de propósito: o aviso principal é na plataforma)
  notifyMediaWhatsApp(row!).catch((e) => console.error("[telão] aviso no WhatsApp falhou:", e));
  return row!;
}

async function notifyMediaWhatsApp(r: ScreenRequest) {
  const who = await queryOne<{ full_name: string | null }>("SELECT full_name FROM users WHERE id = $1", [r.requested_by]);
  if (!(await messageEnabled("screen_request"))) return;
  const ids = (await messageRecipients("screen_request", await mediaUserIds())).filter((id) => id !== r.requested_by);
  if (!ids.length) return;
  const text = [
    `📺 *Pedido para o telão* (${KIND_LABEL[r.kind]}${who?.full_name ? ` · ${who.full_name}` : ""})`,
    `“${r.screen_text}”`,
    `Aprove ou recuse em até ${REQUEST_TTL_MIN} minutos: ${appUrl()}/admin/telao`,
  ].join("\n");
  await notifyUsers(ids, text);
}

/** Aprovou: agora sim vai para o Holyrics. Se o Holyrics falhar, o pedido fica "failed" com o motivo. */
export async function approve(id: string, userId: string): Promise<ScreenRequest | null> {
  await expireOld();
  const r = await queryOne<ScreenRequest>(
    `UPDATE screen_requests SET status = 'approved', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, userId]
  );
  if (!r) return null; // outra pessoa da Mídia já respondeu, foi cancelado ou expirou
  try {
    if (r.kind === "kid") {
      await query("UPDATE kids_checkins SET called_at = NOW(), call_count = call_count + 1 WHERE id = $1", [r.ref_id]);
      await refreshScreenAlert();
    } else if (r.kind === "car") {
      const call = await queryOne<{ id: string }>(
        "INSERT INTO car_calls (plate, event_id, called_by) VALUES ($1, $2, $3) RETURNING id",
        [r.payload.plate, r.payload.event_id || null, r.requested_by]
      );
      await query("UPDATE screen_requests SET payload = payload || $2::jsonb WHERE id = $1", [r.id, JSON.stringify({ call_id: call!.id })]);
      await refreshScreenAlert();
    } else {
      await holyrics("ShowQuickPresentation", { text: r.payload.text || r.screen_text });
    }
  } catch (e) {
    // Não apareceu: desfaz e guarda o motivo
    if (r.kind === "kid") await query("UPDATE kids_checkins SET called_at = NULL WHERE id = $1", [r.ref_id]).catch(() => {});
    if (r.kind === "car") {
      await query("DELETE FROM car_calls WHERE id = (SELECT (payload->>'call_id')::uuid FROM screen_requests WHERE id = $1)", [r.id]).catch(() => {});
    }
    await query("UPDATE screen_requests SET status = 'failed', error = $2 WHERE id = $1", [r.id, (e as Error).message]);
  }
  return queryOne<ScreenRequest>("SELECT * FROM screen_requests WHERE id = $1", [id]);
}

export async function reject(id: string, userId: string) {
  return queryOne<ScreenRequest>(
    `UPDATE screen_requests SET status = 'rejected', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, userId]
  );
}

/** Quem pediu desistiu (ou tirou do telão antes da Mídia aprovar) */
export async function cancelPending(where: { id?: string; kind?: RequestKind; refId?: string; userId?: string }) {
  await query(
    `UPDATE screen_requests SET status = 'cancelled', decided_at = NOW()
      WHERE status = 'pending'
        AND ($1::uuid IS NULL OR id = $1)
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::uuid IS NULL OR ref_id = $3)
        AND ($4::uuid IS NULL OR requested_by = $4)`,
    [where.id || null, where.kind || null, where.refId || null, where.userId || null]
  );
}

/** Colunas para mostrar a situação de um pedido (status, quem pediu, quem decidiu) */
export const REQUEST_SELECT = `
  SELECT r.id, r.kind, r.screen_text, r.ref_id, r.payload, r.status, r.error, r.requested_at, r.decided_at,
         u.full_name AS requested_by_name, d.full_name AS decided_by_name,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (r.requested_at + make_interval(mins => ${REQUEST_TTL_MIN}) - NOW()))))::int AS expires_in_sec
    FROM screen_requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users d ON d.id = r.decided_by`;
