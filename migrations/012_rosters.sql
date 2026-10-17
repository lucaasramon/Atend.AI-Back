-- ============================================================
-- Migração 012 — Escalas por culto/evento e checklist de cada membro
-- Execute no banco: hostinger
-- ============================================================

-- Membros que servem (sem login: só nome e WhatsApp)
CREATE TABLE IF NOT EXISTS members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  whatsapp    TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_ministries (
  member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ministry_id  UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, ministry_id)
);

-- Áreas de serviço de cada ministério, com o POP (checklist) da área
CREATE TABLE IF NOT EXISTS service_areas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ministry_id  UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  pop_id       UUID REFERENCES pops(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ministry_id, name)
);

-- Escala: quem serve em qual área em cada evento
CREATE TABLE IF NOT EXISTS roster_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  area_id      UUID NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,     -- link do checklist do membro (sem login)
  checked      JSONB NOT NULL DEFAULT '[]',
  sent_at      TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, area_id, member_id)
);

CREATE INDEX IF NOT EXISTS roster_event_idx ON roster_entries (event_id);

-- Quantos dias antes do evento o membro recebe o checklist (0 = no dia)
INSERT INTO system_settings (key, value) VALUES ('roster_days_before', '1')
ON CONFLICT (key) DO NOTHING;
