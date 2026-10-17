/**
 * Mensagens individuais (WhatsApp privado) para usuários da equipe,
 * enviadas pelo mesmo robô dos lembretes.
 */
import { query } from "../db";
import { sendText } from "./evolution";
import { getReminderSettings } from "./reminders";
import { appUrl } from "./access";

export { appUrl };

/** Envia para um número; retorna false (sem lançar erro) se falhar */
export async function sendDirect(whatsapp: string | null | undefined, text: string): Promise<boolean> {
  if (!whatsapp) return false;
  try {
    const { instance } = await getReminderSettings();
    if (!instance) return false;
    await sendText(instance, whatsapp, text);
    return true;
  } catch (err) {
    console.error("[notify] falha ao enviar para", whatsapp, err);
    return false;
  }
}

/** Envia o mesmo texto para vários usuários (pelo id); retorna quantos receberam */
export async function notifyUsers(userIds: (string | null | undefined)[], text: string): Promise<number> {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (!ids.length) return 0;
  const users = await query<{ whatsapp: string | null }>("SELECT whatsapp FROM users WHERE id = ANY($1)", [ids]);
  let sent = 0;
  for (const u of users) if (await sendDirect(u.whatsapp, text)) sent++;
  return sent;
}

/** Administradores com WhatsApp (aprovadores) */
export async function adminIds(): Promise<string[]> {
  const rows = await query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND whatsapp IS NOT NULL");
  return rows.map((r) => r.id);
}
