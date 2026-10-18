-- ============================================================
-- Migração 014 — Registro das mensagens no privado (limite diário de conversas novas)
-- Execute no banco: hostinger
-- ============================================================

-- Cada mensagem enviada no privado pelo robô
CREATE TABLE IF NOT EXISTS whatsapp_dm_log (
  id        BIGSERIAL PRIMARY KEY,
  number    TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_dm_log_number_idx ON whatsapp_dm_log (number);
CREATE INDEX IF NOT EXISTS whatsapp_dm_log_sent_idx ON whatsapp_dm_log (sent_at);

-- Máximo de conversas NOVAS no privado por dia (números com quem o robô nunca falou)
INSERT INTO system_settings (key, value) VALUES ('dm_new_daily_limit', '30')
ON CONFLICT (key) DO NOTHING;
