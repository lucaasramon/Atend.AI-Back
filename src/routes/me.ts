/**
 * Minha conta (qualquer pessoa logada, inclusive o perfil "member"):
 *   GET/PUT /api/me/profile   dados do login + o próprio cadastro da igreja (mesmo WhatsApp)
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";
import { GENDERS, MARITAL } from "./forms";

const router = Router();

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cadastro da igreja com o mesmo WhatsApp do usuário (DDD + 8 últimos dígitos) */
const myPerson = (userId: string) =>
  queryOne<any>(
    `SELECT p.id, p.name, p.birth_date, p.whatsapp, p.email, p.gender, p.marital_status, p.neighborhood,
            p.relation, p.baptized, p.interests
       FROM people p JOIN users u ON u.id = $1
      WHERE u.whatsapp IS NOT NULL AND left(p.whatsapp, 4) = left(u.whatsapp, 4) AND right(p.whatsapp, 8) = right(u.whatsapp, 8)
      ORDER BY p.created_at LIMIT 1`,
    [userId]
  );

// GET /api/me/profile
router.get("/profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const [account, person, ministries] = await Promise.all([
      queryOne("SELECT email, full_name, whatsapp, role, church_role FROM users WHERE id = $1", [req.auth!.userId]),
      myPerson(req.auth!.userId),
      query("SELECT id, name, color FROM ministries ORDER BY name"),
    ]);
    return res.json({ account, person, ministries });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PUT /api/me/profile  { name, birth_date, gender, marital_status, neighborhood, baptized, interests }
router.put("/profile", requireAuth, async (req: Request, res: Response) => {
  const b = req.body || {};
  const name = str(b.name, 120);
  const birth = str(b.birth_date, 10);
  if (name.length < 3) return res.status(400).json({ error: "Informe o seu nome completo" });
  if (birth && (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || birth < "1900-01-01" || birth > new Date().toISOString().slice(0, 10))) {
    return res.status(400).json({ error: "Data de nascimento inválida" });
  }
  try {
    const person = await myPerson(req.auth!.userId);
    if (!person) return res.status(404).json({ error: "Você ainda não preencheu o cadastro da igreja" });
    const valid = await query<{ id: string }>("SELECT id FROM ministries WHERE id = ANY($1::uuid[])", [
      (Array.isArray(b.interests) ? b.interests : []).filter((x: unknown) => typeof x === "string" && UUID_RE.test(x)),
    ]);
    await query(
      `UPDATE people SET name = $1, birth_date = $2, gender = $3, marital_status = $4, neighborhood = $5,
              baptized = $6, interests = $7, updated_at = NOW()
        WHERE id = $8`,
      [
        name, birth || null, oneOf(b.gender, GENDERS), oneOf(b.marital_status, MARITAL), str(b.neighborhood, 120) || null,
        person.relation === "visitor" ? null : typeof b.baptized === "boolean" ? b.baptized : null,
        JSON.stringify(valid.map((v) => v.id)), person.id,
      ]
    );
    // O nome do membro também é o nome do login; o da equipe é cuidado pelo admin em Usuários
    if (req.auth!.role === "member") await query("UPDATE users SET full_name = $1, updated_at = NOW() WHERE id = $2", [name, req.auth!.userId]);
    return res.json({ person: await myPerson(req.auth!.userId) });
  } catch (error) {
    console.error("My profile error:", error);
    return res.status(400).json({ error: "Não foi possível salvar" });
  }
});

export default router;
