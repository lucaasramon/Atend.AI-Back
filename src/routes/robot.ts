import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/robot/interruptions  (client — own)
router.get("/interruptions", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT * FROM robot_interruptions WHERE tenant_id = $1 AND is_active = true",
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/robot/interruptions/all  (admin)
router.get("/interruptions/all", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      "SELECT * FROM robot_interruptions ORDER BY created_at DESC LIMIT 50"
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/robot/interruptions/count  (for dashboard)
router.get("/interruptions/count", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM robot_interruptions WHERE tenant_id = $1 AND is_active = true",
      [req.auth!.userId]
    );
    return res.json({ count: parseInt(rows[0].count) });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/robot/interruptions
router.post("/interruptions", requireAuth, async (req: Request, res: Response) => {
  const { remote_jid, contact_name, reason, expires_at } = req.body;
  if (!remote_jid) return res.status(400).json({ error: "remote_jid obrigatório" });

  try {
    const id = uuidv4();
    const row = await queryOne(
      `INSERT INTO robot_interruptions (id, tenant_id, remote_jid, contact_name, reason, expires_at, paused_at, created_by, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, true)
       RETURNING *`,
      [id, req.auth!.userId, remote_jid, contact_name || null, reason || null, expires_at || null, req.auth!.userId]
    );
    return res.status(201).json(row);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/robot/interruptions/:id
router.patch("/interruptions/:id", requireAuth, async (req: Request, res: Response) => {
  const { is_active } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE robot_interruptions SET is_active = $1
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [is_active, req.params.id, req.auth!.userId]
    );
    if (!updated) return res.status(404).json({ error: "Não encontrado" });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/robot/interruptions/resume-all  (resume all active)
router.patch("/interruptions/resume-all", requireAuth, async (req: Request, res: Response) => {
  try {
    await query(
      "UPDATE robot_interruptions SET is_active = false WHERE tenant_id = $1 AND is_active = true",
      [req.auth!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/robot/interruptions/resume-by-jid
router.patch("/interruptions/resume-by-jid", requireAuth, async (req: Request, res: Response) => {
  const { remote_jid } = req.body;
  try {
    await query(
      "UPDATE robot_interruptions SET is_active = false WHERE tenant_id = $1 AND remote_jid = $2",
      [req.auth!.userId, remote_jid]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
