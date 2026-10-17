-- ============================================================
-- Migração 010 — Calendário anual (categorias/recorrência), checklists e POPs
-- Execute no banco: hostinger
-- ============================================================

-- Categoria (cor no calendário) e série de eventos recorrentes
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS category  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS series_id UUID;

CREATE INDEX IF NOT EXISTS events_series_idx ON events (series_id);

-- Checklist de cada evento (local, buffet, decoração, som, blusas, papelaria...)
CREATE TABLE IF NOT EXISTS event_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  assignee_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_name  TEXT,                       -- responsável sem login (só o nome)
  due_date       DATE,
  done           BOOLEAN NOT NULL DEFAULT false,
  done_at        TIMESTAMPTZ,
  done_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  reminded_on    DATE,                       -- último dia em que o responsável foi lembrado
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_tasks_event_idx ON event_tasks (event_id);
CREATE INDEX IF NOT EXISTS event_tasks_due_idx ON event_tasks (due_date) WHERE done = false;

-- Modelos de checklist. items: [{ "title": "Som", "days_before": 7 }, ...]
CREATE TABLE IF NOT EXISTS checklist_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  items       JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO checklist_templates (name, items) VALUES
  ('Conferência', '[
    {"title": "Local reservado", "days_before": 30},
    {"title": "Buffet / alimentação", "days_before": 14},
    {"title": "Decoração", "days_before": 7},
    {"title": "Som e iluminação", "days_before": 7},
    {"title": "Blusas", "days_before": 21},
    {"title": "Papelaria (crachás, folhetos)", "days_before": 10},
    {"title": "Divulgação nas redes", "days_before": 21},
    {"title": "Recepção e equipe de apoio", "days_before": 3}
  ]'),
  ('Culto especial', '[
    {"title": "Escala de louvor", "days_before": 7},
    {"title": "Som e projeção", "days_before": 3},
    {"title": "Decoração", "days_before": 3},
    {"title": "Divulgação", "days_before": 7}
  ]')
ON CONFLICT (name) DO NOTHING;

-- POPs (procedimentos padrão) por ministério
--   recurrence: none | weekly (weekday 0=domingo..6) | monthly (month_day 1..31)
CREATE TABLE IF NOT EXISTS pops (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ministry_id  UUID REFERENCES ministries(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  steps        JSONB NOT NULL DEFAULT '[]',   -- ["Programar posts da semana", ...]
  link         TEXT,                           -- anexo (Drive, PDF...)
  recurrence   VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'weekly', 'monthly')),
  weekday      SMALLINT CHECK (weekday BETWEEN 0 AND 6),
  month_day    SMALLINT CHECK (month_day BETWEEN 1 AND 31),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS pops_updated_at ON pops;
CREATE TRIGGER pops_updated_at
  BEFORE UPDATE ON pops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Execuções de um POP (1 por dia). checked: índices dos passos concluídos
CREATE TABLE IF NOT EXISTS pop_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pop_id      UUID NOT NULL REFERENCES pops(id) ON DELETE CASCADE,
  run_date    DATE NOT NULL,
  checked     JSONB NOT NULL DEFAULT '[]',
  sent        BOOLEAN NOT NULL DEFAULT false,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pop_id, run_date)
);
