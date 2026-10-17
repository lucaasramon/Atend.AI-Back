import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";

const router = Router();
const requireReader = requireRole("admin", "agenda", "viewer");

// GET /api/locations
router.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query("SELECT * FROM locations ORDER BY active DESC, name"));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/locations/availability?from=&to=
// Reservas de cada local no período (eventos aprovados e pendentes)
router.get("/availability", requireReader, async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: "from e to são obrigatórios" });
  try {
    const rows = await query(
      `SELECT l.id AS location_id, e.id AS event_id, e.title, e.status, e.starts_at,
              COALESCE(e.ends_at, e.starts_at + INTERVAL '2 hours') AS ends_at
         FROM event_locations el
         JOIN locations l ON l.id = el.location_id
         JOIN events e ON e.id = el.event_id
        WHERE e.status <> 'rejected'
          AND e.starts_at < $2
          AND COALESCE(e.ends_at, e.starts_at + INTERVAL '2 hours') > $1
        ORDER BY e.starts_at`,
      [from, to]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(400).json({ error: "Parâmetros de data inválidos" });
  }
});

// POST /api/locations  { name }
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nome é obrigatório" });
  try {
    return res.status(201).json(await queryOne("INSERT INTO locations (name) VALUES ($1) RETURNING *", [name]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um local com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/locations/:id  { name?, active? }
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { name, active } = req.body;
  try {
    const row = await queryOne(
      `UPDATE locations SET name = COALESCE(NULLIF(TRIM($1), ''), name), active = COALESCE($2, active)
        WHERE id = $3 RETURNING *`,
      [name ?? null, typeof active === "boolean" ? active : null, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Local não encontrado" });
    return res.json(row);
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um local com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/locations/:id
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM locations WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
