-- ============================================================
-- Migração 002 — Integração Evolution API + n8n
-- Execute no banco: hostinger
-- ============================================================

-- Adiciona instance_name na tabela profiles
-- (liga o cliente do painel à instância no Evolution/n8n)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS instance_name TEXT UNIQUE;

-- Tabela clients usada pelo workflow n8n (AtendIA)
-- Cada linha = uma instância/cliente no WhatsApp
CREATE TABLE IF NOT EXISTS clients (
  instance_name  TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  system_prompt  TEXT NOT NULL DEFAULT '',
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_updated_at ON clients;
CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
