-- ============================================================
-- Migração 011 — Demandas da Mídia + confirmação de visualização com escalonamento
-- Execute no banco: hostinger
-- ============================================================

-- Demandas da mídia (captações, gravações, posts, artes...), em grupo ou individuais
CREATE TABLE IF NOT EXISTS media_demands (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  type           VARCHAR(20) NOT NULL DEFAULT 'outro'
                 CHECK (type IN ('captacao', 'gravacao', 'post', 'arte', 'video', 'transmissao', 'outro')),
  event_id       UUID REFERENCES events(id) ON DELETE SET NULL,
  is_group       BOOLEAN NOT NULL DEFAULT false,   -- demanda do grupo da mídia (não de uma pessoa)
  assignee_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_name  TEXT,                             -- responsável sem login (só o nome)
  due_at         TIMESTAMPTZ NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'done')),
  briefing       TEXT,                             -- informações para criação (textos, referências...)
  links          TEXT,                             -- anexos/referências (um por linha)
  reminded_on    DATE,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_demands_due_idx ON media_demands (due_at) WHERE status <> 'done';

DROP TRIGGER IF EXISTS media_demands_updated_at ON media_demands;
CREATE TRIGGER media_demands_updated_at
  BEFORE UPDATE ON media_demands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Confirmação de visualização: líder (nível 1) → pastor responsável (2) → administradores (3)
CREATE TABLE IF NOT EXISTS acknowledgements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ministry_id   UUID NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  level         SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 3),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  sent          BOOLEAN NOT NULL DEFAULT false,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline      TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  escalated     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS acks_chain_idx ON acknowledgements (event_id, ministry_id);
CREATE INDEX IF NOT EXISTS acks_pending_idx ON acknowledgements (deadline) WHERE confirmed_at IS NULL AND escalated = false;

INSERT INTO system_settings (key, value) VALUES
  ('ack_enabled', 'true'),
  ('ack_hours',   '48')
ON CONFLICT (key) DO NOTHING;
