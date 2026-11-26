/**
 * Convites para a equipe
 *   /api/invites                 (admin e líderes) criar, listar, reenviar e cancelar
 *                                líder: só convida como Visualizador, para as áreas que lidera, e só vê/mexe nos convites delas
 *   /api/public/invites/:token   (sem login) a pessoa vê o convite e completa o cadastro
 */
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { resolveWhatsapp, userByPhone } from "../services/access";
import { CHURCH_ROLES, LEADER_BLOCKED_CHURCH_ROLES, leaderMinistryIds } from "../services/userAreas";
import {
  Invite, InviteError, acceptInvite, inviteLink, inviteMessage, inviteUsed, openInviteByToken, publicInvite, renewToken, sendInvite,
} from "../services/invites";
import { hasKidsAccess } from "../services/kids";
import { hasCarsAccess } from "../services/cars";
import { hasMediaAccess } from "../services/screenRequests";

const TEAM_ROLES = ["admin", "agenda", "viewer"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const LIST = `
  SELECT i.id, i.full_name, i.whatsapp, i.role, i.church_role, i.ministry_ids, i.expires_at, i.sent_at, i.send_error,
         i.accepted_at, i.created_at, u.email AS accepted_email,
         CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.expires_at <= NOW() THEN 'expired' ELSE 'pending' END AS status,
         (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'color', m.color) ORDER BY m.name), '[]')
            FROM ministries m WHERE m.id = ANY(i.ministry_ids)) AS ministries
    FROM team_invites i
    LEFT JOIN users u ON u.id = i.user_id`;

const getInvite = (id: string) => queryOne<any>(`${LIST} WHERE i.id = $1`, [id]);

const audit = (adminId: string, action: string, targetId: string, details: object) =>
  query("INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, $2, 'invite', $3, $4)", [
    adminId, action, targetId, JSON.stringify(details),
  ]);

// ---------- Admin e líderes ----------

export const inviteRouter = Router();

/**
 * Admin: tudo (null). Líder: as áreas que lidera. Outros: 403.
 * O líder vê e mexe nos convites que ele mandou ou que são das áreas dele.
 */
async function inviteScope(req: Request, res: Response): Promise<{ areas: string[] | null } | null> {
  if (req.auth!.role === "admin") return { areas: null };
  const areas = await leaderMinistryIds(req.auth!.userId, req.auth!.role);
  if (!areas.length) {
    res.status(403).json({ error: "Só administradores e líderes de área podem convidar." });
    return null;
  }
  return { areas };
}
const SCOPE_SQL = "(i.invited_by = $1 OR i.ministry_ids && $2::uuid[])";

const requireTeam = requireRole("admin", "agenda", "viewer");

// GET /api/invites  (em aberto e os aceitos nos últimos 30 dias)
inviteRouter.get("/", requireTeam, async (req: Request, res: Response) => {
  try {
    const scope = await inviteScope(req, res);
    if (!scope) return;
    const where = `i.cancelled_at IS NULL AND (i.accepted_at IS NULL OR i.accepted_at > NOW() - INTERVAL '30 days')`;
    const order = "ORDER BY (i.accepted_at IS NOT NULL), i.created_at DESC";
    return res.json(
      scope.areas === null
        ? await query(`${LIST} WHERE ${where} ${order}`)
        : await query(`${LIST} WHERE ${where} AND ${SCOPE_SQL} ${order}`, [req.auth!.userId, scope.areas])
    );
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/invites  { full_name, whatsapp, role, church_role?, ministry_ids?, send? (padrão: robô envia) }
inviteRouter.post("/", requireTeam, async (req: Request, res: Response) => {
  const b = req.body || {};
  const full_name = str(b.full_name, 120);
  let role = str(b.role, 20);
  const church_role = str(b.church_role, 60) || null;
  let ministry_ids = (Array.isArray(b.ministry_ids) ? b.ministry_ids : []).filter((x: unknown) => typeof x === "string" && UUID_RE.test(x));
  if (full_name.length < 2) return res.status(400).json({ error: "Informe o nome" });
  if (!str(b.whatsapp, 30)) return res.status(400).json({ error: "Informe o WhatsApp" });
  if (church_role && !CHURCH_ROLES.includes(church_role)) return res.status(400).json({ error: "Função inválida" });

  try {
    const scope = await inviteScope(req, res);
    if (!scope) return;
    if (scope.areas !== null) {
      // Líder: convida só como Visualizador, sem função de liderança/pastoreio, para as áreas que lidera
      role = "viewer";
      if (church_role && LEADER_BLOCKED_CHURCH_ROLES.includes(church_role)) {
        return res.status(403).json({ error: "Essa função só o administrador pode dar." });
      }
      ministry_ids = ministry_ids.filter((id: string) => scope.areas!.includes(id));
      if (!ministry_ids.length) ministry_ids = scope.areas;
    }
    if (!TEAM_ROLES.includes(role)) return res.status(400).json({ error: "Perfil inválido" });

    const r = await resolveWhatsapp(str(b.whatsapp, 30));
    if (!r.exists || !r.jid) return res.status(400).json({ error: "Esse número não tem WhatsApp" });
    const number = r.jid.split("@")[0];

    const existing = await userByPhone(number);
    if (existing && TEAM_ROLES.includes(existing.role)) {
      return res.status(409).json({ error: `Esse WhatsApp já é da equipe (${existing.email}). Edite o usuário na lista.` });
    }
    const valid = (await query<{ id: string }>("SELECT id FROM ministries WHERE id = ANY($1::uuid[])", [ministry_ids])).map((m) => m.id);

    // Um convite em aberto por número: o anterior deixa de valer
    await query(
      `UPDATE team_invites SET cancelled_at = NOW()
        WHERE accepted_at IS NULL AND cancelled_at IS NULL AND left(whatsapp, 4) = left($1, 4) AND right(whatsapp, 8) = right($1, 8)`,
      [number]
    );
    const row = await queryOne<Invite>(
      `INSERT INTO team_invites (token_hash, full_name, whatsapp, role, church_role, ministry_ids, invited_by, expires_at)
       VALUES (md5(random()::text), $1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [full_name, number, role, church_role, valid, req.auth!.userId]
    );
    const token = await renewToken(row!.id);
    const inv = (await queryOne<Invite>("SELECT * FROM team_invites WHERE id = $1", [row!.id]))!;
    const send = b.send !== false;
    if (send) sendInvite(inv, token);
    await audit(req.auth!.userId, "create_invite", inv.id, { full_name, whatsapp: number, role, church_role, ministry_ids: valid, send });
    return res.status(201).json({ ...(await getInvite(inv.id)), link: inviteLink(token), message: await inviteMessage(inv, token), sending: send });
  } catch (error: any) {
    console.error("Create invite error:", error);
    return res.status(500).json({ error: error.message || "Erro interno do servidor" });
  }
});

// POST /api/invites/:id/resend  { send? }  (link novo, prazo renovado)
inviteRouter.post("/:id/resend", requireTeam, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Convite não encontrado" });
  try {
    const scope = await inviteScope(req, res);
    if (!scope) return;
    const inv = await queryOne<Invite>(
      `SELECT i.* FROM team_invites i WHERE i.id = $3 AND i.accepted_at IS NULL AND i.cancelled_at IS NULL
          AND ($2::uuid[] IS NULL OR ${SCOPE_SQL})`,
      [req.auth!.userId, scope.areas, req.params.id]
    );
    if (!inv) return res.status(404).json({ error: "Convite não encontrado ou já usado" });
    const token = await renewToken(inv.id);
    const send = req.body?.send !== false;
    if (send) sendInvite(inv, token);
    await audit(req.auth!.userId, "resend_invite", inv.id, { send });
    return res.json({ ...(await getInvite(inv.id)), link: inviteLink(token), message: await inviteMessage(inv, token), sending: send });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/invites/:id  (cancela: o link deixa de funcionar)
inviteRouter.delete("/:id", requireTeam, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Convite não encontrado" });
  try {
    const scope = await inviteScope(req, res);
    if (!scope) return;
    const row = await queryOne(
      `UPDATE team_invites i SET cancelled_at = NOW()
        WHERE i.id = $3 AND i.accepted_at IS NULL AND i.cancelled_at IS NULL AND ($2::uuid[] IS NULL OR ${SCOPE_SQL})
        RETURNING i.id`,
      [req.auth!.userId, scope.areas, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Convite não encontrado ou já usado" });
    await audit(req.auth!.userId, "cancel_invite", req.params.id, {});
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------- Público (página do convite) ----------

export const publicInviteRouter = Router();
const EXPIRED = "Este convite expirou ou já foi usado. Peça um novo ao administrador.";

/** Por que o link não vale mais (quem já concluiu é mandado para o login, sem susto) */
async function closedReason(token: string): Promise<{ error: string; done?: boolean }> {
  const used = await inviteUsed(token);
  return used ? { error: "Você já concluiu o seu cadastro. É só entrar com o seu e-mail e a sua senha.", done: true } : { error: EXPIRED };
}

// Limites folgados: no culto, várias pessoas usam o mesmo Wi-Fi (mesmo IP). O token do link já é impossível de adivinhar.
publicInviteRouter.get("/:token", rateLimit(300, 10 * 60_000), async (req: Request, res: Response) => {
  try {
    const inv = await openInviteByToken(req.params.token);
    return inv ? res.json(await publicInvite(inv)) : res.status(404).json(await closedReason(req.params.token));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/public/invites/:token  { full_name, email, password }  → já entra logado
publicInviteRouter.post("/:token", rateLimit(100, 15 * 60_000), async (req: Request, res: Response) => {
  const full_name = str(req.body?.full_name, 120);
  const email = str(req.body?.email, 120).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (full_name.length < 3) return res.status(400).json({ error: "Informe o seu nome completo" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido" });
  if (password.length < 6) return res.status(400).json({ error: "A senha deve ter no mínimo 6 caracteres" });
  if (password.length > 200) return res.status(400).json({ error: "Senha longa demais" });

  try {
    const inv = await openInviteByToken(req.params.token);
    if (!inv) return res.status(404).json(await closedReason(req.params.token));
    const userId = await acceptInvite(inv, { full_name, email, password });
    const user = (await queryOne<{ id: string; email: string; role: string }>("SELECT id, email, role FROM users WHERE id = $1", [userId]))!;
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET!, {
      expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as any,
    });
    const [kids_access, cars_access, media_access] = await Promise.all([
      hasKidsAccess(user.id, user.role),
      hasCarsAccess(user.id, user.role),
      hasMediaAccess(user.id, user.role),
    ]);
    return res.status(201).json({ token, user: { ...user, kids_access, cars_access, media_access } });
  } catch (error: any) {
    if (error instanceof InviteError) return res.status(error.status).json({ error: error.message });
    console.error("Accept invite error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});
