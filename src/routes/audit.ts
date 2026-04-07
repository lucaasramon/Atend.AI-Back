import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/audit
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  const { page = "0", limit = "20" } = req.query as Record<string, string>;
  const offset = parseInt(page) * parseInt(limit);
  try {
    const countRows = await query<{ count: string }>("SELECT COUNT(*) as count FROM audit_logs");
    const total = parseInt(countRows[0].count);

    const rows = await query(
      "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [parseInt(limit), offset]
    );
    return res.json({ data: rows, total });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/audit
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const { action, target_type, target_id, details } = req.body;
  try {
    const id = uuidv4();
    await query(
      `INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.auth!.userId, action, target_type, target_id || null, details ? JSON.stringify(details) : null]
    );
    return res.status(201).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
