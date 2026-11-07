-- ============================================================
-- Migração 025 — Sala das crianças: código de cada criança no evento
-- Execute no banco: hostinger
-- ============================================================
-- A professora escolhe o evento, registra o nome da criança e ela recebe um código simples (1, 2, 3...).
-- Para chamar o responsável, o telão (Holyrics) mostra só o código, nunca o nome da criança.
-- Quem usa: admin e quem tem uma área marcada como "Crianças" (ministries.is_kids).

ALTER TABLE ministries ADD COLUMN IF NOT EXISTS is_kids BOOLEAN NOT NULL DEFAULT false;
UPDATE ministries SET is_kids = true WHERE name = 'Crianças';

CREATE TABLE IF NOT EXISTS kids_checkins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,                   -- "12" (automático) ou digitado pela professora
  child_name  TEXT NOT NULL,
  called_at   TIMESTAMPTZ,                     -- última chamada no telão (null = não está chamando)
  call_count  INT NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS kids_checkins_called_idx ON kids_checkins (called_at) WHERE called_at IS NOT NULL;
