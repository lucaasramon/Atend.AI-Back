-- ============================================================
-- Migração 005 — Lista de grupos permitidos para envio
-- Execute no banco: hostinger
-- ============================================================

-- IDs de grupo (separados por vírgula) que podem receber mensagens do robô.
-- Qualquer outro destino é recusado (envio avulso, eventos e lembretes).
INSERT INTO system_settings (key, value) VALUES
  ('allowed_groups', '120363428176413515@g.us')  -- "teste do robô"
ON CONFLICT (key) DO NOTHING;
