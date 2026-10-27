-- ============================================================
-- Migração 022 — Mensagens no privado por evento (desligado por padrão)
-- Execute no banco: hostinger
-- ============================================================
-- Os avisos dos eventos vão para os GRUPOS. Só quando notify_private = true o robô também manda no privado:
--   pedido de confirmação aos líderes/pastores das áreas, checklist de quem está escalado
--   e lembrete das tarefas do checklist do evento.

ALTER TABLE events ADD COLUMN IF NOT EXISTS notify_private BOOLEAN NOT NULL DEFAULT false;
