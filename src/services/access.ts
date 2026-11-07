/**
 * Acesso de usuários da equipe: senha temporária, link de primeiro acesso
 * e envio das credenciais pelo WhatsApp.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { query, queryOne } from "../db";
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
  member: "Membro",
};

/** Usuário da plataforma com o mesmo WhatsApp (mesmo DDD e 8 últimos dígitos: com ou sem o 9) */
export const userByPhone = (phone: string) =>
  queryOne<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM users
      WHERE whatsapp IS NOT NULL AND left(whatsapp, 4) = left($1, 4) AND right(whatsapp, 8) = right($1, 8)
      ORDER BY created_at LIMIT 1`,
    [phone]
  );

/**
 * Cria o acesso de membro (perfil "member"). Sem senha: fica com uma aleatória
 * até a pessoa usar o link de primeiro acesso.
 */
export async function createMemberUser(p: { name: string; email: string; whatsapp: string }, password?: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, full_name, whatsapp) VALUES ($1, $2, 'member', $3, $4) RETURNING id`,
    [p.email.trim().toLowerCase(), await bcrypt.hash(password || crypto.randomBytes(16).toString("hex"), 12), p.name, p.whatsapp]
  );
  return row!.id;
}

type AccessUser = { full_name: string | null; email: string; whatsapp: string; role: string };

export const accessLink = (token: string) => `${appUrl()}/primeiro-acesso?token=${token}`;

/** Texto com link, login e senha temporária (enviado pelo robô ou copiado pelo admin) */
export function accessMessageText(user: AccessUser, password: string, token: string): string {
  const link = accessLink(token);
  const firstName = (user.full_name || "").split(" ")[0];
  return [
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
}

// ---------- Esqueci minha senha ----------

const RESET_TOKEN_MINUTES = 60;

/**
 * Link de redefinição de senha (vale 1 hora). Usa o mesmo token do primeiro acesso;
 * a senha atual continua valendo até a pessoa usar o link.
 */
export async function issueResetToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `UPDATE users SET setup_token_hash = $1, setup_token_expires = NOW() + make_interval(mins => $2), updated_at = NOW() WHERE id = $3`,
    [hashToken(token), RESET_TOKEN_MINUTES, userId]
  );
  return token;
}

/** Envia pelo robô da agenda o link para criar uma senha nova */
export async function sendResetMessage(user: { full_name: string | null; whatsapp: string }, token: string): Promise<void> {
  const firstName = (user.full_name || "").split(" ")[0];
  const text = [
    `Olá${firstName ? `, ${firstName}` : ""}! 🔐`,
    "Recebemos um pedido para redefinir a sua senha do *D.Sync*.",
    "",
    `🔗 Crie uma senha nova por este link (vale ${RESET_TOKEN_MINUTES} minutos):`,
    `${appUrl()}/reset-password?token=${token}`,
    "",
    "Se não foi você, ignore esta mensagem: a sua senha atual continua valendo.",
  ].join("\n");
  const { instance } = await getReminderSettings();
  await sendText(instance, user.whatsapp, text);
}

/** Envia pelo robô da agenda a mensagem com link, login e senha temporária */
export async function sendAccessMessage(user: AccessUser, password: string, token: string): Promise<void> {
  const { instance } = await getReminderSettings();
  // Pela fila central (pausa, "digitando…" e limite de conversas novas)
  await sendText(instance, user.whatsapp, accessMessageText(user, password, token));
}
