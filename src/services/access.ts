/**
 * Acesso de usuários da equipe: senha temporária, link de primeiro acesso
 * e envio das credenciais pelo WhatsApp.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { query } from "../db";
import { getReminderSettings } from "./reminders";
import { sendText } from "./evolution";

const BASE_URL = (process.env.EVOLUTION_API_URL || "").replace(/\/$/, "");
const API_KEY = process.env.EVOLUTION_API_KEY || "";
const SETUP_TOKEN_DAYS = 7;

/** URL pública do frontend: APP_URL ou o primeiro endereço https de FRONTEND_URL */
export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const urls = (process.env.FRONTEND_URL || "").split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
  return urls.find((u) => u.startsWith("https://")) || urls[0] || "http://localhost:8081";
}

/** Senha temporária legível (sem caracteres ambíguos como 0/O, 1/l) */
export function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * Define uma senha temporária e um novo link de primeiro acesso para o usuário.
 * Retorna a senha e o token em texto (só existem aqui; no banco ficam hash).
 */
export async function issueTemporaryAccess(userId: string): Promise<{ password: string; token: string }> {
  const password = generateTempPassword();
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `UPDATE users SET
       password_hash = $1,
       must_change_password = true,
       setup_token_hash = $2,
       setup_token_expires = NOW() + make_interval(days => $3),
       updated_at = NOW()
     WHERE id = $4`,
    [await bcrypt.hash(password, 12), hashToken(token), SETUP_TOKEN_DAYS, userId]
  );
  return { password, token };
}

/** Só dígitos; sem DDI assume Brasil (55) */
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length <= 11 ? `55${digits}` : digits;
}

/**
 * Confere no WhatsApp como o número está registrado.
 * Necessário porque muitos números brasileiros antigos existem sem o 9 extra.
 */
export async function resolveWhatsapp(raw: string): Promise<{ exists: boolean; jid?: string; number: string }> {
  const number = normalizePhone(raw);
  const { instance } = await getReminderSettings();
  const res = await fetch(`${BASE_URL}/chat/whatsappNumbers/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: API_KEY },
    body: JSON.stringify({ numbers: [number] }),
  });
  if (!res.ok) throw new Error(`Não foi possível verificar o WhatsApp (${res.status})`);
  const [r] = (await res.json()) as { exists: boolean; jid: string }[];
  return { exists: !!r?.exists, jid: r?.jid, number };
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador",
  agenda: "Agenda",
  viewer: "Visualizador",
};

/** Envia pelo robô da agenda a mensagem com link, login e senha temporária */
export async function sendAccessMessage(
  user: { full_name: string | null; email: string; whatsapp: string; role: string },
  password: string,
  token: string
): Promise<void> {
  const { instance } = await getReminderSettings();
  const link = `${appUrl()}/primeiro-acesso?token=${token}`;
  const firstName = (user.full_name || "").split(" ")[0];
  const text = [
    `Olá${firstName ? `, ${firstName}` : ""}! 👋`,
    `Você recebeu acesso ao *D.Sync*, o sistema da agenda da igreja (perfil: ${ROLE_LABEL[user.role] || user.role}).`,
    "",
    `🔗 Defina sua senha por este link:`,
    link,
    "",
    `👤 Login: ${user.email}`,
    `🔑 Senha temporária: ${password}`,
    "",
    `O link vale por ${SETUP_TOKEN_DAYS} dias.`,
  ].join("\n");

  // Pela fila central (pausa, "digitando…" e limite de conversas novas)
  await sendText(instance, user.whatsapp, text);
}
