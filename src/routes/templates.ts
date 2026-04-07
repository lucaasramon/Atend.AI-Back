import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/templates
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT * FROM response_templates WHERE tenant_id = $1 ORDER BY created_at ASC",
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/templates/count
router.get("/count", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM response_templates WHERE tenant_id = $1",
      [req.auth!.userId]
    );
    return res.json({ count: parseInt(rows[0].count) });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/templates
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const { shortcut, content, category } = req.body;
  if (!shortcut || !content) return res.status(400).json({ error: "Atalho e conteúdo são obrigatórios" });

  try {
    const id = uuidv4();
    const row = await queryOne(
      `INSERT INTO response_templates (id, tenant_id, shortcut, content, category, is_active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [id, req.auth!.userId, shortcut, content, category || "geral"]
    );
    return res.status(201).json(row);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/templates/:id
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { shortcut, content, category, is_active } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE response_templates SET
         shortcut = COALESCE($1, shortcut),
         content = COALESCE($2, content),
         category = COALESCE($3, category),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = $5 AND tenant_id = $6 RETURNING *`,
      [shortcut, content, category, is_active, req.params.id, req.auth!.userId]
    );
    if (!updated) return res.status(404).json({ error: "Não encontrado" });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/templates/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    await query(
      "DELETE FROM response_templates WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.auth!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
