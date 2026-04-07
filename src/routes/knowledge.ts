import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/knowledge
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT * FROM knowledge_base WHERE tenant_id = $1 ORDER BY created_at ASC",
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/knowledge
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const { question, answer, category } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Pergunta e resposta são obrigatórias" });

  try {
    const id = uuidv4();
    const row = await queryOne(
      `INSERT INTO knowledge_base (id, tenant_id, question, answer, category, is_active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [id, req.auth!.userId, question, answer, category || "geral"]
    );
    return res.status(201).json(row);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/knowledge/:id
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { question, answer, category, is_active } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE knowledge_base SET
         question = COALESCE($1, question),
         answer = COALESCE($2, answer),
         category = COALESCE($3, category),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = $5 AND tenant_id = $6 RETURNING *`,
      [question, answer, category, is_active, req.params.id, req.auth!.userId]
    );
    if (!updated) return res.status(404).json({ error: "Não encontrado" });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/knowledge/:id
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    await query(
      "DELETE FROM knowledge_base WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.auth!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
