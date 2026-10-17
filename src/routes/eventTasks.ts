/**
 * Checklist dos eventos e modelos de checklist.
 * Montado em /api/events (antes do router de eventos).
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";

const router = Router();
const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TASK_SELECT = `
  SELECT t.id, t.event_id, t.title, t.assignee_id, t.assignee_name, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
         t.done, t.done_at, t.position, u.full_name AS assignee_full_name, d.full_name AS done_by_name
    FROM event_tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users d ON d.id = t.done_by`;

/** Itens de modelo: [{ title, days_before? }] */
function cleanItems(items: unknown): { title: string; days_before?: number }[] | null {
  if (!Array.isArray(items)) return null;
  const out = items
    .map((i: any) => ({
      title: String(i?.title || "").trim(),
      ...(Number.isInteger(i?.days_before) && i.days_before >= 0 && i.days_before <= 365 ? { days_before: i.days_before } : {}),
    }))
    .filter((i) => i.title);
  return out;
}

// GET /api/events/people  (pessoas da equipe para escolher responsáveis)
router.get("/people", requireReader, async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT id, COALESCE(full_name, email) AS name, (whatsapp IS NOT NULL) AS has_whatsapp
         FROM users WHERE role IN ('admin', 'agenda', 'viewer') ORDER BY 2`
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------- Modelos de checklist ----------

router.get("/checklist-templates", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query("SELECT * FROM checklist_templates ORDER BY name"));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/checklist-templates", requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();
  const items = cleanItems(req.body.items);
  if (!name || !items) return res.status(400).json({ error: "Nome e itens são obrigatórios" });
  try {
    return res.status(201).json(
      await queryOne("INSERT INTO checklist_templates (name, items) VALUES ($1, $2) RETURNING *", [name, JSON.stringify(items)])
    );
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um modelo com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.put("/checklist-templates/:id", requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();
  const items = cleanItems(req.body.items);
  if (!name || !items) return res.status(400).json({ error: "Nome e itens são obrigatórios" });
  try {
    const row = await queryOne("UPDATE checklist_templates SET name = $1, items = $2 WHERE id = $3 RETURNING *", [
      name, JSON.stringify(items), req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: "Modelo não encontrado" });
    return res.json(row);
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Já existe um modelo com esse nome" });
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.delete("/checklist-templates/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM checklist_templates WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------- Tarefas do evento ----------

// GET /api/events/:eventId/tasks
router.get("/:eventId/tasks", requireReader, async (req: Request, res: Response) => {
  try {
    return res.json(await query(`${TASK_SELECT} WHERE t.event_id = $1 ORDER BY t.position, t.created_at`, [req.params.eventId]));
  } catch (error) {
    return res.status(400).json({ error: "Evento inválido" });
  }
});

// POST /api/events/:eventId/tasks  { title, assignee_id?, assignee_name?, due_date? }
router.post("/:eventId/tasks", requireEditor, async (req: Request, res: Response) => {
  const { title, assignee_id, assignee_name, due_date } = req.body;
  if (!String(title || "").trim()) return res.status(400).json({ error: "Informe a tarefa" });
  if (due_date && !DATE_RE.test(due_date)) return res.status(400).json({ error: "Prazo inválido" });
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO event_tasks (event_id, title, assignee_id, assignee_name, due_date, position)
       VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(position) + 1 FROM event_tasks WHERE event_id = $1), 0))
       RETURNING id`,
      [req.params.eventId, String(title).trim(), assignee_id || null, assignee_name?.trim() || null, due_date || null]
    );
    return res.status(201).json(await queryOne(`${TASK_SELECT} WHERE t.id = $1`, [row!.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/events/:eventId/tasks/from-template  { template_id }
router.post("/:eventId/tasks/from-template", requireEditor, async (req: Request, res: Response) => {
  try {
    const ev = await queryOne<{ starts_at: Date }>("SELECT starts_at FROM events WHERE id = $1", [req.params.eventId]);
    const tpl = await queryOne<{ items: { title: string; days_before?: number }[] }>(
      "SELECT items FROM checklist_templates WHERE id = $1",
      [req.body.template_id]
    );
    if (!ev || !tpl) return res.status(404).json({ error: "Evento ou modelo não encontrado" });
    for (const item of tpl.items) {
      await query(
        `INSERT INTO event_tasks (event_id, title, due_date, position)
         VALUES ($1, $2,
                 CASE WHEN $3::int IS NULL THEN NULL
                      ELSE ((SELECT starts_at FROM events WHERE id = $1) AT TIME ZONE 'America/Sao_Paulo')::date - $3::int END,
                 COALESCE((SELECT MAX(position) + 1 FROM event_tasks WHERE event_id = $1), 0))`,
        [req.params.eventId, item.title, item.days_before ?? null]
      );
    }
    return res.json(await query(`${TASK_SELECT} WHERE t.event_id = $1 ORDER BY t.position, t.created_at`, [req.params.eventId]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// PATCH /api/events/tasks/:taskId  { title?, assignee_id?, assignee_name?, due_date?, done? }
router.patch("/tasks/:taskId", requireEditor, async (req: Request, res: Response) => {
  const b = req.body;
  if (b.due_date && !DATE_RE.test(b.due_date)) return res.status(400).json({ error: "Prazo inválido" });
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE event_tasks SET
         title         = COALESCE(NULLIF(TRIM($1), ''), title),
         assignee_id   = CASE WHEN $2 THEN NULLIF($3, '')::uuid ELSE assignee_id END,
         assignee_name = CASE WHEN $4 THEN NULLIF(TRIM($5), '') ELSE assignee_name END,
         due_date      = CASE WHEN $6 THEN NULLIF($7, '')::date ELSE due_date END,
         done          = COALESCE($8, done),
         done_at       = CASE WHEN $8 IS TRUE AND done = false THEN NOW() WHEN $8 IS FALSE THEN NULL ELSE done_at END,
         done_by       = CASE WHEN $8 IS TRUE AND done = false THEN $9::uuid WHEN $8 IS FALSE THEN NULL ELSE done_by END,
         reminded_on   = CASE WHEN $6 THEN NULL ELSE reminded_on END
       WHERE id = $10 RETURNING id`,
      [
        b.title ?? null,
        "assignee_id" in b, b.assignee_id ?? "",
        "assignee_name" in b, b.assignee_name ?? "",
        "due_date" in b, b.due_date ?? "",
        typeof b.done === "boolean" ? b.done : null,
        req.auth!.userId,
        req.params.taskId,
      ]
    );
    if (!row) return res.status(404).json({ error: "Tarefa não encontrada" });
    return res.json(await queryOne(`${TASK_SELECT} WHERE t.id = $1`, [row.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// DELETE /api/events/tasks/:taskId
router.delete("/tasks/:taskId", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM event_tasks WHERE id = $1", [req.params.taskId]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Tarefa inválida" });
  }
});

export default router;
