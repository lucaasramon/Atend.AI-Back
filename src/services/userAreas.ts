/**
 * Áreas (ministérios) de cada usuário.
 * Quem não é admin só cria/edita eventos das suas áreas; ver, todos veem tudo.
 */
import { query, queryOne } from "../db";

// Funções na igreja (users.church_role)
export const CHURCH_ROLES = [
  "Apóstolo(a)",
  "Bispo(a)",
  "Pastor(a)",
  "Pastor(a) auxiliar",
  "Presbítero(a)",
  "Evangelista",
  "Missionário(a)",
  "Diácono(isa)",
  "Obreiro(a)",
  "Líder",
  "Vice-líder",
  "Coordenador(a)",
  "Professor(a)",
  "Secretário(a)",
  "Tesoureiro(a)",
  "Voluntário(a)",
  "Membro",
];

export async function userMinistryIds(userId: string): Promise<string[]> {
  const rows = await query<{ ministry_id: string }>("SELECT ministry_id FROM user_ministries WHERE user_id = $1", [userId]);
  return rows.map((r) => r.ministry_id);
}

export async function setUserMinistries(userId: string, ids: string[]) {
  await query("DELETE FROM user_ministries WHERE user_id = $1", [userId]);
  if (ids.length) {
    await query("INSERT INTO user_ministries (user_id, ministry_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [userId, ids]);
  }
}

/** O usuário (não admin) pode editar/excluir o evento? Sim se for de uma área dele ou se ele criou */
export async function canManageEvent(userId: string, role: string, eventId: string): Promise<boolean> {
  if (role === "admin") return true;
  const row = await queryOne(
    `SELECT 1 FROM events e
      WHERE e.id = $1
        AND (e.created_by = $2
             OR EXISTS (SELECT 1 FROM event_ministries em JOIN user_ministries um ON um.ministry_id = em.ministry_id
                         WHERE em.event_id = e.id AND um.user_id = $2))`,
    [eventId, userId]
  );
  return !!row;
}

// Funções na igreja que contam como liderança da área
export const LEADER_CHURCH_ROLES = ["Líder", "Vice-líder", "Coordenador(a)"];

/**
 * Áreas em que o usuário pode montar a escala (null = todas, admin).
 * Pode quem é líder da área (cadastrado como líder no ministério), quem tem função de liderança
 * (Líder, Vice-líder, Coordenador) numa área sua, e o perfil "agenda" nas suas áreas.
 */
export async function rosterMinistryIds(userId: string, role: string): Promise<string[] | null> {
  if (role === "admin") return null;
  const rows = await query<{ id: string }>(
    `SELECT id FROM ministries WHERE leader_id = $1
     UNION
     SELECT um.ministry_id FROM user_ministries um JOIN users u ON u.id = um.user_id
      WHERE um.user_id = $1 AND ($2 = 'agenda' OR u.church_role = ANY($3::text[]))`,
    [userId, role, LEADER_CHURCH_ROLES]
  );
  return rows.map((r) => r.id);
}

/**
 * Áreas que o usuário lidera: cadastrado como líder no ministério ou com função de liderança
 * (Líder, Vice-líder, Coordenador) numa área sua. Só perfis da equipe (agenda/viewer); admin não precisa.
 */
export async function leaderMinistryIds(userId: string, role: string): Promise<string[]> {
  if (role !== "agenda" && role !== "viewer") return [];
  const rows = await query<{ id: string }>(
    `SELECT id FROM ministries WHERE leader_id = $1
     UNION
     SELECT um.ministry_id FROM user_ministries um JOIN users u ON u.id = um.user_id
      WHERE um.user_id = $1 AND u.church_role = ANY($2::text[])`,
    [userId, LEADER_CHURCH_ROLES]
  );
  return rows.map((r) => r.id);
}

// Funções que o líder NÃO pode dar no convite (liderança e pastoreio ficam com o admin)
export const LEADER_BLOCKED_CHURCH_ROLES = [
  "Apóstolo(a)", "Bispo(a)", "Pastor(a)", "Pastor(a) auxiliar", "Presbítero(a)", "Evangelista", "Missionário(a)",
  ...LEADER_CHURCH_ROLES,
];
