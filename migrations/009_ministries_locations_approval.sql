-- ============================================================
-- Migração 009 — Ministérios, locais e aprovação de eventos
-- Execute no banco: hostinger
-- ============================================================

-- Ministérios: cada um pode ter um grupo do WhatsApp, um líder e um pastor responsável
CREATE TABLE IF NOT EXISTS ministries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  group_jid   TEXT,
  leader_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  pastor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  color       TEXT,
  is_media    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ministries_updated_at ON ministries;
CREATE TRIGGER ministries_updated_at
  BEFORE UPDATE ON ministries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS event_ministries (
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ministry_id  UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, ministry_id)
);

-- Locais da igreja (Templo, Sala das Crianças, ...)
CREATE TABLE IF NOT EXISTS locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_locations (
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, location_id)
);

-- Aprovação: eventos já existentes ficam aprovados
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS events_status_idx ON events (status);

-- "true": eventos criados por quem não é admin precisam de aprovação de um admin
INSERT INTO system_settings (key, value) VALUES ('approval_required', 'true')
ON CONFLICT (key) DO NOTHING;
