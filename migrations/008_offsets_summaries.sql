-- ============================================================
-- Migração 008 — Antecedências por evento + resumos mensal/semanal
-- Execute no banco: hostinger
-- ============================================================

-- Antecedências próprias do evento (em dias). NULL = usa o padrão (reminders_offsets).
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[];

-- Novo padrão de lembretes: 30, 21, 14, 10, 7, 3, 1 dia e no dia do evento
UPDATE system_settings SET value = '30,21,14,10,7,3,1,0', updated_at = NOW()
 WHERE key = 'reminders_offsets';

-- Resumos enviados (1 por tipo e período: "monthly:2026-11", "weekly:2026-11-16")
CREATE TABLE IF NOT EXISTS summaries_sent (
  kind     VARCHAR(20) NOT NULL,
  period   VARCHAR(20) NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, period)
);

INSERT INTO system_settings (key, value) VALUES
  ('summary_monthly_enabled', 'true'),
  ('summary_weekly_enabled',  'true')
ON CONFLICT (key) DO NOTHING;
