-- ============================================================
-- Migração 029 — Mensagens automáticas: ligar/desligar e escolher quem recebe
-- Execute no banco: hostinger
-- ============================================================
-- Uma linha por mensagem (a lista de mensagens fica no código: src/services/messages.ts).
-- Sem linha (ou campo nulo) = comportamento padrão.
-- Lembretes, resumos, confirmações e aniversários continuam usando as chaves que já existiam em system_settings.

CREATE TABLE IF NOT EXISTS message_rules (
  key                TEXT PRIMARY KEY,            -- ex.: "event_pending", "worship_changed"
  enabled            BOOLEAN,                     -- null = padrão (ligada)
  custom_recipients  UUID[],                      -- null = quem recebe por padrão; lista = só essas pessoas
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- O aviso de mudança no louvor ia para os e-mails em worship_notice_emails: vira a lista de quem recebe
INSERT INTO message_rules (key, custom_recipients)
SELECT 'worship_changed', array_agg(u.id)
  FROM system_settings s
  JOIN users u ON lower(u.email) = ANY (SELECT trim(lower(x)) FROM unnest(string_to_array(s.value, ',')) AS x)
 WHERE s.key = 'worship_notice_emails'
HAVING COUNT(u.id) > 0
ON CONFLICT (key) DO NOTHING;

DELETE FROM system_settings WHERE key = 'worship_notice_emails';
