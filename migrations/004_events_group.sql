-- ============================================================
-- Migração 004 — Grupo do WhatsApp por evento
-- Execute no banco: hostinger
-- ============================================================

-- Grupo que recebe os lembretes deste evento (ex: 1203630xxxxxxxx@g.us).
-- NULL = usa o grupo padrão (system_settings.reminders_group_jid).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS group_jid TEXT;
