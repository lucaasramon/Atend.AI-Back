import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/notifications/client  (client — own notifications)
router.get("/client", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT * FROM client_notifications WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.auth!.userId]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/notifications/client/mark-read
router.patch("/client/mark-read", requireAuth, async (req: Request, res: Response) => {
  try {
    await query(
      "UPDATE client_notifications SET read = true WHERE tenant_id = $1 AND read = false",
      [req.auth!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/notifications/admin/unread-count
router.get("/admin/unread-count", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM admin_notifications WHERE read = false"
    );
    return res.json({ count: parseInt(rows[0].count) });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/notifications/admin  (admin)
router.get("/admin", requireAdmin, async (req: Request, res: Response) => {
  const { page = "0", limit = "20" } = req.query as Record<string, string>;
  const offset = parseInt(page) * parseInt(limit);
  try {
    const countRows = await query<{ count: string }>("SELECT COUNT(*) as count FROM admin_notifications");
    const total = parseInt(countRows[0].count);

    const rows = await query(
      `SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );
    return res.json({ data: rows, total });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/notifications/admin/:id/read
router.patch("/admin/:id/read", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("UPDATE admin_notifications SET read = true WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/notifications/admin  (create admin notification — from client onboarding)
router.post("/admin", requireAuth, async (req: Request, res: Response) => {
  const { type, user_name, company, phone, system_prompt, whatsapp_number, onboarding_data } = req.body;
  try {
    const id = uuidv4();
    const row = await queryOne(
      `INSERT INTO admin_notifications (id, user_id, type, user_name, company, phone, system_prompt, whatsapp_number, onboarding_data, user_email, read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT email FROM users WHERE id = $2), false)
       RETURNING *`,
      [id, req.auth!.userId, type || "onboarding_complete", user_name, company, phone, system_prompt, whatsapp_number, onboarding_data ? JSON.stringify(onboarding_data) : null]
    );
    return res.status(201).json(row);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
