-- ============================================================
-- Migração 030 — Área do Estacionamento
-- Execute no banco: hostinger
-- ============================================================
-- Quem está escalado nesta área no dia (e o admin) usa a tela "Placa no telão".

ALTER TABLE ministries ADD COLUMN IF NOT EXISTS is_parking BOOLEAN NOT NULL DEFAULT false;

INSERT INTO ministries (name, color, is_parking) VALUES ('Estacionamento', '#0f766e', true)
ON CONFLICT (name) DO UPDATE SET is_parking = true;
