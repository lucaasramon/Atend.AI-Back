-- ============================================================
-- Migração 019 — Parabéns automáticos no WhatsApp aos aniversariantes do dia (Cadastros)
-- Execute no banco: hostinger
-- ============================================================

-- Um envio por pessoa por ano (evita mandar duas vezes se o servidor reiniciar)
CREATE TABLE IF NOT EXISTS birthday_messages (
  person_id  UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  year       INT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_id, year)
);

-- birthday_enabled : liga/desliga o envio automático
-- birthday_church  : nome da igreja na mensagem ({igreja})
-- birthday_gap_min / birthday_gap_max : intervalo aleatório, em minutos, entre um parabéns e outro
-- birthday_template: texto (vazio = texto padrão do sistema)
INSERT INTO system_settings (key, value) VALUES
  ('birthday_enabled', 'true'),
  ('birthday_church', 'Igreja Cristã Despertar'),
  ('birthday_gap_min', '3'),
  ('birthday_gap_max', '10'),
  ('birthday_template', '')
ON CONFLICT (key) DO NOTHING;
