-- ============================================================
-- Migração 007 — Cadastro de usuários da equipe + primeiro acesso
-- Execute no banco: hostinger
-- ============================================================

-- Novo perfil "viewer": só visualiza a agenda e o calendário
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin', 'moderator', 'agenda', 'viewer'));

-- Dados do usuário da equipe e controle da senha temporária
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name            TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp             TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS setup_token_hash     TEXT,
  ADD COLUMN IF NOT EXISTS setup_token_expires  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_setup_token_idx ON users (setup_token_hash);
