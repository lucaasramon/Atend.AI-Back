-- ============================================================
-- Migração 023 — Posição dos bairros para o mapa da tela Início
-- Execute no banco: hostinger
-- ============================================================
-- Cada bairro dos Cadastros é procurado uma única vez no OpenStreetMap (Nominatim) e fica salvo aqui.
-- key = LOWER(TRIM(people.neighborhood)). lat/lng NULL = não encontrado (nova tentativa depois de 30 dias).

CREATE TABLE IF NOT EXISTS neighborhood_geo (
  key           TEXT PRIMARY KEY,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  label         TEXT,                        -- nome encontrado no mapa
  looked_up_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
