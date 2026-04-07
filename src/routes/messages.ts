import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

// GET /api/messages  (for dashboard stats)
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT id, from_me, created_at FROM messages WHERE tenant_id = $1",
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/messages/lead/:leadId
router.get("/lead/:leadId", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT id, from_me, content, created_at FROM messages
       WHERE tenant_id = $1 AND lead_id = $2
       ORDER BY created_at ASC LIMIT 100`,
      [req.auth!.userId, req.params.leadId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
