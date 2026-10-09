-- ============================================================
-- Migração 003 — Agenda de eventos + lembretes no grupo do WhatsApp
-- Execute no banco: hostinger
-- ============================================================

-- Eventos exibidos no calendário público do frontend
CREATE TABLE IF NOT EXISTS events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT,
  location     TEXT,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ,
  is_public    BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_starts_at_idx ON events (starts_at);

DROP TRIGGER IF EXISTS events_updated_at ON events;
CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Controle de lembretes já enviados (1 linha por evento + antecedência em dias)
-- Garante que o mesmo lembrete nunca seja enviado duas vezes.
CREATE TABLE IF NOT EXISTS event_reminders_sent (
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  offset_days     INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'skipped')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, offset_days)
);

-- Configurações padrão dos lembretes (editáveis via PUT /api/settings)
--   reminders_enabled      : "true" | "false"
--   reminders_instance     : instância do Evolution que envia as mensagens
--   reminders_group_jid    : grupo de destino (ex: 1203630xxxxxxxx@g.us)
--   reminders_offsets      : antecedências em dias, separadas por vírgula (0 = no dia do evento)
--   reminders_template     : texto da mensagem; variáveis: {titulo} {data} {hora} {local} {descricao} {quando}
--   (horário do envio diário: variável de ambiente REMINDERS_TIME, padrão 08:00, horário de Brasília)
INSERT INTO system_settings (key, value) VALUES
  ('reminders_enabled',   'false'),
  ('reminders_instance',  'zolie'),
  ('reminders_group_jid', ''),
  ('reminders_offsets',   '10,7,3,0'),
  ('reminders_template',  E'📅 *Lembrete:* {titulo}\n🗓️ {data} às {hora}\n📍 {local}\n⏳ {quando}\n\n{descricao}')
ON CONFLICT (key) DO NOTHING;
