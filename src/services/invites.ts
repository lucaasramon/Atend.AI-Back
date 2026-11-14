/**
 * Convites para a equipe: o admin informa nome, WhatsApp, perfil, função e áreas;
 * o robô manda o link e a pessoa completa o cadastro (nome, e-mail e senha).
 * O token só existe no link; no banco fica o hash.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { query, queryOne } from "../db";
import { appUrl, hashToken, userByPhone } from "./access";
import { getReminderSettings } from "./reminders";
import { sendText } from "./evolution";
import { setUserMinistries, userMinistryIds } from "./userAreas";
import { syncMemberFromUser } from "./members";

export const INVITE_DAYS = 7;

export class InviteError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface Invite {
  id: string;
  full_name: string;
  whatsapp: string;
  role: "admin" | "agenda" | "viewer";
  church_role: string | null;
  ministry_ids: string[];
  expires_at: string;
  sent_at: string | null;
  send_error: string | null;
  accepted_at: string | null;
  user_id: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export const inviteLink = (token: string) => `${appUrl()}/convite?token=${token}`;

const areaNames = async (ids: string[]) =>
  (await query<{ name: string }>("SELECT name FROM ministries WHERE id = ANY($1::uuid[]) ORDER BY name", [ids])).map((m) => m.name);

/** "Mídia" · "Mídia e Louvor" · "Mídia, Louvor e Som" */
const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`);

export async function inviteMessage(inv: Pick<Invite, "full_name" | "ministry_ids">, token: string): Promise<string> {
  const first = inv.full_name.trim().split(" ")[0];
  const names = await areaNames(inv.ministry_ids);
  return [
    `Olá${first ? `, ${first}` : ""}! 👋`,
    `Você foi convidado(a) para a equipe${names.length ? ` da *${joinNames(names)}*` : ""} no *D.Sync*, a plataforma da agenda da igreja.`,
    "",
    "Complete o seu cadastro (nome, e-mail e senha) por este link:",
    inviteLink(token),
    "",
    `O link vale por ${INVITE_DAYS} dias.`,
  ].join("\n");
}

/** Novo token (o anterior deixa de valer) e prazo renovado */
export async function renewToken(inviteId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `UPDATE team_invites SET token_hash = $1, expires_at = NOW() + make_interval(days => $2), sent_at = NULL, send_error = NULL
      WHERE id = $3`,
    [hashToken(token), INVITE_DAYS, inviteId]
  );
  return token;
}

/** Manda pelo robô (fila do WhatsApp) e registra se foi ou o erro. Não trava a requisição. */
export function sendInvite(inv: Invite, token: string) {
  (async () => {
    try {
      const { instance } = await getReminderSettings();
      if (!instance) throw new Error("Robô do WhatsApp não configurado");
      await sendText(instance, inv.whatsapp, await inviteMessage(inv, token));
      await query("UPDATE team_invites SET sent_at = NOW(), send_error = NULL WHERE id = $1", [inv.id]);
    } catch (e) {
      console.error("[convite] envio falhou:", e);
      await query("UPDATE team_invites SET send_error = $2 WHERE id = $1", [inv.id, (e as Error).message || "falhou"]).catch(() => {});
    }
  })();
}

/** Convite válido do link (ou null) */
export const openInviteByToken = (token: string) =>
  /^[0-9a-f]{64}$/.test(token)
    ? queryOne<Invite>(
        `SELECT * FROM team_invites
          WHERE token_hash = $1 AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()`,
        [hashToken(token)]
      )
    : Promise.resolve(null);

/** O link é de um convite que a pessoa já concluiu? */
export const inviteUsed = async (token: string) =>
  /^[0-9a-f]{64}$/.test(token) &&
  !!(await queryOne("SELECT 1 FROM team_invites WHERE token_hash = $1 AND accepted_at IS NOT NULL", [hashToken(token)]));

/** Dados que a página do convite mostra */
export async function publicInvite(inv: Invite) {
  return {
    full_name: inv.full_name,
    role: inv.role,
    church_role: inv.church_role,
    areas: await areaNames(inv.ministry_ids),
  };
}

/**
 * A pessoa completou o cadastro: cria o usuário da equipe (ou promove o acesso de membro
 * que ela já tinha com o mesmo WhatsApp), coloca nas áreas e marca o convite como usado.
 */
export async function acceptInvite(inv: Invite, data: { full_name: string; email: string; password: string }): Promise<string> {
  const email = data.email.trim().toLowerCase();
  const sameEmail = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  const byPhone = await userByPhone(inv.whatsapp);
  const hash = await bcrypt.hash(data.password, 12);

  let userId: string;
  if (byPhone) {
    if (sameEmail && sameEmail.id !== byPhone.id) {
      throw new InviteError("Este e-mail já é usado por outra pessoa na plataforma. Use outro e-mail.", 409);
    }
    // Quem já é admin continua admin
    const role = byPhone.role === "admin" ? "admin" : inv.role;
    await query(
      `UPDATE users SET email = $1, full_name = $2, role = $3, church_role = COALESCE($4, church_role), password_hash = $5,
              must_change_password = false, setup_token_hash = NULL, setup_token_expires = NULL, updated_at = NOW()
        WHERE id = $6`,
      [email, data.full_name, role, inv.church_role, hash, byPhone.id]
    );
    userId = byPhone.id;
    await setUserMinistries(userId, [...new Set([...(await userMinistryIds(userId)), ...inv.ministry_ids])]);
  } else {
    if (sameEmail) throw new InviteError("Este e-mail já tem acesso à plataforma. Use outro e-mail ou fale com o administrador.", 409);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name, whatsapp, church_role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, hash, inv.role, data.full_name, inv.whatsapp, inv.church_role]
    );
    userId = row!.id;
    await setUserMinistries(userId, inv.ministry_ids);
  }

  // Só um aceite por convite (dois cliques ao mesmo tempo)
  const done = await queryOne(
    "UPDATE team_invites SET accepted_at = NOW(), user_id = $2 WHERE id = $1 AND accepted_at IS NULL RETURNING id",
    [inv.id, userId]
  );
  if (!done) throw new InviteError("Este convite já foi usado.", 409);
  await syncMemberFromUser(userId); // já entra nas escalas
  await query(
    "INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, 'accept_invite', 'user', $1, $2)",
    [userId, JSON.stringify({ invite_id: inv.id, email, role: inv.role })]
  );
  return userId;
}
