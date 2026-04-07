/**
 * Evolution API service
 * Docs: https://doc.evolution-api.com
 */

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
      webhookBase64: false,
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
