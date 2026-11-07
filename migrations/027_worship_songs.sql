-- ============================================================
-- Migração 027 — Músicas da escala do louvor, ligadas ao Holyrics
-- Execute no banco: hostinger
-- ============================================================
-- O louvor escolhe as músicas do culto na biblioteca do Holyrics (ou cria só com o nome, sem letra).
-- A plataforma põe as músicas na lista de mídia do culto no Holyrics (cria o culto lá se não existir).
-- Remover/reordenar não funciona pela API do Holyrics: a plataforma avisa a Mídia para ajustar lá.
-- Quem escolhe: admin e quem tem uma área marcada como Louvor (ministries.is_worship).

ALTER TABLE ministries ADD COLUMN IF NOT EXISTS is_worship BOOLEAN NOT NULL DEFAULT false;
UPDATE ministries SET is_worship = true WHERE name = 'Louvor';

-- Músicas de cada culto, na ordem
CREATE TABLE IF NOT EXISTS event_songs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position        INT NOT NULL DEFAULT 0,
  holyrics_id     TEXT NOT NULL,                -- id da música no Holyrics
  title           TEXT NOT NULL,
  artist          TEXT,
  lyrics_pending  BOOLEAN NOT NULL DEFAULT false, -- criada pela plataforma só com o nome: falta a letra
  added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, holyrics_id)
);

CREATE INDEX IF NOT EXISTS event_songs_event_idx ON event_songs (event_id, position);

-- O que já está no Holyrics para cada culto
CREATE TABLE IF NOT EXISTS event_holyrics (
  event_id           UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  holyrics_event_id  TEXT,                       -- culto correspondente no Holyrics
  sent_songs         JSONB NOT NULL DEFAULT '[]', -- [{id, title}] já colocadas na lista do Holyrics, na ordem
  synced_at          TIMESTAMPTZ,
  sync_error         TEXT,                       -- último erro ao enviar (null = tudo certo)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
