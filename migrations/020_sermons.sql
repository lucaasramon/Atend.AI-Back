-- ============================================================
-- Migração 020 — Pregações: esboço em blocos e painel do púlpito
-- Execute no banco: hostinger
-- ============================================================
-- Quem vê: quem criou a pregação e o(s) líder(es) do ministério de Mídia (ministries.is_media).

CREATE TABLE IF NOT EXISTS sermons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  bible_text   TEXT,                       -- texto base (ex.: "Romanos 8")
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL, -- culto em que vai pregar
  blocks       JSONB NOT NULL DEFAULT '[]',
  -- [{id, kind, title, text, notes, minutes, verses: [{ref, text}], phrases: [texto]}]
  preached_at  TIMESTAMPTZ,                -- quando foi pregada (pelo painel do púlpito)
  duration_sec INT,
  block_times  JSONB,                      -- [{id, seconds}] tempo real de cada bloco
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sermons_author_idx ON sermons (author_id, updated_at DESC);
