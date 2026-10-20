-- ============================================================
-- Migração 021 — Tela Início: pedidos de oração e de visita, e visitantes já procurados
-- Execute no banco: hostinger
-- ============================================================

-- Pedidos pastorais (só os pastores e administradores veem a lista)
CREATE TABLE IF NOT EXISTS pastoral_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('prayer', 'visit')),
  source          TEXT NOT NULL DEFAULT 'home' CHECK (source IN ('home', 'cadastro')),
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL, -- quem pediu (NULL = formulário de cadastro)
  person_name     TEXT NOT NULL,             -- para quem é o pedido
  whatsapp        TEXT,
  address         TEXT,                      -- visita
  preferred_time  TEXT,                      -- visita: melhor dia/horário
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  handled_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pastoral_requests_open_idx ON pastoral_requests (kind, created_at DESC) WHERE status = 'open';

-- Visitante que pediu contato: quando e quem procurou
ALTER TABLE people ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ;
ALTER TABLE people ADD COLUMN IF NOT EXISTS contacted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Pedidos de oração que já vieram pelo formulário de cadastro entram na lista do pastor
INSERT INTO pastoral_requests (kind, source, person_name, whatsapp, details, created_at)
SELECT 'prayer', 'cadastro', p.name, p.whatsapp, p.notes, p.updated_at
  FROM people p
 WHERE p.notes IS NOT NULL AND TRIM(p.notes) <> ''
   AND NOT EXISTS (SELECT 1 FROM pastoral_requests r WHERE r.source = 'cadastro' AND r.whatsapp = p.whatsapp AND r.details = p.notes);
