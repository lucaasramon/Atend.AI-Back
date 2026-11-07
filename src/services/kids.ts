/**
 * Sala das crianças: quem pode usar e o aviso no telão para chamar o responsável.
 * O aviso é montado em screenAlert.ts junto com as placas de carro (o Holyrics só tem um aviso por vez).
 */
import { queryOne } from "../db";

export { CALL_SECONDS, kidsText as callText, refreshScreenAlert as refreshScreenCall } from "./screenAlert";

/** Admin, ou quem tem (ou lidera) uma área marcada como "Crianças" */
export async function hasKidsAccess(userId: string, role: string): Promise<boolean> {
  if (role === "admin") return true;
  if (role !== "agenda" && role !== "viewer") return false;
  const row = await queryOne(
    `SELECT 1 FROM ministries m
      WHERE m.is_kids
        AND (m.leader_id = $1 OR EXISTS (SELECT 1 FROM user_ministries um WHERE um.ministry_id = m.id AND um.user_id = $1))
      LIMIT 1`,
    [userId]
  );
  return !!row;
}
