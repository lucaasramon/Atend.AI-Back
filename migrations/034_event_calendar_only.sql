-- ============================================================
-- Migração 034 — Evento "só no calendário" (ex.: recesso)
-- Execute no banco: hostinger
-- ============================================================
-- calendar_only = true: o evento aparece no calendário, mas o robô não fala dele no WhatsApp:
-- sem lembretes, fora dos resumos da semana/mês e sem mensagens no privado.

ALTER TABLE events ADD COLUMN IF NOT EXISTS calendar_only BOOLEAN NOT NULL DEFAULT false;
