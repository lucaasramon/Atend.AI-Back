/**
 * Evolution API service
 * Docs: https://doc.evolution-api.com
 */

import { query, queryOne } from "../db";

const BASE_URL = (process.env.EVOLUTION_API_URL || "").replace(/\/$/, "");
const API_KEY  = process.env.EVOLUTION_API_KEY || "";

async function evo<T = any>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Evolution API ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

/** Cria uma nova instância no Evolution API */
export async function createInstance(instanceName: string): Promise<{ instance: { instanceName: string; status: string } }> {
  return evo("POST", "/instance/create", {
    instanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    webhookBase64: true,
  });
}

/** Retorna o QR code de conexão de uma instância */
export async function getQrCode(instanceName: string): Promise<{ base64?: string; code?: string; pairingCode?: string; count?: number }> {
  return evo("GET", `/instance/connect/${instanceName}`);
}

/** Retorna o status de conexão de uma instância */
export async function getInstanceStatus(instanceName: string): Promise<{ instance: { instanceName: string; state: string } }> {
  return evo("GET", `/instance/connectionState/${instanceName}`);
}

/** Atualiza o webhook de uma instância para receber eventos */
export async function setWebhook(instanceName: string, webhookUrl: string): Promise<unknown> {
  return evo("POST", `/webhook/set/${instanceName}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: true,
      events: ["MESSAGES_UPSERT"],
    },
  });
}

/** Desconecta e remove uma instância */
export async function deleteInstance(instanceName: string): Promise<unknown> {
  // Evolution API exige DELETE sem body mas aceita query param ou path — alguns versões precisam de logout antes
  try { await evo("DELETE", `/instance/logout/${instanceName}`); } catch { /* ignora se já desconectado */ }
  return evo("DELETE", `/instance/delete/${instanceName}`);
}

/** Lista todas as instâncias */
export async function listInstances(): Promise<unknown[]> {
  return evo("GET", "/instance/fetchInstances");
}

// ---------- Envio com comportamento mais humano ----------
// Toda mensagem passa por uma fila por instância: pausa aleatória entre envios,
// "digitando…" antes de cada mensagem e limite diário de conversas novas no privado.

const MIN_GAP_MS = (parseFloat(process.env.SEND_DELAY_MIN_S || "5") || 5) * 1000;
const MAX_GAP_MS = Math.max(MIN_GAP_MS, (parseFloat(process.env.SEND_DELAY_MAX_S || "20") || 20) * 1000);

const queues = new Map<string, Promise<unknown>>();
const lastSentAt = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomGap = () => MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);

/** "Digitando…" proporcional ao texto: ~1,5s a 6s */
const typingMs = (text: string) => Math.round(Math.min(6000, Math.max(1500, 1000 + text.length * 25)) * (0.8 + Math.random() * 0.4));

const isPrivate = (number: string) => !number.endsWith("@g.us");
const digits = (number: string) => number.split("@")[0].replace(/\D/g, "");

/** Bloqueia conversa NOVA no privado se o limite do dia já foi atingido */
async function checkNewContactLimit(number: string) {
  const known = await queryOne("SELECT 1 FROM whatsapp_dm_log WHERE number = $1 LIMIT 1", [digits(number)]);
  if (known) return;
  const limitRow = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'dm_new_daily_limit'");
  const limit = parseInt(limitRow?.value || "30") || 30;
  const today = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT number FROM whatsapp_dm_log GROUP BY number
       HAVING MIN(sent_at) >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
     ) t`
  );
  if (parseInt(today!.count) >= limit) {
    throw new Error(`Limite diário de ${limit} conversas novas no privado atingido; tenta de novo amanhã`);
  }
}

/** Envia mensagem de texto para um número ou grupo (ex: 1203630xxx@g.us), pela fila */
export function sendText(instanceName: string, number: string, text: string): Promise<unknown> {
  const previous = queues.get(instanceName) || Promise.resolve();
  const job = previous
    .catch(() => {})
    .then(async () => {
      const wait = (lastSentAt.get(instanceName) || 0) + randomGap() - Date.now();
      if (wait > 0) await sleep(wait);
      const dm = isPrivate(number);
      if (dm) await checkNewContactLimit(number);
      try {
        // "delay" faz a Evolution mostrar "digitando…" antes de enviar
        const result = await evo("POST", `/message/sendText/${instanceName}`, { number, text, delay: typingMs(text) });
        if (dm) await query("INSERT INTO whatsapp_dm_log (number) VALUES ($1)", [digits(number)]).catch(() => {});
        return result;
      } finally {
        lastSentAt.set(instanceName, Date.now());
      }
    });
  queues.set(instanceName, job);
  return job;
}

/** Lista os grupos dos quais a instância participa */
export async function fetchGroups(instanceName: string): Promise<{ id: string; subject: string; size?: number }[]> {
  return evo("GET", `/group/fetchAllGroups/${instanceName}?getParticipants=false`);
}

/** Verifica se uma instância existe e retorna o token dela se existir */
export async function instanceExists(instanceName: string): Promise<{ exists: boolean; token?: string }> {
  try {
    const list = await listInstances() as any[];
    const found = list.find((i: any) =>
      i.name === instanceName ||
      i.instanceName === instanceName ||
      i.instance?.instanceName === instanceName
    );
    return { exists: !!found, token: found?.token };
  } catch {
    return { exists: false };
  }
}
