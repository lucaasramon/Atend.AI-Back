-- ============================================================
-- Migração 013 — Função na igreja e áreas (ministérios) de cada usuário
-- Execute no banco: hostinger
-- ============================================================

-- Função do usuário na igreja (Pastor(a), Líder, Voluntário(a)...)
ALTER TABLE users ADD COLUMN IF NOT EXISTS church_role TEXT;

-- Áreas do usuário: só pode criar/editar eventos dessas áreas (admin pode tudo)
CREATE TABLE IF NOT EXISTS user_ministries (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ministry_id  UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, ministry_id)
);

-- Áreas da igreja (o admin pode renomear, excluir ou criar outras em Ministérios)
INSERT INTO ministries (name, color, is_media) VALUES
  ('Igreja',                       '#2563eb', false),
  ('Mídia',                        '#0891b2', true),
  ('Louvor',                       '#9333ea', false),
  ('Crianças',                     '#ea580c', false),
  ('Adolescentes',                 '#db2777', false),
  ('Jovens',                       '#16a34a', false),
  ('Diáconos',                     '#64748b', false),
  ('Grupo de Crescimento',         '#ca8a04', false),
  ('Escola Zoe',                   '#0d9488', false),
  ('Rádio ICD',                    '#dc2626', false),
  ('Cantina',                      '#a16207', false),
  ('Dança',                        '#c026d3', false),
  ('Intercessão',                  '#4f46e5', false),
  ('Recepção',                     '#059669', false),
  ('Casais',                       '#e11d48', false),
  ('Mulheres',                     '#be185d', false),
  ('Homens',                       '#1d4ed8', false),
  ('Ação Social',                  '#65a30d', false),
  ('Missões',                      '#7c3aed', false),
  ('Som e Técnica',                '#475569', false),
  ('Teatro',                       '#b45309', false),
  ('Secretaria',                   '#0369a1', false)
ON CONFLICT (name) DO NOTHING;
