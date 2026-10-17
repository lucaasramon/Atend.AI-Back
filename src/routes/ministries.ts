import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { getAllowedGroups } from "../services/reminders";

const router = Router();
const requireReader = requireRole("admin", "agenda", "viewer");

const SELECT = `
  SELECT m.*,
         l.full_name AS leader_name, l.whatsapp AS leader_whatsapp,
         p.full_name AS pastor_name, p.whatsapp AS pastor_whatsapp
    FROM ministries m
    LEFT JOIN users l ON l.id = m.leader_id
    LEFT JOIN users p ON p.id = m.pastor_id`;

/** Grupo do ministério passa a ser liberado para o robô automaticamente */
async function allowGroup(jid: string | null) {
  if (!jid) return;
  const allowed = await getAllowedGroups();
  if (allowed.includes(jid)) return;
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('allowed_groups', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [[...allowed, jid].join(",")]
  );
}

function validate(body: any): string | null {
  if (body.name !== undefined && !String(body.name).trim()) return "Nome é obrigatório";
  if (body.group_jid && !/^\d+@g\.us$/.test(body.group_jid)) return "Grupo inválido";
  if (body.color && !/^#[0-9a-fA-F]{6}$/.test(body.color)) return "Cor inválida (use #RRGGBB)";
  return null;
}

// GET /api/ministries
router.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query(`${SELECT} ORDER BY m.name`));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/ministries  { name, group_jid?, leader_id?, pastor_id?, color?, is_media? }
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const { name, group_jid, leader_id, pastor_id, color, is_media } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Nome é obrigatório" });
  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO ministries (name, group_jid, leader_id, pastor_id, color, is_media)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name.trim(), group_jid || null, leader_id || null, pastor_id || null, color || null, !!is_media]
    );
    await allowGroup(group_jid || null);
    return res.status(201).json(await queryOne(`${SELECT} WHERE m.id = $1`, [row!.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um ministério com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/ministries/:id  (campos enviados como "" ou null são limpos)
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const b = req.body;
  const has = (k: string) => k in b;
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE ministries SET
         name      = COALESCE(NULLIF(TRIM($1), ''), name),
         group_jid = CASE WHEN $2 THEN NULLIF($3, '') ELSE group_jid END,
         leader_id = CASE WHEN $4 THEN NULLIF($5, '')::uuid ELSE leader_id END,
         pastor_id = CASE WHEN $6 THEN NULLIF($7, '')::uuid ELSE pastor_id END,
         color     = CASE WHEN $8 THEN NULLIF($9, '') ELSE color END,
         is_media  = COALESCE($10, is_media)
       WHERE id = $11 RETURNING id`,
      [
        b.name ?? null,
        has("group_jid"), b.group_jid ?? "",
        has("leader_id"), b.leader_id ?? "",
        has("pastor_id"), b.pastor_id ?? "",
        has("color"), b.color ?? "",
        typeof b.is_media === "boolean" ? b.is_media : null,
        req.params.id,
      ]
    );
    if (!row) return res.status(404).json({ error: "Ministério não encontrado" });
    if (b.group_jid) await allowGroup(b.group_jid);
    return res.json(await queryOne(`${SELECT} WHERE m.id = $1`, [row.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um ministério com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/ministries/:id  (os eventos continuam, só perdem o vínculo)
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM ministries WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
