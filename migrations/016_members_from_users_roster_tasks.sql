-- ============================================================
-- Migração 016 — Usuários viram membros automaticamente + função de cada pessoa na escala
-- Execute no banco: hostinger
-- ============================================================

-- Membro ligado a um usuário da plataforma (sincronizado com Usuários)
ALTER TABLE members ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL;

-- Escala: área (ministério) obrigatória, função livre ("Vocal", "Câmera 1") e POP opcional
ALTER TABLE roster_entries ADD COLUMN IF NOT EXISTS ministry_id UUID REFERENCES ministries(id) ON DELETE CASCADE;
ALTER TABLE roster_entries ADD COLUMN IF NOT EXISTS task TEXT;

UPDATE roster_entries r SET ministry_id = a.ministry_id
  FROM service_areas a WHERE a.id = r.area_id AND r.ministry_id IS NULL;

ALTER TABLE roster_entries ALTER COLUMN area_id DROP NOT NULL;
ALTER TABLE roster_entries ALTER COLUMN ministry_id SET NOT NULL;

-- Uma pessoa aparece uma vez por área em cada evento
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS roster_entries_event_id_area_id_member_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS roster_entries_event_ministry_member_idx ON roster_entries (event_id, ministry_id, member_id);

-- Usuários da equipe que já existem viram membros, com as suas áreas
INSERT INTO members (name, whatsapp, user_id)
SELECT COALESCE(full_name, email), whatsapp, id FROM users
 WHERE role IN ('admin', 'agenda', 'viewer')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO member_ministries (member_id, ministry_id)
SELECT m.id, um.ministry_id FROM members m JOIN user_ministries um ON um.user_id = m.user_id
ON CONFLICT DO NOTHING;
