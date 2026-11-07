-- ============================================================
-- Migração 024 — Perfil "member": membro da igreja com acesso à plataforma
-- Execute no banco: hostinger
-- ============================================================
-- Criado pelo formulário de cadastro (/cadastro, com e-mail e senha) ou pelo admin em Cadastros.
-- Só vê a tela Início (escalas, eventos, inscrições, aniversariantes, pedidos) e Minha conta.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin', 'moderator', 'agenda', 'viewer', 'member'));
