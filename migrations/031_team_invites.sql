-- ============================================================
-- Migração 031 — Convites para a equipe
-- Execute no banco: hostinger
-- ============================================================
-- O admin informa nome, WhatsApp, perfil, função e áreas; o robô manda um link
-- e a pessoa completa o cadastro (nome, e-mail e senha). Ao concluir, vira usuário da equipe.

CREATE TABLE IF NOT EXISTS team_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  whatsapp      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'agenda', 'viewer')),
  church_role   TEXT,
  ministry_ids  UUID[] NOT NULL DEFAULT '{}',
  invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  send_error    TEXT,
  accepted_at   TIMESTAMPTZ,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_invites_open_idx ON team_invites (created_at DESC) WHERE accepted_at IS NULL AND cancelled_at IS NULL;
