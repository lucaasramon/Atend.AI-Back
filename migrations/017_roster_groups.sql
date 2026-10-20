-- ============================================================
-- Migração 017 — Escala de cada área enviada a um grupo do WhatsApp 1 dia antes do evento
-- Execute no banco: hostinger
-- ============================================================

CREATE TABLE IF NOT EXISTS roster_groups (
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ministry_id  UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  group_jid    TEXT NOT NULL,            -- grupo que recebe a escala (precisa estar em allowed_groups)
  sent_at      TIMESTAMPTZ,              -- NULL = ainda não enviada
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, ministry_id)
);
