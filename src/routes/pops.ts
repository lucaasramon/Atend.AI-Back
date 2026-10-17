import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { localDate } from "../services/reminders";
import { startPopRun } from "../services/pops";

const router = Router();
const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");

const SELECT = `
  SELECT p.*, m.name AS ministry_name, m.color AS ministry_color,
         (SELECT json_build_object('id', r.id, 'run_date', to_char(r.run_date, 'YYYY-MM-DD'), 'checked', r.checked, 'sent', r.sent)
            FROM pop_runs r WHERE r.pop_id = p.id ORDER BY r.run_date DESC LIMIT 1) AS last_run
    FROM pops p LEFT JOIN ministries m ON m.id = p.ministry_id`;

function parseBody(b: any): { error?: string; values?: any[] } {
  const title = String(b.title || "").trim();
  if (!title) return { error: "Informe o título" };
  const steps = Array.isArray(b.steps) ? b.steps.map((s: any) => String(s).trim()).filter(Boolean) : [];
  if (!steps.length) return { error: "Informe ao menos um passo" };
  const recurrence = ["none", "weekly", "monthly"].includes(b.recurrence) ? b.recurrence : "none";
  const weekday = recurrence === "weekly" ? Number(b.weekday) : null;
  const monthDay = recurrence === "monthly" ? Number(b.month_day) : null;
  if (recurrence === "weekly" && !(weekday! >= 0 && weekday! <= 6)) return { error: "Escolha o dia da semana" };
  if (recurrence === "monthly" && !(monthDay! >= 1 && monthDay! <= 31)) return { error: "Escolha o dia do mês" };
  return {
    values: [
      b.ministry_id || null, title, String(b.description || "").trim() || null, JSON.stringify(steps),
      String(b.link || "").trim() || null, recurrence, weekday, monthDay, b.active !== false,
    ],
  };
}

// GET /api/pops
router.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query(`${SELECT} ORDER BY m.name NULLS FIRST, p.title`));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/pops
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const p = parseBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO pops (ministry_id, title, description, steps, link, recurrence, weekday, month_day, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      p.values
    );
    return res.status(201).json(await queryOne(`${SELECT} WHERE p.id = $1`, [row!.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// PUT /api/pops/:id
router.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  const p = parseBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE pops SET ministry_id = $1, title = $2, description = $3, steps = $4, link = $5,
              recurrence = $6, weekday = $7, month_day = $8, active = $9
        WHERE id = $10 RETURNING id`,
      [...p.values!, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "POP não encontrado" });
    return res.json(await queryOne(`${SELECT} WHERE p.id = $1`, [row.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// DELETE /api/pops/:id
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM pops WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/pops/:id/runs  (histórico)
router.get("/:id/runs", requireReader, async (req: Request, res: Response) => {
  try {
    return res.json(
      await query(
        `SELECT r.id, to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.checked, r.sent, r.updated_at, u.full_name AS updated_by_name
           FROM pop_runs r LEFT JOIN users u ON u.id = r.updated_by
          WHERE r.pop_id = $1 ORDER BY r.run_date DESC LIMIT 20`,
        [req.params.id]
      )
    );
  } catch (error) {
    return res.status(400).json({ error: "POP inválido" });
  }
});

// POST /api/pops/:id/runs  { send?: boolean }  (abre a execução de hoje; admin pode enviar no grupo)
router.post("/:id/runs", requireEditor, async (req: Request, res: Response) => {
  try {
    const send = req.body.send === true && req.auth!.role === "admin";
    const today = localDate(new Date());
    if (send) return res.json(await startPopRun(req.params.id, today, true));
    await query("INSERT INTO pop_runs (pop_id, run_date) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.id, today]);
    return res.json(await queryOne("SELECT id FROM pop_runs WHERE pop_id = $1 AND run_date = $2", [req.params.id, today]));
  } catch (error: any) {
    return res.status(400).json({ error: error.message || "Dados inválidos" });
  }
});

// PATCH /api/pops/runs/:runId  { checked: number[] }
router.patch("/runs/:runId", requireEditor, async (req: Request, res: Response) => {
  const checked = Array.isArray(req.body.checked) ? req.body.checked.filter((n: any) => Number.isInteger(n) && n >= 0) : null;
  if (!checked) return res.status(400).json({ error: "checked deve ser uma lista" });
  try {
    const row = await queryOne(
      "UPDATE pop_runs SET checked = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING id, checked",
      [JSON.stringify(Array.from(new Set(checked))), req.auth!.userId, req.params.runId]
    );
    if (!row) return res.status(404).json({ error: "Execução não encontrada" });
    return res.json(row);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

export default router;
