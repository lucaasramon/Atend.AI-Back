import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

// GET /api/leads
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const { page = "0", limit = "20" } = req.query as Record<string, string>;
  const offset = parseInt(page) * parseInt(limit);
  const tenantId = req.auth!.userId;

  try {
    const countRows = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM leads WHERE tenant_id = $1",
      [tenantId]
    );
    const total = parseInt(countRows[0].count);

    const rows = await query(
      `SELECT * FROM leads WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, parseInt(limit), offset]
    );

    return res.json({ data: rows, total });
  } catch (error) {
    console.error("Get leads error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/leads/all  (for dashboard — no pagination)
router.get("/all", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT id, status, sentiment, source, created_at FROM leads WHERE tenant_id = $1",
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/leads/:id
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { saved, status, sentiment } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE leads SET
         saved = COALESCE($1, saved),
         status = COALESCE($2, status),
         sentiment = COALESCE($3, sentiment),
         updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [saved, status, sentiment, req.params.id, req.auth!.userId]
    );
    if (!updated) return res.status(404).json({ error: "Lead não encontrado" });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
