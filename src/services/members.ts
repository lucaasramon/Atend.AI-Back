/**
 * Membros das escalas ligados aos usuários da plataforma.
 * Todo usuário da equipe vira membro automaticamente, com nome, WhatsApp e áreas iguais aos do cadastro.
 */
import { query, queryOne } from "../db";

/** Cria/atualiza o membro do usuário e copia as áreas (ministérios) dele */
export async function syncMemberFromUser(userId: string) {
  const user = await queryOne<{ id: string; email: string; full_name: string | null; whatsapp: string | null; role: string }>(
    "SELECT id, email, full_name, whatsapp, role FROM users WHERE id = $1",
    [userId]
  );
  if (!user || !["admin", "agenda", "viewer"].includes(user.role)) return;

  const member = await queryOne<{ id: string }>(
    `INSERT INTO members (name, whatsapp, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, whatsapp = EXCLUDED.whatsapp
     RETURNING id`,
    [user.full_name || user.email, user.whatsapp, user.id]
  );

  await query("DELETE FROM member_ministries WHERE member_id = $1", [member!.id]);
  await query(
    `INSERT INTO member_ministries (member_id, ministry_id)
     SELECT $1, ministry_id FROM user_ministries WHERE user_id = $2
     ON CONFLICT DO NOTHING`,
    [member!.id, user.id]
  );
}
