-- ============================================================
-- Migração 033 — Imagem opcional nos eventos (vai junto do lembrete no WhatsApp)
-- Execute no banco: hostinger
-- ============================================================
-- A imagem fica numa tabela própria (para não pesar as listagens de eventos).
-- As datas de uma série recorrente apontam para a mesma imagem.
-- Imagens sem nenhum evento apontando são apagadas pela aplicação.

CREATE TABLE IF NOT EXISTS event_images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mime        VARCHAR(40) NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS image_id UUID REFERENCES event_images(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_image_id ON events(image_id);
