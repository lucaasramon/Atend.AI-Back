-- ============================================================
-- Migração 026 — Chamar o dono do carro no telão pela placa
-- Execute no banco: hostinger
-- ============================================================
-- Quem está na escala do dia (e o admin) escreve a placa e ela aparece no aviso do telão (Holyrics).
-- Cada chamada fica registrada: quem chamou, qual placa e quando.

CREATE TABLE IF NOT EXISTS car_calls (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate       TEXT NOT NULL,                   -- só letras e números, maiúsculas: "ABC1234" ou "ABC1D23"
  event_id    UUID REFERENCES events(id) ON DELETE SET NULL,  -- evento do dia em que a pessoa serve
  called_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at  TIMESTAMPTZ                      -- tirado do telão antes do tempo
);

CREATE INDEX IF NOT EXISTS car_calls_called_idx ON car_calls (called_at DESC);
