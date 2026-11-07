-- ============================================================
-- Migração 028 — Pedidos para o telão: só aparecem depois que alguém da Mídia aprova
-- Execute no banco: hostinger
-- ============================================================
-- Chamada da sala infantil (código da criança), placa de carro e frase da pregação viram um pedido.
-- Qualquer pessoa da área Mídia aprova (ou recusa); só então vai para o Holyrics.
-- Pedido sem resposta em 5 minutos expira.

CREATE TABLE IF NOT EXISTS screen_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('kid', 'car', 'phrase')),
  screen_text   TEXT NOT NULL,                   -- exatamente o que vai aparecer no telão
  ref_id        UUID,                            -- kid: kids_checkins.id · phrase: sermons.id
  payload       JSONB NOT NULL DEFAULT '{}',     -- car: {plate, event_id} · phrase: {text}
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed', 'cancelled')),
  decided_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  error         TEXT                             -- aprovado, mas o Holyrics não mostrou
);

CREATE INDEX IF NOT EXISTS screen_requests_pending_idx ON screen_requests (requested_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS screen_requests_ref_idx ON screen_requests (ref_id, requested_at DESC);
