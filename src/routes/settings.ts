import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// GET /api/settings
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await query("SELECT key, value FROM system_settings");
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PUT /api/settings  (upsert multiple settings at once)
router.put("/", requireAdmin, async (req: Request, res: Response) => {
  const settings: Record<string, string> = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      const existing = await queryOne("SELECT id FROM system_settings WHERE key = $1", [key]);
      if (existing) {
        await query(
          "UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = $2",
          [String(value), key]
        );
      } else {
        await query(
          "INSERT INTO system_settings (id, key, value, updated_at) VALUES ($1, $2, $3, NOW())",
          [uuidv4(), key, String(value)]
        );
      }
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
