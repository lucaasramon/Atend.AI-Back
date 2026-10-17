import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { query, queryOne } from "../db";
import { requireAdmin } from "../middleware/auth";
import { issueTemporaryAccess, resolveWhatsapp, sendAccessMessage } from "../services/access";

const router = Router();

// Perfis da equipe (o perfil "user" é cliente e fica na tela de Clientes)
const TEAM_ROLES = ["admin", "agenda", "viewer"];
const FIELDS = "id, email, full_name, whatsapp, role, must_change_password, created_at";

const audit = (adminId: string, action: string, targetId: string, details: object) =>
  query(
    `INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, $2, 'user', $3, $4)`,
    [adminId, action, targetId, JSON.stringify(details)]
  );

/** Confere o número e devolve como está registrado no WhatsApp (ex.: sem o 9 extra) */
async function checkWhatsapp(raw: string): Promise<string> {
  const r = await resolveWhatsapp(raw);
  if (!r.exists || !r.jid) throw Object.assign(new Error("Esse número não tem WhatsApp"), { status: 400 });
  return r.jid.split("@")[0];
}

/** Gera senha temporária + link e envia pelo WhatsApp. Não falha o cadastro se o envio falhar. */
async function grantAccess(user: any) {
  const { password, token } = await issueTemporaryAccess(user.id);
  try {
    await sendAccessMessage(user, password, token);
    return { whatsapp_sent: true as const };
  } catch (err: any) {
    console.error("Access message error:", err);
    // Admin repassa manualmente
    return { whatsapp_sent: false as const, whatsapp_error: err.message, temp_password: password };
  }
}

// GET /api/users
router.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT ${FIELDS} FROM users WHERE role = ANY($1) ORDER BY full_name NULLS LAST, email`,
      [TEAM_ROLES]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/users  { full_name, email, whatsapp, role }
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const { full_name, email, whatsapp, role } = req.body;
  if (!full_name?.trim() || !email?.trim() || !whatsapp?.trim() || !role) {
    return res.status(400).json({ error: "Nome, e-mail, WhatsApp e perfil são obrigatórios" });
  }
  if (!TEAM_ROLES.includes(role)) return res.status(400).json({ error: "Perfil inválido" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: "E-mail inválido" });

  try {
    const exists = await queryOne("SELECT id FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    if (exists) return res.status(409).json({ error: "Já existe um usuário com esse e-mail" });

    const number = await checkWhatsapp(whatsapp);

    // Senha aleatória provisória; a temporária de verdade é definida em grantAccess
    const user = await queryOne<any>(
      `INSERT INTO users (email, password_hash, role, full_name, whatsapp)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${FIELDS}`,
      [email.trim().toLowerCase(), await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 12), role, full_name.trim(), number]
    );

    const access = await grantAccess(user);
    await audit(req.auth!.userId, "create_user", user.id, { email: user.email, role, whatsapp_sent: access.whatsapp_sent });
    return res.status(201).json({ ...user, must_change_password: true, ...access });
  } catch (error: any) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error("Create user error:", error);
    return res.status(500).json({ error: error.message || "Erro interno do servidor" });
  }
});

// PATCH /api/users/:id  { full_name?, whatsapp?, role? }
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { full_name, whatsapp, role } = req.body;
  if (role && !TEAM_ROLES.includes(role)) return res.status(400).json({ error: "Perfil inválido" });

  try {
    const user = await queryOne<any>("SELECT id, role FROM users WHERE id = $1 AND role = ANY($2)", [req.params.id, TEAM_ROLES]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    if (role && role !== "admin" && user.role === "admin") {
      if (user.id === req.auth!.userId) return res.status(400).json({ error: "Você não pode remover o seu próprio perfil de admin" });
      const admins = await queryOne<{ count: string }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
      if (parseInt(admins!.count) <= 1) return res.status(400).json({ error: "É preciso manter pelo menos um admin" });
    }

    const number = whatsapp ? await checkWhatsapp(whatsapp) : null;
    const updated = await queryOne(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         whatsapp = COALESCE($2, whatsapp),
         role = COALESCE($3, role),
         updated_at = NOW()
       WHERE id = $4 RETURNING ${FIELDS}`,
      [full_name?.trim() || null, number, role || null, req.params.id]
    );
    await audit(req.auth!.userId, "update_user", req.params.id, { full_name, whatsapp: number, role });
    return res.json(updated);
  } catch (error: any) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/users/:id/resend  (nova senha temporária + novo link pelo WhatsApp)
router.post("/:id/resend", requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await queryOne<any>(`SELECT ${FIELDS} FROM users WHERE id = $1 AND role = ANY($2)`, [req.params.id, TEAM_ROLES]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (!user.whatsapp) return res.status(400).json({ error: "Usuário sem WhatsApp cadastrado" });
    if (user.id === req.auth!.userId) return res.status(400).json({ error: "Use a troca de senha para a sua própria conta" });

    const access = await grantAccess(user);
    await audit(req.auth!.userId, "resend_access", user.id, { whatsapp_sent: access.whatsapp_sent });
    return res.json(access);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/users/:id
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "Você não pode excluir a sua própria conta" });
    const user = await queryOne<any>("SELECT id, email, role FROM users WHERE id = $1 AND role = ANY($2)", [req.params.id, TEAM_ROLES]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.role === "admin") {
      const admins = await queryOne<{ count: string }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
      if (parseInt(admins!.count) <= 1) return res.status(400).json({ error: "É preciso manter pelo menos um admin" });
    }
    // Eventos criados por ele ficam (created_by vira NULL)
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    await audit(req.auth!.userId, "delete_user", req.params.id, { email: user.email, role: user.role });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
