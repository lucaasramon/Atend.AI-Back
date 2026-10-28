/**
 * Lista da igreja: os Cadastros (formulário público) + os usuários da plataforma.
 * Todo usuário da equipe é membro. Quem também preencheu o formulário (mesmo WhatsApp: DDD + 8 últimos
 * dígitos, cobre o número com ou sem o 9) aparece uma vez só, com os dados do formulário e o perfil do usuário.
 * Usuário sem formulário aparece só com nome, WhatsApp e e-mail; os dados dele são editados em Usuários.
 */
const TEAM = "('admin', 'agenda', 'viewer')";
const SAME_PHONE = (a: string, b: string) => `left(${a}, 4) = left(${b}, 4) AND right(${a}, 8) = right(${b}, 8)`;

/** Use como tabela: `FROM (${CHURCH_PEOPLE}) p`. source = 'form' | 'user' */
export const CHURCH_PEOPLE = `
  SELECT p.id, p.name, p.birth_date, p.whatsapp, p.email, p.gender, p.marital_status, p.neighborhood,
         CASE WHEN u.id IS NULL THEN p.relation ELSE 'member' END AS relation,
         p.baptized, p.how_found, p.wants_contact, p.interests, p.notes, p.status, p.member_id,
         p.created_at, 'form' AS source, u.id AS user_id, u.role AS user_role, u.church_role
    FROM people p
    LEFT JOIN LATERAL (
      SELECT id, role, church_role FROM users
       WHERE role IN ${TEAM} AND whatsapp IS NOT NULL AND ${SAME_PHONE("whatsapp", "p.whatsapp")}
       ORDER BY created_at LIMIT 1
    ) u ON true
  UNION ALL
  SELECT u.id, COALESCE(u.full_name, u.email), NULL::date, COALESCE(u.whatsapp, ''), u.email, NULL, NULL, NULL,
         'member', NULL, NULL, false, '[]'::jsonb, NULL, 'seen',
         (SELECT m.id FROM members m WHERE m.user_id = u.id),
         u.created_at, 'user', u.id, u.role, u.church_role
    FROM users u
   WHERE u.role IN ${TEAM}
     AND NOT EXISTS (SELECT 1 FROM people p WHERE u.whatsapp IS NOT NULL AND ${SAME_PHONE("u.whatsapp", "p.whatsapp")})`;
