import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { EVENT_MEDIA_PLAN, MEDIA_TYPES } from "../services/media";
import { notifyUsers } from "../services/notify";
import { TZ } from "../services/reminders";

const router = Router();
const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");
const STATUSES = ["todo", "doing", "review", "done"];

const SELECT = `
  SELECT d.*, u.full_name AS assignee_full_name, e.title AS event_title, e.starts_at AS event_starts_at,
         c.full_name AS created_by_name
    FROM media_demands d
    LEFT JOIN users u ON u.id = d.assignee_id
    LEFT JOIN events e ON e.id = d.event_id
    LEFT JOIN users c ON c.id = d.created_by`;

/** Avisa o responsável (individual) quando recebe uma demanda nova */
async function notifyAssignee(id: string) {
  const d = await queryOne<any>(`${SELECT} WHERE d.id = $1`, [id]);
  if (!d?.assignee_id || d.is_group) return;
  const due = new Date(d.due_at).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const text = [
    `🎬 Nova demanda da mídia para você: *${d.title}*`,
    `Tipo: ${MEDIA_TYPES[d.type]} · Prazo: ${due}`,
    d.event_title ? `Evento: ${d.event_title}` : "",
    d.briefing ? `\n${d.briefing}` : "",
    d.links ? `\n📎 ${d.links}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await notifyUsers([d.assignee_id], text);
}

function parse(b: any, partial: boolean): { error?: string } {
  if (!partial || "title" in b) if (!String(b.title || "").trim()) return { error: "Informe o título" };
  if (b.type !== undefined && !(b.type in MEDIA_TYPES)) return { error: "Tipo inválido" };
  if (b.status !== undefined && !STATUSES.includes(b.status)) return { error: "Status inválido" };
  if (!partial || "due_at" in b) if (isNaN(new Date(b.due_at).getTime())) return { error: "Informe o prazo" };
  return {};
}

// GET /api/media?from=&to=
router.get("/", requireReader, async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  try {
    return res.json(
      await query(
        `${SELECT} WHERE ($1::timestamptz IS NULL OR d.due_at >= $1) AND ($2::timestamptz IS NULL OR d.due_at <= $2)
          ORDER BY d.due_at`,
        [from || null, to || null]
      )
    );
  } catch (error) {
    return res.status(400).json({ error: "Parâmetros inválidos" });
  }
});

// POST /api/media
router.post("/", requireEditor, async (req: Request, res: Response) => {
  const b = req.body;
  const p = parse(b, false);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO media_demands (title, type, event_id, is_group, assignee_id, assignee_name, due_at, status, briefing, links, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        String(b.title).trim(), b.type || "outro", b.event_id || null, !!b.is_group,
        b.is_group ? null : b.assignee_id || null, b.is_group ? null : b.assignee_name?.trim() || null,
        b.due_at, b.status || "todo", b.briefing?.trim() || null, b.links?.trim() || null, req.auth!.userId,
      ]
    );
    notifyAssignee(row!.id).catch(() => {});
    return res.status(201).json(await queryOne(`${SELECT} WHERE d.id = $1`, [row!.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/media/from-event/:eventId  (gera o pacote padrão de demandas do evento)
router.post("/from-event/:eventId", requireEditor, async (req: Request, res: Response) => {
  try {
    const ev = await queryOne<{ id: string; title: string; starts_at: Date }>("SELECT id, title, starts_at FROM events WHERE id = $1", [req.params.eventId]);
    if (!ev) return res.status(404).json({ error: "Evento não encontrado" });
    for (const item of EVENT_MEDIA_PLAN) {
      await query(
        `INSERT INTO media_demands (title, type, event_id, is_group, due_at, created_by)
         VALUES ($1, $2, $3, true, $4, $5)`,
        [`${item.title} — ${ev.title}`, item.type, ev.id, new Date(new Date(ev.starts_at).getTime() + item.hours * 3600_000), req.auth!.userId]
      );
    }
    return res.json(await query(`${SELECT} WHERE d.event_id = $1 ORDER BY d.due_at`, [ev.id]));
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// PATCH /api/media/:id
router.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  const b = req.body;
  const p = parse(b, true);
  if (p.error) return res.status(400).json({ error: p.error });
  const has = (k: string) => k in b;
  try {
    const before = await queryOne<{ assignee_id: string | null }>("SELECT assignee_id FROM media_demands WHERE id = $1", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Demanda não encontrada" });
    await query(
      `UPDATE media_demands SET
         title         = COALESCE(NULLIF(TRIM($1), ''), title),
         type          = COALESCE($2, type),
         event_id      = CASE WHEN $3 THEN NULLIF($4, '')::uuid ELSE event_id END,
         is_group      = COALESCE($5, is_group),
         assignee_id   = CASE WHEN $6 THEN NULLIF($7, '')::uuid ELSE assignee_id END,
         assignee_name = CASE WHEN $8 THEN NULLIF(TRIM($9), '') ELSE assignee_name END,
         due_at        = COALESCE($10, due_at),
         status        = COALESCE($11, status),
         briefing      = CASE WHEN $12 THEN NULLIF(TRIM($13), '') ELSE briefing END,
         links         = CASE WHEN $14 THEN NULLIF(TRIM($15), '') ELSE links END,
         reminded_on   = CASE WHEN $10::timestamptz IS NOT NULL THEN NULL ELSE reminded_on END
       WHERE id = $16`,
      [
        b.title ?? null, b.type ?? null,
        has("event_id"), b.event_id ?? "",
        typeof b.is_group === "boolean" ? b.is_group : null,
        has("assignee_id"), b.assignee_id ?? "",
        has("assignee_name"), b.assignee_name ?? "",
        b.due_at ?? null, b.status ?? null,
        has("briefing"), b.briefing ?? "",
        has("links"), b.links ?? "",
        req.params.id,
      ]
    );
    const after = await queryOne<any>(`${SELECT} WHERE d.id = $1`, [req.params.id]);
    if (after.assignee_id && after.assignee_id !== before.assignee_id) notifyAssignee(after.id).catch(() => {});
    return res.json(after);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// DELETE /api/media/:id
router.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM media_demands WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Demanda inválida" });
  }
});

export default router;
