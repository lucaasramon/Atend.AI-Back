/**
 * Placa de carro no telão: quem pode usar e a validação da placa.
 */
import { queryOne } from "../db";
import { TZ } from "./reminders";

/** Placa brasileira: antiga (ABC1234) ou Mercosul (ABC1D23), carro ou moto */
export const PLATE_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

/** "abc-1234" → "ABC1234" */
export const cleanPlate = (v: unknown) => (typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

/**
 * Evento de hoje em que a pessoa está escalada no Estacionamento (null = não está).
 * Área do Estacionamento = ministries.is_parking. Se nenhuma área estiver marcada, vale qualquer escala do dia.
 * O admin pode sempre: recebe o evento de hoje se houver, ou "" se não houver.
 */
export async function servingToday(userId: string, role: string): Promise<string | null> {
  if (role !== "admin" && role !== "agenda" && role !== "viewer") return null;
  const row = await queryOne<{ event_id: string }>(
    `SELECT re.event_id FROM roster_entries re
       JOIN members m ON m.id = re.member_id
       JOIN events e ON e.id = re.event_id
       JOIN ministries mi ON mi.id = re.ministry_id
      WHERE m.user_id = $1
        AND e.status <> 'rejected'
        AND (e.starts_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
        AND (mi.is_parking OR NOT EXISTS (SELECT 1 FROM ministries WHERE is_parking))
      ORDER BY e.starts_at LIMIT 1`,
    [userId]
  );
  if (row) return row.event_id;
  return role === "admin" ? "" : null;
}

export const hasCarsAccess = async (userId: string, role: string) => (await servingToday(userId, role)) !== null;
