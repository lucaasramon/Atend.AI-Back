-- ============================================================
-- Migração 006 — Tipo de usuário "agenda"
-- Execute no banco: hostinger
-- ============================================================

-- "agenda": acessa somente a agenda (listar, criar, editar e excluir eventos).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin', 'moderator', 'agenda'));
