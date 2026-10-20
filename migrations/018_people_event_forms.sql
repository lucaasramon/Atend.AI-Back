-- ============================================================
-- Migração 018 — Cadastro de membros/visitantes por link público
--               e formulários de inscrição dos eventos
-- Execute no banco: hostinger
-- ============================================================

-- Cadastro da igreja (formulário público /cadastro). Um cadastro por WhatsApp:
-- se a pessoa preencher de novo, os dados são atualizados.
CREATE TABLE IF NOT EXISTS people (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  birth_date       DATE,
  whatsapp         TEXT NOT NULL UNIQUE,      -- só dígitos, com DDI
  email            TEXT,
  gender           TEXT,                      -- 'M' | 'F'
  marital_status   TEXT,                      -- 'single' | 'married' | 'divorced' | 'widowed'
  neighborhood     TEXT,                      -- bairro / cidade
  relation         TEXT NOT NULL,             -- 'visitor' | 'regular' | 'member'
  baptized         BOOLEAN,
  how_found        TEXT,                      -- como conheceu a igreja (visitantes)
  wants_contact    BOOLEAN NOT NULL DEFAULT false,
  interests        JSONB NOT NULL DEFAULT '[]', -- ids dos ministérios em que gostaria de servir
  notes            TEXT,                      -- pedido de oração / observação
  status           TEXT NOT NULL DEFAULT 'new', -- 'new' | 'seen'
  member_id        UUID REFERENCES members(id) ON DELETE SET NULL, -- quando vira membro das escalas
  consent_at       TIMESTAMPTZ NOT NULL,      -- aceite do uso dos dados (LGPD)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS people_created_idx ON people (created_at DESC);

-- Formulário de inscrição de um evento (link público /inscricao/<slug>)
CREATE TABLE IF NOT EXISTS event_forms (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT,                         -- vazio = título do evento
  description  TEXT,
  is_open      BOOLEAN NOT NULL DEFAULT true,
  capacity     INT,                          -- NULL = sem limite; cheio = lista de espera
  closes_at    TIMESTAMPTZ,                  -- NULL = até o início do evento
  fields       JSONB NOT NULL DEFAULT '[]',  -- perguntas extras [{id, label, type, options, required}]
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_registrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     UUID NOT NULL REFERENCES event_forms(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  whatsapp    TEXT NOT NULL,
  answers     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'waitlist'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (form_id, whatsapp)
);

CREATE INDEX IF NOT EXISTS event_registrations_form_idx ON event_registrations (form_id, created_at);
