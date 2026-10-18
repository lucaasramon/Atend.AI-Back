-- ============================================================
-- Migração 015 — Evento sem lembretes
-- Execute no banco: hostinger
-- ============================================================

-- true = o robô não envia lembretes deste evento (ex.: culto fixo que todos já conhecem).
-- O evento continua no calendário e nos resumos mensal/semanal.
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminders_off BOOLEAN NOT NULL DEFAULT false;
