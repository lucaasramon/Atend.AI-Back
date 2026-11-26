-- ============================================================
-- Migração 032 — Link de convite aberto (vários cadastros pelo mesmo link)
-- Execute no banco: hostinger
-- ============================================================
-- O admin (ou o líder, nas áreas dele) escolhe perfil, função e áreas e gera um link.
-- Quem abrir informa nome, e-mail, WhatsApp e senha e já entra com essas configurações.
-- O link vale para quantas pessoas abrirem, até ser desativado (ou vencer, se tiver prazo).
-- Quem já tem cadastro (mesmo e-mail ou WhatsApp) não consegue se cadastrar de novo.

CREATE TABLE IF NOT EXISTS invite_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token         TEXT NOT NULL UNIQUE,          -- fica salvo para o link poder ser copiado de novo
  label         TEXT,                          -- ex.: "Equipe do Louvor"
  role          TEXT NOT NULL CHECK (role IN ('agenda', 'viewer')),  -- link aberto nunca dá admin
  church_role   TEXT,
  ministry_ids  UUID[] NOT NULL DEFAULT '{}',
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ,                   -- NULL = sem prazo
  revoked_at    TIMESTAMPTZ,
  uses          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quem se cadastrou por qual link
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_link_id UUID REFERENCES invite_links(id) ON DELETE SET NULL;
